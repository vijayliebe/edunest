import logging
import re
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response
from fastapi.routing import APIRoute
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import access, auth, media, scanner, security
from .config import (BROWSE_ROOT, BROWSE_START, COMPLETE_RATIO, DATA_DIR, SCAN_INTERVAL_MIN, SCAN_ON_STARTUP, SEED_LIBRARIES, STATIC_DIR,
                     SUBTITLE_EXTS, THUMBS_DIR)
from .db import get_conn, migrate, row, rows, seed_libraries, transaction

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("edunest")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    migrate()
    auth.init_users()          # raises (container exits) on a malformed EDUNEST_USERS
    auth.purge_stale_sessions()
    access.assign_legacy_data()  # progress/notes from before per-user data → first admin
    security.prune()
    seed_libraries([{"path": p, "name": Path(p).name} for p in SEED_LIBRARIES] or mounted_folders())
    log.info("libraries=%s  ffprobe=%s  ffmpeg=%s", [l["path"] for l in scanner.enabled_libraries()],
             bool(media.FFPROBE), bool(media.FFMPEG))
    if SCAN_ON_STARTUP:
        scanner.scan_in_background()
    if SCAN_INTERVAL_MIN > 0:
        threading.Thread(target=_periodic_scan, daemon=True, name="periodic-scan").start()
    yield


def _periodic_scan() -> None:
    while True:
        time.sleep(SCAN_INTERVAL_MIN * 60)
        try:
            scanner.scan()
        except Exception:  # noqa: BLE001
            log.exception("periodic scan failed")


# No interactive API docs: they would only advertise the API surface.
app = FastAPI(title="EduNest", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

MIME = {".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
        ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".wmv": "video/x-ms-wmv",
        ".flv": "video/x-flv", ".ts": "video/mp2t"}
THUMB_CACHE = {"Cache-Control": "private, max-age=604800"}  # private: never stored by shared proxies/CDNs


# ---------------------------------------------------------------- access control (deny by default)

# The ONLY /api endpoints reachable without a session. Everything else under /api — including any
# endpoint added in the future — requires a valid login. There is no other way in.
PUBLIC_API = {("POST", "/api/auth/login"), ("POST", "/api/auth/logout"), ("GET", "/api/auth/me"),
              ("GET", "/api/health")}
ADMIN_PREFIXES = ("/api/libraries", "/api/fs/", "/api/library/rescan", "/api/security", "/api/users",
                  "/api/admin/")
STATE_CHANGING = {"POST", "PUT", "PATCH", "DELETE"}

CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "
       "media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; "
       "form-action 'self'; frame-ancestors 'none'")


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def _same_origin(request: Request) -> bool:
    if request.headers.get("sec-fetch-site") == "cross-site":
        return False
    origin = request.headers.get("origin")
    if not origin or origin == "null":
        return origin is None
    netloc = origin.split("://", 1)[-1].rstrip("/").lower()
    hosts = {h.strip().lower() for h in (request.headers.get("host", ""),
                                          request.headers.get("x-forwarded-host", "")) for h in h.split(",") if h.strip()}
    return netloc in hosts


def _deny(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status, headers={"Cache-Control": "no-store"})


@app.middleware("http")
async def access_guard(request: Request, call_next):
    path, method = request.url.path, request.method
    is_api = path == "/api" or path.startswith("/api/")

    if method in STATE_CHANGING and not _same_origin(request):
        security.record("bad_origin", client_ip(request), path=path)
        return _deny(403, "Cross-site request blocked")

    if is_api:
        key = ("GET" if method == "HEAD" else method, path)
        if key not in PUBLIC_API:
            user = auth.session_user(request.cookies.get(auth.SESSION_COOKIE))
            if user is None:
                security.record("unauthorized", client_ip(request), path=path)
                return _deny(401, "Login required")
            if path.startswith(ADMIN_PREFIXES) and not user.is_admin:
                security.record("forbidden", client_ip(request), user.username, path)
                return _deny(403, "Admins only")
            request.state.user = user
    elif method not in ("GET", "HEAD"):
        return _deny(405, "Method not allowed")

    response = await call_next(request)
    h = response.headers
    h.setdefault("X-Content-Type-Options", "nosniff")
    h.setdefault("X-Frame-Options", "DENY")
    h.setdefault("Referrer-Policy", "same-origin")
    h.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    h.setdefault("Content-Security-Policy", CSP)
    if request.url.scheme == "https":
        h.setdefault("Strict-Transport-Security", "max-age=31536000")
    if is_api:
        h.setdefault("Cache-Control", "private, no-store")
    return response


