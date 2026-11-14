"""Who may see what.

  * Progress and notes always belong to the logged-in user (admins included).
  * Admins can see every course.
  * Non-admins see either all courses or only the courses an admin selected for them.
    A user with no access entry sees NOTHING (safe default for newly added users).
  * A course the user may not see behaves exactly like one that doesn't exist (404), so its
    existence isn't revealed. Such probes are written to the security log.
"""
from fastapi import HTTPException, Request

from . import auth, security
from .db import get_conn, row, transaction


def current_user(request: Request) -> auth.User:
    user = getattr(request.state, "user", None)
    if user is None:  # defence in depth: the middleware already guarantees a user here
        raise HTTPException(401, "Login required")
    return user


def allowed_course_ids(user: auth.User) -> set[int] | None:
    """None = every course; otherwise the set of course ids the user may see."""
    if user.is_admin:
        return None
    conn = get_conn()
    acc = row(conn.execute("SELECT mode FROM user_access WHERE username=?", (user.username,)))
    if acc and acc["mode"] == "all":
        return None
    return {r[0] for r in conn.execute("SELECT course_id FROM user_course WHERE username=?", (user.username,))}


def course_clause(user: auth.User, column: str) -> tuple[str, tuple]:
    """SQL fragment restricting `column` (a course id) to what the user may see."""
    if allowed_course_ids(user) is None:
        return "", ()
    return f" AND {column} IN (SELECT course_id FROM user_course WHERE username = ?)", (user.username,)


def _not_found(request: Request, user: auth.User, what: str):
    security.record("forbidden", request.client.host if request.client else "?", user.username, request.url.path)
    raise HTTPException(404, f"{what} not found")


def require_course(request: Request, course_id: int) -> auth.User:
    user = current_user(request)
    allowed = allowed_course_ids(user)
    if allowed is not None and course_id not in allowed:
        _not_found(request, user, "course")
    return user


def require_lesson(request: Request, lesson_id: int) -> tuple[auth.User, dict]:
    user = current_user(request)
    lesson = row(get_conn().execute("SELECT * FROM lesson WHERE id=?", (lesson_id,)))
    if not lesson:
        raise HTTPException(404, "lesson not found")
    allowed = allowed_course_ids(user)
    if allowed is not None and lesson["course_id"] not in allowed:
        _not_found(request, user, "lesson")
    return user, lesson


# ---------------------------------------------------------------- admin management

def access_of(username: str) -> dict:
    conn = get_conn()
    acc = row(conn.execute("SELECT mode FROM user_access WHERE username=?", (username,)))
    ids = [r[0] for r in conn.execute("SELECT course_id FROM user_course WHERE username=? ORDER BY course_id", (username,))]
    return {"mode": acc["mode"] if acc else "selected", "course_ids": ids}


def set_access(username: str, mode: str, course_ids: list[int]) -> None:
    with transaction() as c:
        c.execute("INSERT INTO user_access (username, mode) VALUES (?, ?) "
                  "ON CONFLICT(username) DO UPDATE SET mode=excluded.mode", (username, mode))
        c.execute("DELETE FROM user_course WHERE username=?", (username,))
        if mode == "selected":
            valid = {r[0] for r in c.execute("SELECT id FROM course")}
            c.executemany("INSERT INTO user_course (username, course_id) VALUES (?, ?)",
                          [(username, cid) for cid in sorted(set(course_ids)) if cid in valid])


def assign_legacy_data() -> None:
    """Progress/notes created before per-user data existed (username '') go to the first admin."""
    owner = auth.first_admin()
    if not owner:
        return
    with transaction() as c:
        c.execute("UPDATE OR IGNORE progress SET username=? WHERE username=''", (owner,))
        c.execute("DELETE FROM progress WHERE username=''")
        c.execute("UPDATE note SET username=? WHERE username=''", (owner,))
