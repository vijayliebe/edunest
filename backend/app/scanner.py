"""Library scanner: turns the folder tree of each library folder into courses / sections / lessons.

Libraries (configured in the UI) are folders of two kinds:
  collection:  <library>/<Course>/[<Section>/...]<lesson>.<ext>
  course:      <library>/[<Section>/...]<lesson>.<ext>      (the folder itself is one course)
Metadata priority per lesson: yt-dlp .info.json  >  embedded tags (yt-dlp-made files)  >  filename.
Nothing is ever written to a library folder.
"""
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import media
from .config import COVER_NAMES, IMAGE_EXTS, VIDEO_EXTS
from .db import get_conn, transaction

log = logging.getLogger("edunest.scanner")

YT_ID_IN_NAME = re.compile(r"\s*\[([A-Za-z0-9_-]{11})\]\s*$")
YT_ID_IN_URL = re.compile(r"(?:v=|youtu\.be/|/shorts/|/embed/)([A-Za-z0-9_-]{11})")
LEADING_NUM = re.compile(r"^\s*\d+(?:\s*[-._):]\s*|\s+)")
_NAT = re.compile(r"(\d+)")

_lock = threading.Lock()
status: dict = {"running": False, "errors": [], "processed": 0, "total": 0, "added": 0, "updated": 0,
                "relinked": 0, "missing": 0, "started_at": None, "finished_at": None, "error": None}


# ---------------------------------------------------------------- helpers

def natural_key(s: str) -> str:
    """Sortable string where embedded numbers compare numerically ('2' < '10')."""
    return "".join(p.zfill(10) if p.isdigit() else p.lower() for p in _NAT.split(s))


def clean_title(stem: str) -> str:
    t = YT_ID_IN_NAME.sub("", stem)
    stripped = LEADING_NUM.sub("", t)
    if stripped.strip():
        t = stripped
    t = t.replace("_", " ")
    return re.sub(r"\s+", " ", t).strip() or stem


def is_hidden(name: str) -> bool:
    return name.startswith((".", "@", "#")) or name in ("$RECYCLE.BIN", "System Volume Information")


# yt-dlp / MeTube intermediate files: "Title.f137.mp4", "Title.temp.mp4", "Title.mp4.part"
YTDLP_TEMP = re.compile(r"\.(f\d+(-\d+)?|temp|part)\.[A-Za-z0-9]+$", re.I)


def is_video_file(name: str) -> bool:
    return (not is_hidden(name) and Path(name).suffix.lower() in VIDEO_EXTS
            and not YTDLP_TEMP.search(name))


def walk_videos(course_dir: Path, recursive: bool = True) -> list[Path]:
    if not recursive:
        try:
            return [p for p in course_dir.iterdir() if p.is_file() and is_video_file(p.name)]
        except OSError:
            return []
    out = []
    for root, dirs, files in os.walk(course_dir):
        dirs[:] = [d for d in dirs if not is_hidden(d)]
        out.extend(Path(root) / f for f in files if is_video_file(f))
    return out


def has_videos(d: Path) -> bool:
    for _root, dirs, files in os.walk(d):
        dirs[:] = [x for x in dirs if not is_hidden(x)]
        if any(is_video_file(f) for f in files):
            return True
    return False


def find_image(directory: Path, stem: str) -> Path | None:
    for ext in IMAGE_EXTS:
        for cand in (directory / f"{stem}{ext}", directory / f"{stem}{ext.upper()}"):
            if cand.is_file():
                return cand
    return None