# ---------------------------------------------------------------- auth endpoints

class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)


def _me(user: auth.User) -> dict:
    return {"username": user.username, "is_admin": user.is_admin}


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request):
    ip = client_ip(request)
    uname = body.username.lower()
    keys = (f"ip:{ip}", f"user:{uname}|{ip}", f"user:{uname}")
    wait = auth.throttle.retry_after(*keys)
    if wait > 0:
        security.record("login_throttled", ip, body.username)
        return JSONResponse({"detail": f"Too many failed attempts. Try again in {int(wait) + 1} seconds."},
                            status_code=429, headers={"Retry-After": str(int(wait) + 1), "Cache-Control": "no-store"})
    user = auth.authenticate(body.username, body.password)
    if user is None:
        auth.throttle.failure(*keys)
        security.record("login_failed", ip, body.username)
        return _deny(401, "Wrong username or password")
    auth.throttle.success(*keys)
    token = auth.create_session(user, ip, request.headers.get("user-agent"))
    security.record("login_ok", ip, user.username)
    resp = JSONResponse(_me(user), headers={"Cache-Control": "no-store"})
    resp.set_cookie(auth.SESSION_COOKIE, token, max_age=int(auth.SESSION_DAYS * 86400), path="/",
                    httponly=True, samesite="lax", secure=auth.cookie_secure(request.url.scheme))
    return resp


@app.post("/api/auth/logout")
def logout(request: Request):
    auth.delete_session(request.cookies.get(auth.SESSION_COOKIE))
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(auth.SESSION_COOKIE, path="/")
    return resp


@app.get("/api/auth/me")
def me(request: Request):
    user = auth.session_user(request.cookies.get(auth.SESSION_COOKIE))
    if user is None:
        return JSONResponse({"detail": "Login required", "users_configured": auth.users_configured()},
                            status_code=401, headers={"Cache-Control": "no-store"})
    return _me(user)


# ---------------------------------------------------------------- security log (admins)

@app.get("/api/security/summary")
def security_summary():
    return security.summary()


@app.get("/api/security/events")
def security_events(limit: int = 100):
    return security.recent(limit)


@app.delete("/api/security/events", status_code=204)
def security_clear():
    with transaction() as c:
        c.execute("DELETE FROM security_event")
    return Response(status_code=204)


# ---------------------------------------------------------------- helpers

def media_path(path: str) -> Path:
    p = Path(path)
    if not p.is_file() or not scanner.is_inside_library(p):
        raise HTTPException(404, "file not found")
    return p


def ordered_lessons(course_id: int, username: str) -> list[dict]:
    """Lessons of a course in curriculum order, with THIS user's progress and note counts."""
    return rows(get_conn().execute(
        """SELECT l.id, l.title, l.section_id, l.duration_s, l.playable, l.fingerprint,
                  s.title AS section_title,
                  COALESCE(p.completed, 0) AS completed, COALESCE(p.position_s, 0) AS position_s,
                  (SELECT COUNT(*) FROM note n WHERE n.lesson_id = l.id AND n.username = ?) AS notes_count
           FROM lesson l
           LEFT JOIN section s ON s.id = l.section_id
           LEFT JOIN progress p ON p.lesson_id = l.id AND p.username = ?
           WHERE l.course_id = ? AND l.missing = 0
           ORDER BY (l.section_id IS NOT NULL), s.sort_key, l.sort_key""", (username, username, course_id)))


def thumb_url(lesson: dict) -> str:
    return f"/api/thumbs/lesson/{lesson['id']}?v={lesson['fingerprint'][:8]}"


def fmt_ts(sec: float) -> str:
    sec = int(sec)
    h, m, s = sec // 3600, sec % 3600 // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def subtitle_files(video: Path) -> list[Path]:
    prefix = video.stem + "."
    try:
        return sorted(p for p in video.parent.iterdir()
                      if p.name.startswith(prefix) and p.suffix.lower() in SUBTITLE_EXTS)
    except OSError:
        return []


# ---------------------------------------------------------------- library

@app.get("/api/health")
def health():
    return {"ok": True}  # public (used by the Docker healthcheck), so it reveals nothing else


@app.get("/api/library/status")
def library_status(request: Request):
    if access.current_user(request).is_admin:
        return scanner.status
    # non-admins only need the progress indicator, not folder paths or errors
    return {k: scanner.status[k] for k in ("running", "processed", "total", "started_at", "finished_at")}


