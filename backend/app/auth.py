"""Authentication: users from the environment, scrypt password hashes, server-side sessions.

Design rules (no backdoors):
  * Users exist ONLY in EDUNEST_USERS / EDUNEST_USERS_FILE. There is no sign-up, no default
    account and no setting that turns authentication off. With no users configured, nobody can
    log in and every protected endpoint answers 401.
  * Everything under /api is denied by default (see main.py middleware); only the login,
    logout, "who am I" and health endpoints are reachable without a session.
  * Session tokens are 256-bit random values; only their SHA-256 is stored, so a copy of the
    database does not contain usable sessions.
  * A session is bound to a fingerprint of the user's password hash: changing a user's password
    or removing the user in docker-compose (and restarting) invalidates their sessions at once.
"""
import base64
import hashlib
import hmac
import logging
import os
import re
import secrets
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from .config import DATA_DIR
from .db import get_conn, row, transaction

log = logging.getLogger("edunest.auth")

SESSION_COOKIE = "edunest_session"
SESSION_DAYS = float(os.environ.get("EDUNEST_SESSION_DAYS", "30") or 30)
COOKIE_SECURE = os.environ.get("EDUNEST_COOKIE_SECURE", "auto").lower()  # auto | true | false
MIN_PASSWORD_LEN = 8
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{1,64}$")
# Passwords published in this repository's examples — refused, so nobody can log in with them.
PUBLISHED_PASSWORDS = {"change-me-to-a-long-password", "devpassword", "password", "changeme", "admin123"}

# scrypt parameters: N=2^15, r=8, p=1  (~32 MiB, ~50-100 ms per check)
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**15, 8, 1
SCRYPT_MAXMEM = 64 * 1024 * 1024


class AuthConfigError(RuntimeError):
    pass


# ---------------------------------------------------------------- password hashing

def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _server_key() -> bytes:
    """Random key created once in /data. Used to derive stable salts for plain-text compose passwords,
    so their hash (and therefore existing logins) survives container restarts."""
    path = DATA_DIR / "secret.key"
    try:
        key = path.read_bytes()
        if len(key) >= 32:
            return key
    except FileNotFoundError:
        pass
    key = secrets.token_bytes(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(key)
    return key


def hash_password(password: str, salt: bytes | None = None) -> str:
    """Returns 'scrypt:N:r:p:salt:hash' (no '$' characters, so it can be pasted into docker-compose)."""
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
                        maxmem=SCRYPT_MAXMEM, dklen=32)
    return f"scrypt:{SCRYPT_N}:{SCRYPT_R}:{SCRYPT_P}:{_b64(salt)}:{_b64(dk)}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, n, r, p, salt, expected = encoded.split(":")
        if algo != "scrypt":
            return False
        dk = hashlib.scrypt(password.encode(), salt=_unb64(salt), n=int(n), r=int(r), p=int(p),
                            maxmem=SCRYPT_MAXMEM, dklen=len(_unb64(expected)))
        return hmac.compare_digest(dk, _unb64(expected))
    except Exception:  # noqa: BLE001 — malformed hash never verifies
        return False


# Used to spend the same time on unknown usernames as on real ones (no user enumeration by timing).
_DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


# ---------------------------------------------------------------- users

@dataclass(frozen=True)
class User:
    username: str
    password_hash: str
    is_admin: bool
    source: str = "compose"  # compose = EDUNEST_USERS (can be admin) | app = added by an admin in Settings

    @property
    def fingerprint(self) -> str:
        return hashlib.sha256(self.password_hash.encode()).hexdigest()[:32]


_env_users: dict[str, User] = {}   # from docker-compose (fixed until restart)
_users: dict[str, User] = {}       # env users + users added in Settings (replaced atomically)
_users_lock = threading.Lock()


