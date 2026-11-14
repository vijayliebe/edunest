"""ffprobe / ffmpeg helpers. Everything degrades gracefully when the binaries are missing."""
import hashlib
import json
import logging
import re
import shutil
import subprocess
import threading
from pathlib import Path

log = logging.getLogger("edunest.media")

FFPROBE = shutil.which("ffprobe")
FFMPEG = shutil.which("ffmpeg")

BROWSER_VIDEO = {"h264", "vp8", "vp9", "av1"}
SAFARI_ONLY_VIDEO = {"hevc", "h265"}
BROWSER_AUDIO = {"aac", "mp3", "opus", "vorbis", "flac", None}

_thumb_sem = threading.Semaphore(2)


def fingerprint(path: Path, size: int) -> str:
    """size + sha1 of first and last MiB — cheap, and survives renames/moves."""
    h = hashlib.sha1(str(size).encode())
    chunk = 1024 * 1024
    with open(path, "rb") as f:
        h.update(f.read(chunk))
        if size > 2 * chunk:
            f.seek(-chunk, 2)
            h.update(f.read(chunk))
    return h.hexdigest()


def probe(path: Path) -> dict:
    if not FFPROBE:
        return {}
    try:
        out = subprocess.run(
            [FFPROBE, "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", "-show_chapters", str(path)],
            capture_output=True, timeout=60, check=True,
        ).stdout
        return json.loads(out or b"{}")
    except Exception as e:  # noqa: BLE001
        log.warning("ffprobe failed for %s: %s", path, e)
        return {}


def summarize_probe(p: dict) -> dict:
    fmt = p.get("format", {}) or {}
    streams = p.get("streams", []) or []
    tags = {k.lower(): v for k, v in (fmt.get("tags") or {}).items()}
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    cover = next((s for s in streams if (s.get("disposition") or {}).get("attached_pic")), None)

    comment = (tags.get("comment") or "").strip()
    vcodec = video.get("codec_name") if video else None
    acodec = audio.get("codec_name") if audio else None
    if not p:
        playable = "yes"  # unknown — let the browser try
    elif vcodec in BROWSER_VIDEO and acodec in BROWSER_AUDIO:
        playable = "yes"
    elif vcodec in SAFARI_ONLY_VIDEO:
        playable = "maybe"
    else:
        playable = "no"

    try:
        duration = float(fmt.get("duration")) if fmt.get("duration") else None
    except ValueError:
        duration = None

    chapters = []
    for c in p.get("chapters", []) or []:
        title = (c.get("tags") or {}).get("title") or f"Chapter {len(chapters) + 1}"
        chapters.append({"start_s": float(c.get("start_time", 0)),
                         "end_s": float(c.get("end_time", 0)) or None, "title": title})

    return {
        "duration_s": duration,
        "width": video.get("width") if video else None,
        "height": video.get("height") if video else None,
        "vcodec": vcodec,
        "acodec": acodec,
        "playable": playable,
        "title": tags.get("title"),
        "description": tags.get("description") or tags.get("synopsis")
        or (comment if comment and not comment.startswith("http") else None),
        "channel": tags.get("artist") or tags.get("album_artist"),
        "date": tags.get("date"),
        "source_url": tags.get("purl") or (comment if comment and comment.startswith("http") else None),
        "cover_stream": cover.get("index") if cover else None,
        "chapters": chapters,
    }


def make_thumbnail(src: Path, dest: Path, duration: float | None, cover_stream: int | None = None,
                   width: int = 480) -> bool:
    """Write a JPEG thumbnail. Prefers an embedded cover image, else a frame ~10% in."""
    if not FFMPEG:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".tmp.jpg")
    scale = f"scale={width}:-2"
    if cover_stream is not None:
        cmd = [FFMPEG, "-v", "error", "-y", "-i", str(src), "-map", f"0:{cover_stream}",
               "-frames:v", "1", "-vf", scale, "-q:v", "4", str(tmp)]
    else:
        at = max(1.0, (duration or 30) * 0.1)
        cmd = [FFMPEG, "-v", "error", "-y", "-ss", f"{at:.2f}", "-i", str(src),
               "-frames:v", "1", "-vf", scale, "-q:v", "4", str(tmp)]
    with _thumb_sem:
        try:
            subprocess.run(cmd, capture_output=True, timeout=120, check=True)
            if tmp.exists() and tmp.stat().st_size > 0:
                tmp.replace(dest)
                return True
        except Exception as e:  # noqa: BLE001
            log.warning("thumbnail failed for %s: %s", src, e)
        finally:
            tmp.unlink(missing_ok=True)
    return False


_SRT_TS = re.compile(r"(\d{2}:\d{2}:\d{2}),(\d{3})")


def srt_to_vtt(text: str) -> str:
    text = text.lstrip("﻿").replace("\r\n", "\n")
    return "WEBVTT\n\n" + _SRT_TS.sub(r"\1.\2", text)