class LibraryIn(BaseModel):
    path: str = Field(min_length=1)
    name: str | None = None
    mode: str = Field(default="auto", pattern="^(auto|collection|course)$")


class LibraryPatch(BaseModel):
    name: str | None = None
    mode: str | None = Field(default=None, pattern="^(collection|course)$")
    enabled: bool | None = None


def _library_list() -> list[dict]:
    libs = rows(get_conn().execute(
        """SELECT lb.id, lb.path, lb.name, lb.mode, lb.enabled,
                  (SELECT COUNT(*) FROM course c WHERE c.library_id = lb.id AND c.missing = 0) AS course_count
           FROM library lb ORDER BY lb.id"""))
    for lb in libs:
        lb["exists"] = Path(lb["path"]).is_dir()
        lb["enabled"] = bool(lb["enabled"])
    return libs


@app.get("/api/libraries")
def list_libraries():
    return _library_list()


@app.post("/api/libraries", status_code=201)
def add_library(body: LibraryIn):
    p = Path(body.path.strip()).expanduser().resolve()
    if not p.is_dir():
        raise HTTPException(400, f"Folder not found inside the container: {p}")
    with transaction() as c:
        for (other,) in c.execute("SELECT path FROM library"):
            o = Path(other)
            if o == p:
                raise HTTPException(409, "This folder is already a library")
            if o in p.parents or p in o.parents:
                raise HTTPException(409, f"Overlaps with existing library {o}. Libraries can't be nested: remove {o} first, or keep it and set it to 'Folder of courses'.")
        c.execute("INSERT INTO library (path, name, mode) VALUES (?,?,?)",
                  (str(p), (body.name or "").strip() or p.name or str(p),
                   scanner.guess_mode(p) if body.mode == "auto" else body.mode))
    scanner.scan_in_background()
    return _library_list()


@app.patch("/api/libraries/{lib_id}")
def update_library(lib_id: int, body: LibraryPatch):
    fields = body.model_dump(exclude_none=True)
    if "enabled" in fields:
        fields["enabled"] = int(fields["enabled"])
    with transaction() as c:
        if fields:
            c.execute(f"UPDATE library SET {', '.join(f'{k}=?' for k in fields)} WHERE id=?",
                      (*fields.values(), lib_id))
    scanner.scan_in_background()
    return _library_list()


@app.delete("/api/libraries/{lib_id}")
def delete_library(lib_id: int):
    """Removes the folder from the library. Notes/progress are kept (lessons are only marked missing),
    so re-adding the folder later brings everything back."""
    with transaction() as c:
        c.execute("DELETE FROM library WHERE id=?", (lib_id,))
    scanner.scan_in_background()
    return _library_list()


_SYSTEM_FS = {"proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup", "cgroup2", "overlay", "securityfs",
              "debugfs", "pstore", "bpf", "tracefs", "hugetlbfs", "configfs", "fusectl", "nsfs", "shm"}
_SYSTEM_PREFIXES = ("/proc", "/sys", "/dev", "/etc", "/run", "/usr", "/var", "/app", "/tmp")


def _unescape_mount(p: str) -> str:
    # /proc/self/mountinfo escapes space, tab, newline and backslash as octal (\040 etc.)
    return re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), p)


def mounted_folders() -> list[dict]:
    """Folders bind-mounted into the container (i.e. your NAS shares), read from /proc/self/mountinfo.
    `name` is the last part of the folder's path on the NAS (e.g. /volume1/metube/downloads → downloads)."""
    out: dict[str, str] = {}
    try:
        lines = Path("/proc/self/mountinfo").read_text().splitlines()
    except OSError:
        return []
    for line in lines:
        left, _, right = line.partition(" - ")
        fields = left.split()
        if len(fields) < 5 or not right:
            continue
        mount_point = _unescape_mount(fields[4])
        source_root = _unescape_mount(fields[3])
        fstype = right.split()[0]
        p = Path(mount_point)
        if (fstype in _SYSTEM_FS or mount_point == "/" or mount_point.startswith(_SYSTEM_PREFIXES)
                or p == DATA_DIR or DATA_DIR in p.parents or not p.is_dir()):
            continue
        out[mount_point] = Path(source_root).name or p.name or mount_point
    return [{"path": k, "name": out[k]} for k in sorted(out, key=scanner.natural_key)]


