"""Client for the optional transcript/AI service (Lectern, see /lectern).

EduNest stays in charge of who may see what: every endpoint that uses this module checks the login
and the course access first. Lectern itself is never exposed; it only sees file paths and titles.
Lectern must mount the video folders at the same paths as EduNest.
"""
import json
import logging
import threading
import urllib.error
import urllib.request

from .config import AI_KEY, AI_URL
from .db import get_conn, rows

log = logging.getLogger("edunest.ai")
_sync_lock = threading.Lock()


class Unavailable(Exception):
    pass


def enabled() -> bool:
    return bool(AI_URL and AI_KEY)


def call(method: str, path: str, body=None, timeout: float = 5, raw: bool = False):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(AI_URL + path, data=data, method=method,
                                 headers={"Authorization": f"Bearer {AI_KEY}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:300].decode("utf-8", "replace")
        raise Unavailable(f"{e.code}: {detail}") from None
    except (urllib.error.URLError, OSError) as e:
        raise Unavailable(str(e)) from None
    return payload.decode("utf-8", "replace") if raw else json.loads(payload)


def video_body(lesson: dict, priority: int = 0) -> dict:
    body = {"path": lesson["path"], "title": lesson["title"], "duration_s": lesson["duration_s"], "priority": priority}
    if lesson.get("youtube_id") and len(lesson["youtube_id"]) == 11:
        body["youtube_id"] = lesson["youtube_id"]
    return body


def register(lesson: dict, priority: int = 0) -> dict:
    """Make sure Lectern knows this lesson; returns Lectern's view of it (id, status, ...)."""
    v = call("POST", "/v1/videos", video_body(lesson, priority))
    get_conn().execute("UPDATE lesson SET ai_fp=? WHERE id=?", (lesson["fingerprint"], lesson["id"]))
    return v


def sync() -> None:
    """Hand every new or changed lesson to Lectern, so transcripts are ready before anyone asks."""
    if not enabled() or not _sync_lock.acquire(blocking=False):
        return
    try:
        conn = get_conn()
        todo = rows(conn.execute(
            "SELECT id, path, title, duration_s, youtube_id, fingerprint FROM lesson "
            "WHERE missing=0 AND (ai_fp IS NULL OR ai_fp != fingerprint) ORDER BY id"))
        done = 0
        for i in range(0, len(todo), 200):
            chunk = todo[i:i + 200]
            res = call("POST", "/v1/videos/batch", [video_body(l) for l in chunk], timeout=60)
            ok = [(l["fingerprint"], l["id"]) for l, r in zip(chunk, res) if "id" in r]
            conn.executemany("UPDATE lesson SET ai_fp=? WHERE id=?", ok)
            done += len(ok)
            for l, r in zip(chunk, res):
                if "id" not in r:
                    log.warning("transcripts: Lectern refused %s: %s", l["path"], r["error"])
        if todo:
            log.info("transcripts: handed %d of %d new/changed lessons to Lectern", done, len(todo))
    except Unavailable as e:
        log.warning("transcripts: Lectern not reachable (%s); will retry after the next scan", e)
    finally:
        _sync_lock.release()


def sync_in_background() -> None:
    if enabled():
        threading.Thread(target=sync, daemon=True, name="ai-sync").start()