def load_users() -> dict[str, User]:
    """Parses EDUNEST_USERS ("alice:pass,bob:scrypt:...") and/or EDUNEST_USERS_FILE (one per line).
    Plain-text passwords are hashed in memory immediately. Raises AuthConfigError on bad config."""
    entries: list[str] = []
    raw = os.environ.get("EDUNEST_USERS", "")
    entries += [e for e in raw.split(",") if e.strip()]
    users_file = os.environ.get("EDUNEST_USERS_FILE")
    if users_file:
        try:
            entries += [ln for ln in Path(users_file).read_text().splitlines()
                        if ln.strip() and not ln.lstrip().startswith("#")]
        except OSError as e:
            raise AuthConfigError(f"cannot read EDUNEST_USERS_FILE={users_file}: {e}") from e

    admins_raw = os.environ.get("EDUNEST_ADMINS", "").strip()
    admins = {a.strip() for a in admins_raw.split(",") if a.strip()}

    users: dict[str, User] = {}
    for entry in entries:
        entry = entry.strip()
        if ":" not in entry:
            raise AuthConfigError("each user must be written as username:password")
        name, secret = entry.split(":", 1)
        name = name.strip()
        if not USERNAME_RE.match(name):
            raise AuthConfigError(f"invalid username {name!r} (allowed: letters, digits, _ . @ -, max 64)")
        if name in users:
            raise AuthConfigError(f"user {name!r} is defined twice")
        if secret.startswith("scrypt:"):
            if secret.count(":") != 5:
                raise AuthConfigError(f"malformed password hash for user {name!r}")
            pw_hash = secret
        else:
            if secret.lower() in PUBLISHED_PASSWORDS:
                raise AuthConfigError(f"user {name!r} still uses the example password — choose your own in EDUNEST_USERS")
            if len(secret) < MIN_PASSWORD_LEN:
                raise AuthConfigError(f"password for user {name!r} is shorter than {MIN_PASSWORD_LEN} characters")
            salt = hmac.new(_server_key(), b"user-salt:" + name.encode(), hashlib.sha256).digest()[:16]
            pw_hash = hash_password(secret, salt)
        users[name] = User(name, pw_hash, is_admin=(not admins) or name in admins)

    unknown_admins = admins - users.keys()
    if unknown_admins:
        raise AuthConfigError(f"EDUNEST_ADMINS lists unknown users: {', '.join(sorted(unknown_admins))}")
    return users


def _refresh_users() -> None:
    """Merge compose users with app users from the DB. Compose users win on a name clash, and
    app users are never admins."""
    global _users
    merged = dict(_env_users)
    for r in get_conn().execute("SELECT username, password_hash FROM app_user ORDER BY created_at, username"):
        if r["username"] not in merged:
            merged[r["username"]] = User(r["username"], r["password_hash"], is_admin=False, source="app")
    _users = merged


def init_users() -> None:
    global _env_users
    _env_users = load_users()
    _refresh_users()
    if not _users:
        log.warning("No users configured (EDUNEST_USERS). Nobody can log in until you add some.")
    else:
        log.info("auth: %d user(s) configured, admins: %s", len(_users),
                 ", ".join(u.username for u in _users.values() if u.is_admin))


def users_configured() -> bool:
    return bool(_users)


def all_users() -> list[User]:
    return list(_users.values())  # in the order they appear in EDUNEST_USERS


def first_admin() -> str | None:
    return next((u.username for u in _users.values() if u.is_admin), None)


def get_user(username: str) -> User | None:
    return _users.get(username)


def password_problem(password: str) -> str | None:
    if len(password) < MIN_PASSWORD_LEN:
        return f"Password must be at least {MIN_PASSWORD_LEN} characters"
    if len(password) > 1024:
        return "Password is too long"
    if password.lower() in PUBLISHED_PASSWORDS:
        return "This password is too well known — choose another"
    return None


def create_app_user(username: str, password: str, created_by: str) -> User:
    if not USERNAME_RE.match(username):
        raise ValueError("Username may contain letters, digits and _ . @ - (max 64)")
    problem = password_problem(password)
    if problem:
        raise ValueError(problem)
    with _users_lock:
        if username in _users:
            raise ValueError("A user with this name already exists")
        with transaction() as c:
            c.execute("INSERT INTO app_user (username, password_hash, created_by) VALUES (?,?,?)",
                      (username, hash_password(password), created_by))
            # Fresh account: no course access until an admin grants it; no leftover data.
            for t in ("user_access", "user_course", "progress", "note", "session"):
                c.execute(f"DELETE FROM {t} WHERE username=?", (username,))
        _refresh_users()
    return _users[username]


def set_app_user_password(username: str, password: str) -> None:
    problem = password_problem(password)
    if problem:
        raise ValueError(problem)
    with _users_lock:
        u = _users.get(username)
        if not u or u.source != "app":
            raise LookupError("Only users added in Settings can be changed here")
        with transaction() as c:
            c.execute("UPDATE app_user SET password_hash=? WHERE username=?", (hash_password(password), username))
            c.execute("DELETE FROM session WHERE username=?", (username,))  # sign out everywhere
        _refresh_users()