@app.get("/api/fs/mounts")
def fs_mounts():
    libs = {lb["path"] for lb in _library_list()}
    return [{**m, "is_library": m["path"] in libs, "suggested_mode": scanner.guess_mode(Path(m["path"]))}
            for m in mounted_folders()]


@app.get("/api/fs/browse")
def browse(path: str | None = None):
    """Lists sub-folders, for the folder picker in Settings."""
    if path:
        p = Path(path).resolve()
    else:
        p = BROWSE_START if BROWSE_START.is_dir() else BROWSE_ROOT
    if p != BROWSE_ROOT and BROWSE_ROOT not in p.parents:
        p = BROWSE_ROOT
    if not p.is_dir():
        raise HTTPException(404, "not a folder")
    try:
        dirs = sorted((d.name for d in p.iterdir() if d.is_dir() and not scanner.is_hidden(d.name)),
                      key=scanner.natural_key)
    except PermissionError:
        dirs = []
    parent = str(p.parent) if p != BROWSE_ROOT else None
    return {"path": str(p), "parent": parent, "dirs": dirs}


@app.post("/api/library/rescan")
def library_rescan(force: bool = False):
    started = scanner.scan_in_background(force=force)
    return {"started": started, **scanner.status}


# ---------------------------------------------------------------- courses
# Every endpoint below is scoped to the logged-in user: progress and notes are theirs only,
# and courses/lessons are limited to what an admin granted (access.py).

@app.get("/api/courses")
def list_courses(request: Request):
    user = access.current_user(request)
    clause, params = access.course_clause(user, "c.id")
    data = rows(get_conn().execute(
        f"""SELECT c.id, c.title, c.channel, c.cover_path IS NOT NULL AS has_cover,
                  COUNT(l.id) AS lesson_count,
                  COALESCE(SUM(l.duration_s), 0) AS total_duration_s,
                  COALESCE(SUM(p.completed), 0) AS completed_count,
                  MAX(p.last_watched_at) AS last_watched_at,
                  (SELECT COUNT(*) FROM note n JOIN lesson l2 ON l2.id = n.lesson_id
                    WHERE l2.course_id = c.id AND n.username = ?) AS notes_count
           FROM course c
           JOIN lesson l ON l.course_id = c.id AND l.missing = 0
           LEFT JOIN progress p ON p.lesson_id = l.id AND p.username = ?
           WHERE c.missing = 0{clause}
           GROUP BY c.id""", (user.username, user.username, *params)))
    for c in data:
        c["thumb_url"] = f"/api/thumbs/course/{c['id']}"
    data.sort(key=lambda c: scanner.natural_key(c["title"]))
    return data


@app.get("/api/courses/{course_id}")
def course_detail(course_id: int, request: Request):
    user = access.require_course(request, course_id)
    course = row(get_conn().execute(
        "SELECT id, title, description, channel, youtube_id FROM course WHERE id=?", (course_id,)))
    if not course:
        raise HTTPException(404, "course not found")
    lessons = ordered_lessons(course_id, user.username)
    sections: list[dict] = []
    for l in lessons:
        l["thumb_url"] = thumb_url(l)
        del l["fingerprint"]
        if not sections or sections[-1]["id"] != l["section_id"]:
            sections.append({"id": l["section_id"], "title": l["section_title"], "lessons": []})
        sections[-1]["lessons"].append(l)
    resume = next((l for l in lessons if not l["completed"]), lessons[0] if lessons else None)
    course.update(
        thumb_url=f"/api/thumbs/course/{course_id}",
        sections=sections,
        lesson_count=len(lessons),
        completed_count=sum(l["completed"] for l in lessons),
        total_duration_s=sum(l["duration_s"] or 0 for l in lessons),
        notes_count=sum(l["notes_count"] for l in lessons),
        resume_lesson_id=resume["id"] if resume else None,
    )
    return course


# ---------------------------------------------------------------- lessons

