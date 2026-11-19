"""SQLite access. One connection per thread, WAL mode, schema versioned via PRAGMA user_version."""
import sqlite3
import threading
from contextlib import contextmanager

from .config import DB_PATH

_local = threading.local()

MIGRATIONS: list[str] = [
    # v1 — initial schema
    """
    CREATE TABLE library (
        id          INTEGER PRIMARY KEY,
        path        TEXT NOT NULL UNIQUE,   -- absolute path inside the container
        name        TEXT NOT NULL,
        mode        TEXT NOT NULL DEFAULT 'collection',  -- collection: subfolders are courses | course: folder is one course
        enabled     INTEGER NOT NULL DEFAULT 1,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE course (
        id            INTEGER PRIMARY KEY,
        library_id    INTEGER REFERENCES library(id) ON DELETE SET NULL,
        path          TEXT NOT NULL UNIQUE,   -- absolute folder path
        title         TEXT NOT NULL,
        description   TEXT,
        channel       TEXT,
        cover_path    TEXT,           -- absolute path of a sidecar cover image, if any
        youtube_id    TEXT,           -- playlist id, if known
        missing       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE section (
        id         INTEGER PRIMARY KEY,
        course_id  INTEGER NOT NULL REFERENCES course(id) ON DELETE CASCADE,
        path       TEXT NOT NULL UNIQUE,  -- absolute folder path
        title      TEXT NOT NULL,
        sort_key   TEXT NOT NULL
    );

    CREATE TABLE lesson (
        id            INTEGER PRIMARY KEY,
        course_id     INTEGER NOT NULL REFERENCES course(id) ON DELETE CASCADE,
        section_id    INTEGER REFERENCES section(id) ON DELETE SET NULL,
        path          TEXT NOT NULL UNIQUE,   -- absolute file path
        title         TEXT NOT NULL,
        sort_key      TEXT NOT NULL,
        size_bytes    INTEGER NOT NULL,
        mtime         REAL NOT NULL,
        fingerprint   TEXT NOT NULL,
        duration_s    REAL,
        width         INTEGER,
        height        INTEGER,
        vcodec        TEXT,
        acodec        TEXT,
        playable      TEXT NOT NULL DEFAULT 'yes',   -- yes | maybe | no
        youtube_id    TEXT,
        description   TEXT,
        channel       TEXT,
        upload_date   TEXT,
        thumb_path    TEXT,           -- absolute path of a sidecar thumbnail, if any
        has_embedded_cover INTEGER NOT NULL DEFAULT 0,
        meta_source   TEXT,           -- info.json | embedded | filename
        meta_sig      TEXT,           -- signature of sidecar files, to notice new/changed ones
        missing       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX lesson_course ON lesson(course_id, sort_key);
    CREATE INDEX lesson_fp ON lesson(fingerprint);

    CREATE TABLE chapter (
        id         INTEGER PRIMARY KEY,
        lesson_id  INTEGER NOT NULL REFERENCES lesson(id) ON DELETE CASCADE,
        start_s    REAL NOT NULL,
        end_s      REAL,
        title      TEXT NOT NULL
    );
    CREATE INDEX chapter_lesson ON chapter(lesson_id, start_s);

    CREATE TABLE progress (
        lesson_id        INTEGER PRIMARY KEY REFERENCES lesson(id) ON DELETE CASCADE,
        position_s       REAL NOT NULL DEFAULT 0,
        completed        INTEGER NOT NULL DEFAULT 0,
        last_watched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE note (
        id           INTEGER PRIMARY KEY,
        lesson_id    INTEGER NOT NULL REFERENCES lesson(id) ON DELETE CASCADE,
        timestamp_s  REAL NOT NULL,
        body_md      TEXT NOT NULL,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX note_lesson ON note(lesson_id, timestamp_s);

    CREATE VIRTUAL TABLE note_fts USING fts5(body_md, content='note', content_rowid='id');
    CREATE TRIGGER note_ai AFTER INSERT ON note BEGIN
        INSERT INTO note_fts(rowid, body_md) VALUES (new.id, new.body_md);
    END;
    CREATE TRIGGER note_ad AFTER DELETE ON note BEGIN
        INSERT INTO note_fts(note_fts, rowid, body_md) VALUES ('delete', old.id, old.body_md);
    END;
    CREATE TRIGGER note_au AFTER UPDATE ON note BEGIN
        INSERT INTO note_fts(note_fts, rowid, body_md) VALUES ('delete', old.id, old.body_md);
        INSERT INTO note_fts(rowid, body_md) VALUES (new.id, new.body_md);
    END;
    """,
    # v2 — login sessions (only a SHA-256 of each token is stored)
    """
    CREATE TABLE session (
        token_hash  TEXT PRIMARY KEY,
        username    TEXT NOT NULL,
        user_fp     TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at  TEXT NOT NULL,
        ip          TEXT,
        user_agent  TEXT
    );
    CREATE INDEX session_expires ON session(expires_at);

    -- security log: repeated events from the same ip/kind/user within a minute are merged (count)
    CREATE TABLE security_event (
        id        INTEGER PRIMARY KEY,
        at        TEXT NOT NULL DEFAULT (datetime('now')),
        first_at  TEXT NOT NULL DEFAULT (datetime('now')),
        kind      TEXT NOT NULL,
        ip        TEXT,
        username  TEXT,
        path      TEXT,
        count     INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX security_event_at ON security_event(at);
    CREATE INDEX security_event_kind ON security_event(kind, ip, at);
    """,
    # v3 — per-user progress & notes, per-user course access.
    # Existing rows get username '' and are handed to the first admin at startup (auth.assign_legacy_data).
    """
    CREATE TABLE progress_new (
        username         TEXT NOT NULL,
        lesson_id        INTEGER NOT NULL REFERENCES lesson(id) ON DELETE CASCADE,
        position_s       REAL NOT NULL DEFAULT 0,
        completed        INTEGER NOT NULL DEFAULT 0,
        last_watched_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (username, lesson_id)
    );
    INSERT INTO progress_new (username, lesson_id, position_s, completed, last_watched_at)
        SELECT '', lesson_id, position_s, completed, last_watched_at FROM progress;
    DROP TABLE progress;
    ALTER TABLE progress_new RENAME TO progress;
    CREATE INDEX progress_user ON progress(username, last_watched_at);

    ALTER TABLE note ADD COLUMN username TEXT NOT NULL DEFAULT '';
    CREATE INDEX note_user ON note(username, lesson_id, timestamp_s);

    -- Course access for non-admin users. Admins always see everything.
    -- mode 'all' = every course; 'selected' = only rows in user_course. No row = no access.
    CREATE TABLE user_access (
        username  TEXT PRIMARY KEY,
        mode      TEXT NOT NULL DEFAULT 'selected'
    );
    CREATE TABLE user_course (
        username   TEXT NOT NULL,
        course_id  INTEGER NOT NULL REFERENCES course(id) ON DELETE CASCADE,
        PRIMARY KEY (username, course_id)
    );

    -- Regular (non-admin) users added by an admin in Settings. Admins exist only in docker-compose.
    CREATE TABLE app_user (
        username       TEXT PRIMARY KEY,
        password_hash  TEXT NOT NULL,
        created_at     TEXT NOT NULL DEFAULT (datetime('now')),
        created_by     TEXT
    );
    """,
    # v4 — courses a user removed from "Continue watching". Watching that course again
    # (a newer progress.last_watched_at) brings it back. Progress itself is untouched.
    """
    CREATE TABLE continue_hidden (
        username   TEXT NOT NULL,
        course_id  INTEGER NOT NULL REFERENCES course(id) ON DELETE CASCADE,
        hidden_at  TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (username, course_id)
    );
    """,
    # v5 — which lessons have been handed to the transcript service, and for which version of the file
    """
    ALTER TABLE lesson ADD COLUMN ai_fp TEXT;
    """,
    # v6 — chat with a video. Private to each user, like notes.
    """
    CREATE TABLE chat_message (
        id          INTEGER PRIMARY KEY,
        username    TEXT NOT NULL,
        lesson_id   INTEGER NOT NULL REFERENCES lesson(id) ON DELETE CASCADE,
        role        TEXT NOT NULL,           -- user | assistant
        content     TEXT NOT NULL,
        at_s        REAL,                    -- where the user was in the video when asking
        model       TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX chat_user_lesson ON chat_message(username, lesson_id, id);
    CREATE INDEX chat_user_time ON chat_message(username, created_at);
    """,
]


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA synchronous=FULL")  # every commit is on disk before we reply
    return conn


def get_conn() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = _connect()
        _local.conn = conn
    return conn


@contextmanager
def transaction():
    conn = get_conn()
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise


def migrate() -> None:
    conn = get_conn()
    version = conn.execute("PRAGMA user_version").fetchone()[0]
    for i, sql in enumerate(MIGRATIONS[version:], start=version + 1):
        conn.executescript("BEGIN;" + sql + f"; PRAGMA user_version={i}; COMMIT;")


def rows(cur) -> list[dict]:
    return [dict(r) for r in cur.fetchall()]


def row(cur) -> dict | None:
    r = cur.fetchone()
    return dict(r) if r else None


def seed_libraries(libs: list[dict]) -> None:
    """On first start only, create libraries from the EDUNEST_LIBRARIES env var."""
    conn = get_conn()
    if conn.execute("SELECT COUNT(*) FROM library").fetchone()[0]:
        return
    from pathlib import Path
    from .scanner import guess_mode
    for lib in libs:
        p = lib["path"]
        conn.execute("INSERT OR IGNORE INTO library (path, name, mode) VALUES (?, ?, ?)",
                     (p, lib.get("name") or Path(p).name or p, guess_mode(Path(p))))
