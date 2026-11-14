import os
from pathlib import Path

# Library folders used to seed the DB on first start (later managed in Settings UI).
# Separate several with ";" or newlines, e.g. EDUNEST_LIBRARIES="/media/dl;/media/courses".
# If unset, every folder mounted into the container (your NAS shares) becomes a library.
_libs = os.environ.get("EDUNEST_LIBRARIES") or os.environ.get("EDUNEST_MEDIA_DIR") or ""
SEED_LIBRARIES = [str(Path(p.strip()).resolve()) for p in _libs.replace("\n", ";").split(";") if p.strip()]
# Folder picker in Settings: opens at BROWSE_START (where NAS shares are usually mounted),
# and can navigate up to BROWSE_ROOT. Container paths only.
BROWSE_ROOT = Path(os.environ.get("EDUNEST_BROWSE_ROOT", "/")).resolve()
BROWSE_START = Path(os.environ.get("EDUNEST_BROWSE_START", "/media")).resolve()
DATA_DIR = Path(os.environ.get("EDUNEST_DATA_DIR", "/data")).resolve()
STATIC_DIR = Path(os.environ.get("EDUNEST_STATIC_DIR", Path(__file__).parent.parent / "static")).resolve()

DB_PATH = DATA_DIR / "edunest.db"
THUMBS_DIR = DATA_DIR / "thumbs"

SCAN_ON_STARTUP = os.environ.get("EDUNEST_SCAN_ON_STARTUP", "1") not in ("0", "false", "no")
# Rescan libraries every N minutes to pick up new downloads (0 = off). Unchanged files are skipped, so it's cheap.
SCAN_INTERVAL_MIN = float(os.environ.get("EDUNEST_SCAN_INTERVAL_MIN", "15") or 0)

VIDEO_EXTS = {".mp4", ".m4v", ".webm", ".mov", ".mkv", ".avi", ".wmv", ".flv", ".ts"}
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
SUBTITLE_EXTS = (".vtt", ".srt")
COVER_NAMES = ("cover", "folder", "poster", "thumbnail")

# A lesson counts as completed once this fraction has been watched.
COMPLETE_RATIO = 0.9

for d in (DATA_DIR, THUMBS_DIR):
    d.mkdir(parents=True, exist_ok=True)