@app.get("/api/lessons/{lesson_id}")
def lesson_detail(lesson_id: int, request: Request):
    user, l = access.require_lesson(request, lesson_id)
    conn = get_conn()
    course = row(conn.execute("SELECT id, title FROM course WHERE id=?", (l["course_id"],)))
    section = row(conn.execute("SELECT title FROM section WHERE id=?", (l["section_id"],))) if l["section_id"] else None
    chapters = rows(conn.execute(
        "SELECT start_s, end_s, title FROM chapter WHERE lesson_id=? ORDER BY start_s", (lesson_id,)))
    prog = row(conn.execute(
        "SELECT position_s, completed, last_watched_at FROM progress WHERE username=? AND lesson_id=?",
        (user.username, lesson_id)))
    order = ordered_lessons(l["course_id"], user.username)
    idx = next((i for i, x in enumerate(order) if x["id"] == lesson_id), None)

    def brief(x):
        return {"id": x["id"], "title": x["title"]} if x else None

    subs = []
    p = Path(l["path"])
    for i, f in enumerate(subtitle_files(p)):
        label = f.name[len(p.stem) + 1: -len(f.suffix)] or "Subtitles"
        subs.append({"index": i, "label": label, "lang": label.split(".")[0][:8],
                     "url": f"/api/lessons/{lesson_id}/subtitles/{i}"})

    return {
        "id": l["id"], "title": l["title"], "description": l["description"], "channel": l["channel"],
        "upload_date": l["upload_date"], "youtube_id": l["youtube_id"], "duration_s": l["duration_s"],
        "width": l["width"], "height": l["height"], "vcodec": l["vcodec"], "acodec": l["acodec"],
        "playable": l["playable"], "missing": bool(l["missing"]), "meta_source": l["meta_source"],
        "file_name": p.name,
        "stream_url": f"/api/lessons/{lesson_id}/stream",
        "thumb_url": thumb_url(l),
        "course": course, "section_title": section["title"] if section else None,
        "chapters": chapters, "subtitles": subs,
        "progress": prog or {"position_s": 0, "completed": 0, "last_watched_at": None},
        "prev": brief(order[idx - 1]) if idx else None,
        "next": brief(order[idx + 1]) if idx is not None and idx + 1 < len(order) else None,
        "index": (idx or 0) + 1, "total": len(order),
    }


@app.get("/api/lessons/{lesson_id}/stream")
def lesson_stream(lesson_id: int, request: Request):
    _, l = access.require_lesson(request, lesson_id)
    p = media_path(l["path"])
    # Starlette's FileResponse handles HTTP Range requests, so seeking is instant.
    return FileResponse(p, media_type=MIME.get(p.suffix.lower(), "application/octet-stream"),
                        content_disposition_type="inline", headers={"Cache-Control": "private, no-store"})


@app.get("/api/lessons/{lesson_id}/subtitles/{index}")
def lesson_subtitle(lesson_id: int, index: int, request: Request):
    _, l = access.require_lesson(request, lesson_id)
    files = subtitle_files(media_path(l["path"]))
    if not 0 <= index < len(files):
        raise HTTPException(404)
    text = files[index].read_text(encoding="utf-8", errors="replace")
    if files[index].suffix.lower() == ".srt":
        text = media.srt_to_vtt(text)
    return PlainTextResponse(text, media_type="text/vtt")


# ---------------------------------------------------------------- thumbnails

def _lesson_thumb_response(l: dict):
    if l["thumb_path"] and Path(l["thumb_path"]).is_file():
        return FileResponse(l["thumb_path"], headers=THUMB_CACHE)
    cached = THUMBS_DIR / f"l{l['id']}-{l['fingerprint'][:10]}.jpg"
    if not cached.is_file():
        src = media_path(l["path"])
        cover_stream = None
        if l["has_embedded_cover"]:
            cover_stream = media.summarize_probe(media.probe(src)).get("cover_stream")
        if not media.make_thumbnail(src, cached, l["duration_s"], cover_stream):
            raise HTTPException(404, "no thumbnail")
    return FileResponse(cached, media_type="image/jpeg", headers=THUMB_CACHE)


@app.get("/api/thumbs/lesson/{lesson_id}")
def lesson_thumb(lesson_id: int, request: Request):
    _, l = access.require_lesson(request, lesson_id)
    return _lesson_thumb_response(l)


@app.get("/api/thumbs/course/{course_id}")
def course_thumb(course_id: int, request: Request):
    access.require_course(request, course_id)
    c = row(get_conn().execute("SELECT cover_path FROM course WHERE id=?", (course_id,)))
    if not c:
        raise HTTPException(404)
    if c["cover_path"] and Path(c["cover_path"]).is_file():
        return FileResponse(c["cover_path"], headers=THUMB_CACHE)
    first = row(get_conn().execute(
        """SELECT l.* FROM lesson l LEFT JOIN section s ON s.id = l.section_id
           WHERE l.course_id = ? AND l.missing = 0
           ORDER BY (l.section_id IS NOT NULL), s.sort_key, l.sort_key LIMIT 1""", (course_id,)))
    if not first:
        raise HTTPException(404)
    return _lesson_thumb_response(first)