def delete_app_user(username: str) -> None:
    with _users_lock:
        u = _users.get(username)
        if not u or u.source != "app":
            raise LookupError("Only users added in Settings can be deleted here")
        with transaction() as c:
            c.execute("DELETE FROM app_user WHERE username=?", (username,))
            for t in ("session", "user_access", "user_course", "progress", "note", "continue_hidden"):
                c.execute(f"DELETE FROM {t} WHERE username=?", (username,))
        _refresh_users()


# ---------------------------------------------------------------- brute-force protection

class _Throttle:
    """Exponential back-off after repeated failures, tracked per key:
      ip:<addr>            5 free attempts — one attacker is slowed down almost immediately
      user:<name>|<addr>   5 free attempts — guessing one account from one address
      user:<name>         20 free attempts — distributed guessing of one account; set higher so
                                              a single attacker can't easily lock the real user out
    """

    MAX_DELAY_S = 15 * 60

    @staticmethod
    def _free(key: str) -> int:
        return 20 if key.startswith("user:") and "|" not in key else 5

    def __init__(self):
        self._lock = threading.Lock()
        self._fails: dict[str, tuple[int, float]] = {}  # key -> (failures, blocked_until)

    def retry_after(self, *keys: str) -> float:
        now = time.monotonic()
        with self._lock:
            return max((self._fails.get(k, (0, 0.0))[1] - now for k in keys), default=0.0)

    def failure(self, *keys: str) -> None:
        now = time.monotonic()
        with self._lock:
            for k in keys:
                n, _ = self._fails.get(k, (0, 0.0))
                n += 1
                free = self._free(k)
                delay = 0.0 if n < free else min(self.MAX_DELAY_S, 2 ** (n - free + 1))
                self._fails[k] = (n, now + delay)
            if len(self._fails) > 50_000:  # bound memory
                self._fails = {k: v for k, v in self._fails.items() if v[1] > now}

    def success(self, *keys: str) -> None:
        with self._lock:
            for k in keys:
                self._fails.pop(k, None)


throttle = _Throttle()


# ---------------------------------------------------------------- sessions

def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def authenticate(username: str, password: str) -> User | None:
    user = _users.get(username)
    ok = verify_password(password, user.password_hash if user else _DUMMY_HASH)
    return user if (user and ok) else None


def create_session(user: User, ip: str | None, user_agent: str | None) -> str:
    token = secrets.token_urlsafe(32)
    with transaction() as c:
        c.execute(
            """INSERT INTO session (token_hash, username, user_fp, expires_at, ip, user_agent)
               VALUES (?, ?, ?, datetime('now', ?), ?, ?)""",
            (_token_hash(token), user.username, user.fingerprint, f"+{SESSION_DAYS * 86400:.0f} seconds",
             (ip or "")[:64], (user_agent or "")[:256]))
        c.execute("DELETE FROM session WHERE expires_at < datetime('now')")
    return token


def session_user(token: str | None) -> User | None:
    if not token or len(token) > 128:
        return None
    s = row(get_conn().execute(
        "SELECT username, user_fp FROM session WHERE token_hash=? AND expires_at > datetime('now')",
        (_token_hash(token),)))
    if not s:
        return None
    user = _users.get(s["username"])
    if not user or not hmac.compare_digest(user.fingerprint, s["user_fp"]):
        return None  # user removed or password changed since login
    return user


def delete_session(token: str | None) -> None:
    if token:
        with transaction() as c:
            c.execute("DELETE FROM session WHERE token_hash=?", (_token_hash(token),))


def purge_stale_sessions() -> None:
    """On startup: drop sessions of users that no longer exist or whose password changed."""
    with transaction() as c:
        for s in c.execute("SELECT token_hash, username, user_fp FROM session").fetchall():
            u = _users.get(s["username"])
            if not u or u.fingerprint != s["user_fp"]:
                c.execute("DELETE FROM session WHERE token_hash=?", (s["token_hash"],))
        c.execute("DELETE FROM session WHERE expires_at < datetime('now')")


def cookie_secure(scheme: str) -> bool:
    if COOKIE_SECURE in ("1", "true", "yes"):
        return True
    if COOKIE_SECURE in ("0", "false", "no"):
        return False
    return scheme == "https"


# ---------------------------------------------------------------- CLI: python -m app.auth

if __name__ == "__main__":
    import getpass
    import sys

    pw = sys.argv[1] if len(sys.argv) > 1 else getpass.getpass("Password: ")
    if len(sys.argv) <= 1 and getpass.getpass("Repeat password: ") != pw:
        sys.exit("Passwords do not match")
    if len(pw) < MIN_PASSWORD_LEN:
        sys.exit(f"Password must be at least {MIN_PASSWORD_LEN} characters")
    print(hash_password(pw))
