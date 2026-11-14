"""Minimal security log: what was attempted, from where, how often — and whether to worry.

Kinds:
  login_ok          successful login (lets you spot a stolen password: unknown IP / odd time)
  login_failed      wrong username or password
  login_throttled   login refused because of too many failures (brute force)
  unauthorized      request to a protected URL without a valid session (direct access attempt)
  forbidden         logged-in non-admin tried an admin-only endpoint
  bad_origin        state-changing request from another website (CSRF attempt)
  user_created / user_deleted / password_reset   admin actions on app users (for the audit trail)
"""
import logging

from .db import get_conn, rows, transaction

log = logging.getLogger("edunest.security")

SUSPICIOUS = ("login_failed", "login_throttled", "unauthorized", "forbidden", "bad_origin")

# Alert when, in the last 24 hours, any of these totals is reached.
ALERT_THRESHOLDS = {"login_failed": 10, "login_throttled": 1, "unauthorized": 30, "forbidden": 5, "bad_origin": 3}


def record(kind: str, ip: str | None, username: str | None = None, path: str | None = None) -> None:
    ip = (ip or "?")[:64]
    username = (username or "")[:64] or None
    path = (path or "")[:200] or None
    level = logging.WARNING if kind in SUSPICIOUS else logging.INFO
    log.log(level, "%s ip=%s user=%s path=%s", kind, ip, username or "-", path or "-")
    try:
        with transaction() as c:
            cur = c.execute(
                """UPDATE security_event SET count = count + 1, at = datetime('now'), path = COALESCE(?, path)
                   WHERE id = (SELECT id FROM security_event
                               WHERE kind = ? AND ip = ? AND COALESCE(username, '') = COALESCE(?, '')
                                 AND at > datetime('now', '-60 seconds')
                               ORDER BY id DESC LIMIT 1)""",
                (path, kind, ip, username))
            if cur.rowcount == 0:
                c.execute("INSERT INTO security_event (kind, ip, username, path) VALUES (?,?,?,?)",
                          (kind, ip, username, path))
    except Exception:  # noqa: BLE001 — logging must never break a request
        log.exception("could not record security event")


def prune() -> None:
    with transaction() as c:
        c.execute("DELETE FROM security_event WHERE at < datetime('now', '-90 days')")
        c.execute("DELETE FROM security_event WHERE id NOT IN (SELECT id FROM security_event ORDER BY id DESC LIMIT 20000)")


def summary() -> dict:
    conn = get_conn()
    totals_24h = {r["kind"]: r["n"] for r in conn.execute(
        "SELECT kind, SUM(count) AS n FROM security_event WHERE at > datetime('now','-1 day') GROUP BY kind")}
    totals_7d = {r["kind"]: r["n"] for r in conn.execute(
        "SELECT kind, SUM(count) AS n FROM security_event WHERE at > datetime('now','-7 days') GROUP BY kind")}
    top_ips = rows(conn.execute(
        f"""SELECT ip, SUM(count) AS n, MAX(at) AS last_at FROM security_event
            WHERE at > datetime('now','-7 days') AND kind IN ({','.join('?' * len(SUSPICIOUS))})
            GROUP BY ip ORDER BY n DESC LIMIT 5""", SUSPICIOUS))
    reasons = [f"{totals_24h[k]} × {k.replace('_', ' ')} in the last 24 h"
               for k, limit in ALERT_THRESHOLDS.items() if totals_24h.get(k, 0) >= limit]
    return {"alert": bool(reasons), "reasons": reasons, "last_24h": totals_24h, "last_7d": totals_7d,
            "top_ips": top_ips}


def recent(limit: int = 100) -> list[dict]:
    return rows(get_conn().execute(
        "SELECT id, first_at, at, kind, ip, username, path, count FROM security_event ORDER BY at DESC, id DESC LIMIT ?",
        (min(max(limit, 1), 500),)))