# ---------------------------------------------------------------- progress (per user)

class ProgressIn(BaseModel):
    position_s: float = Field(ge=0)
    completed: bool | None = None


@app.put("/api/progress/{lesson_id}")
def save_progress(lesson_id: int, body: ProgressIn, request: Request):
    user, l = access.require_lesson(request, lesson_id)
    with transaction() as c:
        prev = row(c.execute("SELECT completed FROM progress WHERE username=? AND lesson_id=?",
                             (user.username, lesson_id)))
        if body.completed is not None:
            completed = body.completed
        else:
            reached = bool(l["duration_s"]) and body.position_s >= COMPLETE_RATIO * l["duration_s"]
            completed = bool(prev and prev["completed"]) or reached
        c.execute(
            """INSERT INTO progress (username, lesson_id, position_s, completed, last_watched_at)
               VALUES (?,?,?,?,datetime('now'))
               ON CONFLICT(username, lesson_id) DO UPDATE SET position_s=excluded.position_s,
                 completed=excluded.completed, last_watched_at=excluded.last_watched_at""",
            (user.username, lesson_id, body.position_s, int(completed)))
    return {"lesson_id": lesson_id, "position_s": body.position_s, "completed": completed}


@app.get("/api/continue-watching")
def continue_watching(request: Request, limit: int = 12):
    """Per course: the user's most recent lesson if unfinished, otherwise the next unfinished one."""
    user = access.current_user(request)
    clause, params = access.course_clause(user, "c.id")
    conn = get_conn()
    recent = rows(conn.execute(
        f"""SELECT l.course_id, p.lesson_id, p.position_s, p.completed, p.last_watched_at
           FROM progress p JOIN lesson l ON l.id = p.lesson_id
           JOIN course c ON c.id = l.course_id
           WHERE p.username = ? AND l.missing = 0 AND c.missing = 0{clause}
           AND p.last_watched_at = (SELECT MAX(p2.last_watched_at) FROM progress p2
                                    JOIN lesson l2 ON l2.id = p2.lesson_id
                                    WHERE l2.course_id = l.course_id AND p2.username = p.username)
           ORDER BY p.last_watched_at DESC""", (user.username, *params)))
    out, seen = [], set()
    for r in recent:
        if r["course_id"] in seen:
            continue
        seen.add(r["course_id"])
        order = ordered_lessons(r["course_id"], user.username)
        idx = next((i for i, x in enumerate(order) if x["id"] == r["lesson_id"]), None)
        if idx is None:
            continue
        target = order[idx]
        if r["completed"]:
            target = next((x for x in order[idx + 1:] if not x["completed"]), None)
            if target is None:
                continue
        course = row(conn.execute("SELECT title FROM course WHERE id=?", (r["course_id"],)))
        out.append({
            "lesson_id": target["id"], "title": target["title"], "course_id": r["course_id"],
            "course_title": course["title"], "duration_s": target["duration_s"],
            "position_s": target["position_s"], "thumb_url": thumb_url(target),
            "last_watched_at": r["last_watched_at"],
        })
        if len(out) >= limit:
            break
    return out


# ---------------------------------------------------------------- notes (per user)

class NoteIn(BaseModel):
    timestamp_s: float = Field(ge=0)
    body_md: str = Field(min_length=1, max_length=50_000)


class NotePatch(BaseModel):
    timestamp_s: float | None = Field(default=None, ge=0)
    body_md: str | None = Field(default=None, min_length=1, max_length=50_000)


NOTE_COLS = "n.id, n.lesson_id, n.timestamp_s, n.body_md, n.created_at, n.updated_at"


def _own_note(request: Request, note_id: int) -> auth.User:
    """The note must belong to the user AND sit in a course they can still see; else 404."""
    user = access.current_user(request)
    n = row(get_conn().execute("SELECT username, lesson_id FROM note WHERE id=?", (note_id,)))
    if not n or n["username"] != user.username:
        raise HTTPException(404, "note not found")
    access.require_lesson(request, n["lesson_id"])
    return user


@app.get("/api/lessons/{lesson_id}/notes")
def lesson_notes(lesson_id: int, request: Request):
    user, _ = access.require_lesson(request, lesson_id)
    return rows(get_conn().execute(
        f"SELECT {NOTE_COLS} FROM note n WHERE n.lesson_id=? AND n.username=? ORDER BY n.timestamp_s, n.id",
        (lesson_id, user.username)))