def load_json(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception as e:  # noqa: BLE001
        log.warning("could not read %s: %s", path, e)
        return None


def fmt_date(d: str | None) -> str | None:
    if not d:
        return None
    d = str(d)
    if re.fullmatch(r"\d{8}", d):
        return f"{d[:4]}-{d[4:6]}-{d[6:]}"
    return d[:10]


def sidecar_sig(video: Path) -> str:
    parts = []
    info = video.with_name(video.stem + ".info.json")
    if info.is_file():
        parts.append(f"i{info.stat().st_mtime:.0f}")
    img = find_image(video.parent, video.stem)
    if img:
        parts.append(f"t:{img.name}")
    return "|".join(parts)


# ---------------------------------------------------------------- metadata

def extract_lesson_meta(video: Path) -> dict:
    meta: dict = {"title": clean_title(video.stem), "meta_source": "filename",
                  "description": None, "channel": None, "upload_date": None, "youtube_id": None}

    pr = media.summarize_probe(media.probe(video))
    meta.update({k: pr.get(k) for k in ("duration_s", "width", "height", "vcodec", "acodec")})
    meta["playable"] = pr.get("playable", "yes")
    meta["has_embedded_cover"] = 1 if pr.get("cover_stream") is not None else 0
    chapters = pr.get("chapters") or []

    # Embedded tags are trusted only when the file looks yt-dlp-made (has a source URL);
    # screen recorders and encoders often put junk in the title tag.
    if pr.get("source_url"):
        m = YT_ID_IN_URL.search(pr["source_url"])
        meta["youtube_id"] = m.group(1) if m else None
        meta.update({
            "title": pr.get("title") or meta["title"],
            "description": pr.get("description"),
            "channel": pr.get("channel"),
            "upload_date": fmt_date(pr.get("date")),
            "meta_source": "embedded",
        })

    info_path = video.with_name(video.stem + ".info.json")
    info = load_json(info_path) if info_path.is_file() else None
    if info:
        meta.update({
            "title": info.get("title") or meta["title"],
            "description": info.get("description") or meta["description"],
            "channel": info.get("channel") or info.get("uploader") or meta["channel"],
            "upload_date": fmt_date(info.get("upload_date")) or meta["upload_date"],
            "meta_source": "info.json",
        })
        if (info.get("extractor_key") or info.get("extractor") or "").lower().startswith("youtube"):
            meta["youtube_id"] = info.get("id") or meta["youtube_id"]
        if not meta.get("duration_s") and info.get("duration"):
            meta["duration_s"] = float(info["duration"])
        if info.get("chapters"):
            chapters = [{"start_s": float(c.get("start_time") or 0),
                         "end_s": float(c["end_time"]) if c.get("end_time") else None,
                         "title": c.get("title") or f"Chapter {i + 1}"}
                        for i, c in enumerate(info["chapters"])]

    if not meta["youtube_id"]:
        m = YT_ID_IN_NAME.search(video.stem)
        meta["youtube_id"] = m.group(1) if m else None

    thumb = find_image(video.parent, video.stem)
    meta["thumb_path"] = str(thumb) if thumb else None
    # A single chapter spanning the whole video is noise.
    meta["chapters"] = chapters if len(chapters) > 1 else []
    return meta


def single_video_course_meta(v: Path) -> dict:
    """Course metadata for a lone video: its own title / description / thumbnail."""
    meta = {"title": clean_title(v.stem), "description": None, "channel": None,
            "cover_path": None, "youtube_id": None}
    info_path = v.with_name(v.stem + ".info.json")
    info = load_json(info_path) if info_path.is_file() else None
    if info:
        meta["title"] = info.get("title") or meta["title"]
        meta["description"] = info.get("description")
        meta["channel"] = info.get("channel") or info.get("uploader")
    img = find_image(v.parent, v.stem)
    meta["cover_path"] = str(img) if img else None
    return meta


def extract_course_meta(course_dir: Path) -> dict:
    meta = {"title": course_dir.name, "description": None, "channel": None,
            "cover_path": None, "youtube_id": None}
    for name in COVER_NAMES:
        img = find_image(course_dir, name)
        if img:
            meta["cover_path"] = str(img)
            break
    # yt-dlp playlist downloads with --write-info-json leave "<playlist> [PL...].info.json" here.
    for f in sorted(course_dir.glob("*.info.json")):
        info = load_json(f)
        if info and info.get("_type") == "playlist":
            meta["description"] = info.get("description") or None
            meta["channel"] = info.get("channel") or info.get("uploader")
            meta["youtube_id"] = info.get("id")
            if not meta["cover_path"]:
                stem = f.name[: -len(".info.json")]
                img = find_image(course_dir, stem)
                meta["cover_path"] = str(img) if img else None
            break
    return meta


# ---------------------------------------------------------------- db upserts

def upsert_course(conn, path: str, library_id: int, m: dict) -> int:
    conn.execute(
        """INSERT INTO course (path, library_id, title, description, channel, cover_path, youtube_id, missing)
           VALUES (?,?,?,?,?,?,?,0)
           ON CONFLICT(path) DO UPDATE SET library_id=excluded.library_id, title=excluded.title,
             description=excluded.description,
             channel=excluded.channel, cover_path=excluded.cover_path, youtube_id=excluded.youtube_id,
             missing=0, updated_at=datetime('now')""",
        (path, library_id, m["title"], m["description"], m["channel"], m["cover_path"], m["youtube_id"]))
    return conn.execute("SELECT id FROM course WHERE path=?", (path,)).fetchone()[0]


def upsert_section(conn, course_id: int, path: str, title: str, sort_key: str) -> int:
    conn.execute(
        """INSERT INTO section (course_id, path, title, sort_key) VALUES (?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET course_id=excluded.course_id, title=excluded.title,
             sort_key=excluded.sort_key""",
        (course_id, path, title, sort_key))
    return conn.execute("SELECT id FROM section WHERE path=?", (path,)).fetchone()[0]


LESSON_META_COLS = ("title", "duration_s", "width", "height", "vcodec", "acodec", "playable",
                    "youtube_id", "description", "channel", "upload_date", "thumb_path",
                    "has_embedded_cover", "meta_source")


def write_lesson(conn, lesson_id: int | None, base: dict, meta: dict) -> int:
    vals = {**base, **{k: meta.get(k) for k in LESSON_META_COLS}}
    if lesson_id is None:
        cols = ", ".join(vals)
        cur = conn.execute(f"INSERT INTO lesson ({cols}) VALUES ({', '.join('?' * len(vals))})",
                           tuple(vals.values()))
        lesson_id = cur.lastrowid
    else:
        sets = ", ".join(f"{k}=?" for k in vals)
        conn.execute(f"UPDATE lesson SET {sets}, missing=0, updated_at=datetime('now') WHERE id=?",
                     (*vals.values(), lesson_id))
    conn.execute("DELETE FROM chapter WHERE lesson_id=?", (lesson_id,))
    conn.executemany("INSERT INTO chapter (lesson_id, start_s, end_s, title) VALUES (?,?,?,?)",
                     [(lesson_id, c["start_s"], c["end_s"], c["title"]) for c in meta["chapters"]])
    return lesson_id


# ---------------------------------------------------------------- scan

def scan(force: bool = False) -> None:
    if not _lock.acquire(blocking=False):
        return
    try:
        status.update(running=True, errors=[], processed=0, total=0, added=0, updated=0, relinked=0, missing=0,
                      error=None, started_at=_now(), finished_at=None)
        _scan(force)
    except Exception as e:  # noqa: BLE001
        log.exception("scan failed")
        status["error"] = str(e)
    finally:
        status.update(running=False, finished_at=_now())
        _lock.release()


def scan_in_background(force: bool = False) -> bool:
    if status["running"]:
        return False
    threading.Thread(target=scan, args=(force,), daemon=True, name="scanner").start()
    return True


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


SECTION_LIKE = re.compile(r"^\s*(\d+|(section|week|module|part|chapter|lecture|lesson|unit|day)\b)", re.I)


def guess_mode(root: Path) -> str:
    """'course' if the folder looks like ONE course (videos directly inside, or numbered
    section folders like '01 - Intro' / 'Week 2'), else 'collection' (sub-folders are courses)."""
    try:
        entries = list(root.iterdir())
    except OSError:
        return "collection"
    subdirs = [e for e in entries if e.is_dir() and not is_hidden(e.name) and has_videos(e)]
    if subdirs and sum(bool(SECTION_LIKE.match(d.name)) for d in subdirs) / len(subdirs) >= 0.6:
        return "course"
    loose = [e for e in entries if e.is_file() and is_video_file(e.name)]
    if not subdirs and loose and sum(bool(SECTION_LIKE.match(f.name)) for f in loose) / len(loose) >= 0.6:
        return "course"  # numbered lessons like "01 Intro.mp4" directly in the folder
    # Named sub-folders (playlists / courses) and/or unrelated loose videos (e.g. a MeTube
    # downloads folder): collection — each sub-folder is a course, each loose video its own course.
    return "collection"


def enabled_libraries() -> list[dict]:
    return [dict(r) for r in get_conn().execute(
        "SELECT id, path, name, mode FROM library WHERE enabled=1 ORDER BY id")]


def is_inside_library(p: Path) -> bool:
    p = p.resolve()
    return any(p == Path(l["path"]) or Path(l["path"]) in p.parents for l in enabled_libraries())


def _scan(force: bool) -> None:
    t0 = time.time()
    conn = get_conn()

    # (library id, course key, folder lessons are relative to, videos, meta override)
    plan: list[tuple[int, str, Path, list[Path], dict | None]] = []
    for lib in enabled_libraries():
        root = Path(lib["path"])
        if not root.is_dir():
            status["errors"].append(f"Library folder not found: {root}")
            continue
        if lib["mode"] == "course":
            vids = walk_videos(root)
            if vids:
                plan.append((lib["id"], str(root), root, vids, {"title": lib["name"]}))
            continue
        # collection: each sub-folder is a course; each video lying directly in the folder is
        # a single-lesson course of its own (keyed by the file path).
        for v in sorted(walk_videos(root, recursive=False), key=lambda p: natural_key(p.name)):
            plan.append((lib["id"], str(v), root, [v], single_video_course_meta(v)))
        for d in sorted((d for d in root.iterdir() if d.is_dir() and not is_hidden(d.name)),
                        key=lambda p: natural_key(p.name)):
            vids = walk_videos(d)
            if vids:
                plan.append((lib["id"], str(d), d, vids, None))
    status["total"] = sum(len(p[3]) for p in plan)

    existing = {r["path"]: dict(r) for r in conn.execute(
        "SELECT id, path, size_bytes, mtime, fingerprint, meta_sig FROM lesson")}
    seen_lessons: set[int] = set()
    seen_courses: set[int] = set()

    for lib_id, course_key, course_dir, videos, override in plan:
        meta = extract_course_meta(course_dir) if override is None or "cover_path" not in override else {}
        meta.update(override or {})
        with transaction() as c:
            course_id = upsert_course(c, course_key, lib_id, meta)
        if course_id in seen_courses:  # same folder reachable via two libraries
            continue
        seen_courses.add(course_id)

        for v in videos:
            try:
                lid = _process_video(conn, course_id, course_dir, v, existing, force)
                if lid:
                    seen_lessons.add(lid)
            except Exception as e:  # noqa: BLE001
                log.warning("skipping %s: %s", v, e)
            status["processed"] += 1

    with transaction() as c:
        all_ids = {r[0] for r in c.execute("SELECT id FROM lesson WHERE missing=0")}
        gone = all_ids - seen_lessons
        c.executemany("UPDATE lesson SET missing=1 WHERE id=?", [(i,) for i in gone])
        status["missing"] = len(gone)
        c.execute("UPDATE course SET missing=1")
        c.executemany("UPDATE course SET missing=0 WHERE id=?", [(i,) for i in seen_courses])
        c.execute("DELETE FROM section WHERE id NOT IN (SELECT section_id FROM lesson WHERE section_id IS NOT NULL)")
    log.info("scan finished in %.1fs: %s", time.time() - t0, status)


def _process_video(conn, course_id: int, course_dir: Path, v: Path, existing: dict, force: bool) -> int | None:
    st = v.stat()
    path = str(v)
    in_course = v.relative_to(course_dir)

    section_id = None
    if len(in_course.parts) > 1:
        sec_parts = in_course.parts[:-1]
        sec_title = " / ".join(clean_title(p) for p in sec_parts)
        with transaction() as c:
            section_id = upsert_section(c, course_id, str(course_dir.joinpath(*sec_parts)), sec_title,
                                        natural_key("/".join(sec_parts)))

    base = {"course_id": course_id, "section_id": section_id, "path": path,
            "sort_key": natural_key(in_course.name), "size_bytes": st.st_size, "mtime": st.st_mtime}
    sig = sidecar_sig(v)
    ex = existing.get(path)

    if ex and not force and ex["size_bytes"] == st.st_size and abs(ex["mtime"] - st.st_mtime) < 1 \
            and (ex["meta_sig"] or "") == sig:
        with transaction() as c:
            c.execute("UPDATE lesson SET course_id=?, section_id=?, sort_key=?, missing=0 WHERE id=?",
                      (course_id, section_id, base["sort_key"], ex["id"]))
        return ex["id"]

    fp = media.fingerprint(v, st.st_size)
    lesson_id = ex["id"] if ex else None
    relinked = False
    if lesson_id is None:
        # Renamed / moved file? Re-attach to the old row so notes & progress survive.
        cand = conn.execute(
            "SELECT id, path FROM lesson WHERE fingerprint=? ORDER BY missing DESC", (fp,)).fetchall()
        for r in cand:
            if not Path(r["path"]).exists():
                lesson_id, relinked = r["id"], True
                existing.pop(r["path"], None)
                break

    meta = extract_lesson_meta(v)
    with transaction() as c:
        new_id = write_lesson(c, lesson_id, {**base, "fingerprint": fp, "meta_sig": sig}, meta)
    if relinked:
        status["relinked"] += 1
    elif ex:
        status["updated"] += 1
    else:
        status["added"] += 1
    return new_id