@app.post("/api/lessons/{lesson_id}/notes", status_code=201)
def create_note(lesson_id: int, body: NoteIn, request: Request):
    user, _ = access.require_lesson(request, lesson_id)
    with transaction() as c:
        nid = c.execute("INSERT INTO note (username, lesson_id, timestamp_s, body_md) VALUES (?,?,?,?)",
                        (user.username, lesson_id, body.timestamp_s, body.body_md)).lastrowid
        return row(c.execute(f"SELECT {NOTE_COLS} FROM note n WHERE n.id=?", (nid,)))


@app.patch("/api/notes/{note_id}")
def update_note(note_id: int, body: NotePatch, request: Request):
    user = _own_note(request, note_id)
    fields = body.model_dump(exclude_none=True)
    with transaction() as c:
        if fields:
            sets = ", ".join(f"{k}=?" for k in fields)
            c.execute(f"UPDATE note SET {sets}, updated_at=datetime('now') WHERE id=? AND username=?",
                      (*fields.values(), note_id, user.username))
        return row(c.execute(f"SELECT {NOTE_COLS} FROM note n WHERE n.id=?", (note_id,)))


@app.delete("/api/notes/{note_id}", status_code=204)
def delete_note(note_id: int, request: Request):
    user = _own_note(request, note_id)
    with transaction() as c:
        c.execute("DELETE FROM note WHERE id=? AND username=?", (note_id, user.username))
    return Response(status_code=204)


def _course_notes(course_id: int, username: str) -> list[dict]:
    order = {l["id"]: i for i, l in enumerate(ordered_lessons(course_id, username))}
    notes = rows(get_conn().execute(
        f"""SELECT {NOTE_COLS}, l.title AS lesson_title, s.title AS section_title
            FROM note n JOIN lesson l ON l.id = n.lesson_id LEFT JOIN section s ON s.id = l.section_id
            WHERE l.course_id = ? AND n.username = ?""", (course_id, username)))
    notes.sort(key=lambda n: (order.get(n["lesson_id"], 10**9), n["timestamp_s"], n["id"]))
    return notes


@app.get("/api/courses/{course_id}/notes")
def course_notes(course_id: int, request: Request):
    user = access.require_course(request, course_id)
    return _course_notes(course_id, user.username)


@app.get("/api/courses/{course_id}/notes/export.md")
def export_notes(course_id: int, request: Request):
    user = access.require_course(request, course_id)
    course = row(get_conn().execute("SELECT title FROM course WHERE id=?", (course_id,)))
    if not course:
        raise HTTPException(404)
    base = str(request.base_url).rstrip("/")
    lines = [f"# {course['title']} — notes", ""]
    cur_section, cur_lesson = object(), None
    for n in _course_notes(course_id, user.username):
        if n["section_title"] != cur_section:
            cur_section = n["section_title"]
            if cur_section:
                lines += [f"## {cur_section}", ""]
        if n["lesson_id"] != cur_lesson:
            cur_lesson = n["lesson_id"]
            lines += [f"### {n['lesson_title']}", ""]
        t = int(n["timestamp_s"])
        body = n["body_md"].strip().replace("\n", "\n  ")
        lines += [f"- [{fmt_ts(t)}]({base}/watch/{n['lesson_id']}?t={t}) {body}", ""]
    safe = re.sub(r"[^\w\- ]+", "", course["title"]).strip() or "notes"
    return PlainTextResponse("\n".join(lines), media_type="text/markdown; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{safe} - notes.md"'})


# ---------------------------------------------------------------- search

@app.get("/api/search")
def search(q: str, request: Request, limit: int = 30):
    user = access.current_user(request)
    q = q.strip()[:200]
    if not q:
        return {"courses": [], "lessons": [], "notes": []}
    limit = min(max(limit, 1), 100)
    clause, params = access.course_clause(user, "c.id")
    conn = get_conn()
    like = f"%{q}%"
    courses = rows(conn.execute(
        f"SELECT c.id, c.title FROM course c WHERE c.missing=0 AND c.title LIKE ?{clause} ORDER BY c.title LIMIT ?",
        (like, *params, limit)))
    lessons = rows(conn.execute(
        f"""SELECT l.id, l.title, l.fingerprint, c.title AS course_title, l.duration_s FROM lesson l
           JOIN course c ON c.id = l.course_id
           WHERE l.missing=0 AND (l.title LIKE ? OR l.description LIKE ?){clause} LIMIT ?""",
        (like, like, *params, limit)))
    for l in lessons:
        l["thumb_url"] = thumb_url(l)
        del l["fingerprint"]
    tokens = re.findall(r"\w+", q)
    notes = []
    if tokens:
        fts_q = " ".join(f'"{t}"*' for t in tokens)
        notes = rows(conn.execute(
            f"""SELECT n.id, n.lesson_id, n.timestamp_s,
                      snippet(note_fts, 0, '<mark>', '</mark>', '…', 24) AS snippet,
                      l.title AS lesson_title, c.title AS course_title, c.id AS course_id
               FROM note_fts JOIN note n ON n.id = note_fts.rowid
               JOIN lesson l ON l.id = n.lesson_id JOIN course c ON c.id = l.course_id
               WHERE note_fts MATCH ? AND n.username = ?{clause} ORDER BY rank LIMIT ?""",
            (fts_q, user.username, *params, limit)))
    return {"courses": courses, "lessons": lessons, "notes": notes}


# ---------------------------------------------------------------- users & course access (admins)

class AccessIn(BaseModel):
    mode: str = Field(pattern="^(all|selected)$")
    course_ids: list[int] = Field(default_factory=list, max_length=100_000)


class NewUserIn(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=1024)


class PasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=1024)


def _user_item(u: auth.User) -> dict:
    item = {"username": u.username, "is_admin": u.is_admin, "source": u.source}
    if not u.is_admin:
        item.update(access.access_of(u.username))
    return item


@app.get("/api/users")
def list_users():
    return [_user_item(u) for u in auth.all_users()]


@app.post("/api/users", status_code=201)
def create_user(body: NewUserIn, request: Request):
    admin = access.current_user(request)
    try:
        u = auth.create_app_user(body.username.strip(), body.password, admin.username)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    security.record("user_created", client_ip(request), admin.username, f"created user {u.username}")
    return _user_item(u)


@app.put("/api/users/{username}/password")
def reset_user_password(username: str, body: PasswordIn, request: Request):
    admin = access.current_user(request)
    try:
        auth.set_app_user_password(username, body.password)
    except ValueError as e:
        raise HTTPException(400, str(e)) from None
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    security.record("password_reset", client_ip(request), admin.username, f"reset password of {username}")
    return {"ok": True}


@app.delete("/api/users/{username}", status_code=204)
def delete_user(username: str, request: Request):
    admin = access.current_user(request)
    try:
        auth.delete_app_user(username)
    except LookupError as e:
        raise HTTPException(404, str(e)) from None
    security.record("user_deleted", client_ip(request), admin.username, f"deleted user {username}")
    return Response(status_code=204)


@app.put("/api/users/{username}/access")
def set_user_access(username: str, body: AccessIn):
    user = auth.get_user(username)
    if user is None:
        raise HTTPException(404, "unknown user")
    if user.is_admin:
        raise HTTPException(400, "Admins always see every course")
    access.set_access(username, body.mode, body.course_ids)
    return {"username": username, "is_admin": False, **access.access_of(username)}


@app.get("/api/admin/courses")
def admin_course_list():
    """All courses (for the access picker), regardless of the admin's own progress."""
    data = rows(get_conn().execute(
        """SELECT c.id, c.title, lb.name AS library, COUNT(l.id) AS lesson_count
           FROM course c LEFT JOIN library lb ON lb.id = c.library_id
           JOIN lesson l ON l.course_id = c.id AND l.missing = 0
           WHERE c.missing = 0 GROUP BY c.id"""))
    data.sort(key=lambda c: scanner.natural_key(c["title"]))
    return data


# ---------------------------------------------------------------- SPA

if (STATIC_DIR / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
def spa(full_path: str):
    if full_path.startswith("api/"):
        raise HTTPException(404)
    f = (STATIC_DIR / full_path).resolve()
    if full_path and STATIC_DIR in f.parents and f.is_file():
        return FileResponse(f)
    index = STATIC_DIR / "index.html"
    if index.is_file():
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
    return HTMLResponse("<h1>EduNest API is running</h1><p>Frontend not built. Run the Vite dev server.</p>")


# ---------------------------------------------------------------- startup self-check
# Every route except the static SPA shell must live under /api/, where the access guard applies.
for _r in app.routes:
    if isinstance(_r, APIRoute) and not _r.path.startswith("/api/") and _r.endpoint is not spa:
        raise RuntimeError(f"route {_r.path} is outside /api and would bypass authentication")
