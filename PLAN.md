# EduNest: self-hosted learning app for the UGREEN NAS

A small, self-hosted "Udemy/Coursera for my own video folders". It works like Jellyfin: it reads local folders and needs no uploads. Unlike Jellyfin, it's built around **learning**: courses, progress tracking, and **timestamped notes** that jump back to the exact moment in the video.

---

## 1. Scope

### In scope (v1)
- Scan the mounted video folders. Each top-level folder becomes a **course** (playlist), subfolders become **sections**, and video files become **lessons**.
- A YouTube-style home page: a course grid with thumbnails and a **Continue watching** row.
- A Udemy-style course player: the video on the left and a curriculum sidebar on the right, with a checkmark on each completed lesson.
- **Timestamped notes** (the main feature):
  - Press `N` (or click "Add note"). The video pauses, the current time is captured, and you type the note in Markdown.
  - Notes sit in a panel beside the video. Clicking a note's timestamp seeks to that moment.
  - Notes show up as **markers on the seek bar**.
  - A course-level "All notes" view, grouped by lesson. Clicking a note opens that lesson at that second.
  - Global search across all notes.
  - Export a course's notes to Markdown, with deep links like `/watch/<id>?t=754`.
- Remember the playback position for every lesson. A lesson is automatically marked complete at about 90% watched.
- Learning-friendly player: playback speed (0.5×–2.5×), keyboard shortcuts (space, ←/→ ±5s, J/L ±10s, N for a note, F for fullscreen), and existing `.srt`/`.vtt` subtitle files shown when present (this is cheap to support).
- A manual **Rescan library** button, plus a scan on startup.

### Out of scope for now (designed so they can be added later)
- Transcripts / Whisper
- AI summary and chatbot
- Multi-user accounts
- On-the-fly transcoding

---

## 2. Architecture

```
┌──────────────────────── Docker container (UGREEN) ─────────────────────────┐
│                                                                            │
│  React SPA (static, built at image build time)                             │
│        │  REST/JSON + video byte-range streaming                           │
│  FastAPI backend (Python)                                                  │
│    ├── Library scanner  ── ffprobe (duration) / ffmpeg (thumbnails)        │
│    ├── Video streaming  ── HTTP Range requests (seek works instantly)      │
│    ├── Notes / Progress API                                                │
│    └── SQLite (FTS5 for note search)                                       │
│                                                                            │
│  Volumes:  /media  ← your course folders (read-only)                       │
│            /data   ← SQLite DB + generated thumbnails (persistent)         │
└────────────────────────────────────────────────────────────────────────────┘
```

### Stack choices and reasons
| Layer | Choice | Why |
|---|---|---|
| Backend | **Python 3.12 + FastAPI** | Simple and fast. It also puts Whisper and LLM features in the same language if you add them later. |
| DB | **SQLite** (SQLAlchemy + Alembic migrations) | One file, no extra container, plenty for a single user. FTS5 provides full-text search over notes. |
| Frontend | **React + TypeScript + Vite + Tailwind** | A rich player and notes UI. Builds to static files served by FastAPI. |
| Player | Native `<video>` element with custom controls (or **Plyr**) | Full control over seek-bar note markers and keyboard shortcuts. |
| Notes editor | Markdown textarea with a live preview (`react-markdown`, KaTeX for math) | Math formulas matter for ML/DL notes. |
| Media tools | `ffmpeg` / `ffprobe` installed in the image | Thumbnails and durations. |
| Packaging | A single multi-stage Docker image plus `docker-compose.yml` | The UGREEN Docker app supports Compose "Projects". |

---

## 3. Library model (how folders map to courses)

**Multiple library folders** are configured in the app (Settings → Library folders) and stored in the DB. `EDUNEST_LIBRARIES` seeds them on first start. Each NAS share is mounted into the container under `/media/<name>`. There are two library modes:
- **Folder of courses:** each sub-folder becomes a course.
- **Single course:** the folder itself is one course.

Libraries can't be nested. Removing a library keeps notes and progress, and they come back if you re-add it.

```
/media/
├── Deep Learning/               → Course
│   ├── cover.jpg                → optional course cover (else auto thumbnail)
│   ├── 01 - Basics/             → Section
│   │   ├── 01 Intro.mp4         → Lesson
│   │   ├── 01 Intro.srt         → subtitles (optional)
│   │   └── 02 Perceptron.mp4
│   └── 02 - CNNs/ ...
├── ML Systems/ ...
└── NLP/ ...
```

- **Natural sort**, so `2 Intro` comes before `10 Outro`.
- Titles are cleaned up: leading numbers and extensions are stripped, and `_`/`.` become spaces.
- Supported formats: `.mp4 .m4v .webm .mov .mkv`. **Caveat:** browsers only play H.264/H.265(Safari)/VP9/AV1 video with AAC/Opus audio. MKV files with H.264+AAC usually play in Chrome. Files that won't play are flagged in the UI (see §8).
- **Stable identity:** each lesson is keyed by a fingerprint (file size + hash of the first and last 1 MB) as well as its relative path. If you rename or move a file, the rescan re-links it, so **your notes and progress aren't lost**.

### 3.1 Metadata and thumbnails

The scanner tries each source below in priority order. A higher source wins field by field, so you can still get a description from YouTube while keeping your own title. Nothing is ever written to `/media`. Everything fetched or generated goes into `/data` (the DB plus a `thumbs/` cache).

| Priority | Source | What it gives | Cost |
|---|---|---|---|
| 1 | **Manual edits in the UI** | Anything you override (title, cover, description) | — |
| 2 | **Local sidecar files** next to the video: `cover.jpg`/`folder.jpg`, `<video>.jpg/.webp`, yt-dlp's `<video>.info.json`, `<video>.description`, and a playlist-level `*.info.json` in the course folder | Title, description, channel, upload date, thumbnail, **chapters**, tags | Offline, instant |
| 3 | **Embedded tags inside the file**, read with `ffprobe` (yt-dlp `--embed-metadata --embed-thumbnail --embed-chapters` stores these inside the MP4/MKV) | Title, description, cover art, **chapters** | Offline, instant |
| 4 | **YouTube lookup, opt-in.** It needs a YouTube video ID, from the filename (yt-dlp's default `Title [dQw4w9WgXcQ].mp4`), from the info.json, or from a URL you paste on a course or lesson. Fetched with `yt-dlp --skip-download --dump-json` (no API key). A course can be linked to a **playlist URL**: the app fetches the playlist and matches its entries to files by ID, then fuzzy title, then order. | Same as sidecars, plus the high-res thumbnail and playlist title/description | Network, cached forever |
| 5 | **Generated fallback** | `ffprobe` duration/resolution/codec. A thumbnail grabbed by `ffmpeg` at about 10% into the video (skips black intros). The course cover is the first lesson's thumbnail. The title is the cleaned-up filename. | Offline, once per file |

**YouTube chapters** are the big win for learning. They show as named segments on the seek bar and as a clickable chapter list next to the notes.

There is no blind search by title. Guessing "which YouTube video is `03 Backprop.mp4`?" goes wrong too often. Lookups only happen from a known ID or a URL you link yourself.

---

## 4. Data model (SQLite)

```
course    (id, rel_path, title, cover_path, created_at, updated_at)
section   (id, course_id, rel_path, title, sort_key)
lesson    (id, course_id, section_id, rel_path, title, sort_key,
           duration_s, size_bytes, mtime, fingerprint, subtitle_path,
           playable BOOL, missing BOOL,
           youtube_id, description, channel, upload_date, thumb_path,
           meta_source, meta_overrides JSON)
chapter   (id, lesson_id, start_s, end_s, title)
progress  (lesson_id PK, position_s, completed BOOL, last_watched_at)
note      (id, lesson_id, timestamp_s, body_md, color/tag, created_at, updated_at)
note_fts  (FTS5 virtual table over note.body_md)
```

When files disappear, rows are kept and marked `missing`, so notes are never deleted by a rescan.

---

## 5. API sketch

```
GET    /api/courses                       list + progress %
GET    /api/courses/{id}                  sections + lessons + progress
GET    /api/lessons/{id}                  metadata, prev/next lesson
GET    /api/lessons/{id}/stream           video bytes (Range support)
GET    /api/lessons/{id}/subtitles        .srt → converted to WebVTT
GET    /api/thumbs/{lesson|course}/{id}   generated jpg
PUT    /api/progress/{lessonId}           {position_s, completed}   (throttled ~every 10s + on pause/close)
GET    /api/continue-watching
GET    /api/lessons/{id}/notes
POST   /api/lessons/{id}/notes            {timestamp_s, body_md}
PATCH  /api/notes/{id}   DELETE /api/notes/{id}
GET    /api/courses/{id}/notes            all notes in course
GET    /api/notes/search?q=
GET    /api/courses/{id}/notes/export.md
POST   /api/library/rescan                background job; GET /api/library/status
```

---

## 6. UI / UX

**Home (YouTube-like)**
- A **Continue watching** row (lesson thumbnail plus a red progress bar).
- **Courses** grid: cover, title, lesson count, total duration, and % complete.
- Top bar: search over courses, lessons, and notes.

**Course page (Udemy-like)**
- A header with the cover, a progress ring, and a "Resume" button.
- Collapsible sections showing lessons with duration, a ✓ when completed, and a 📝 count of notes.
- An "All notes" tab.

**Watch page (the core)**
```
┌───────────────────────────────────────────┬──────────────────────┐
│                                           │ [Curriculum] [Notes] │
│              VIDEO                        │                      │
│                                           │  ▸ 03:12  Backprop = │
│  ──●───|────|──────|────────── (markers)  │    chain rule…       │
│  ▶  1.5×  CC  ⛶                           │  ▸ 12:34  Vanishing  │
├───────────────────────────────────────────┤    gradient ...      │
│ [+ Add note at 14:02]  (press N)          │                      │
│ ┌───────────────────────────────────────┐ │                      │
│ │ markdown editor …           [Save]    │ │                      │
│ └───────────────────────────────────────┘ │                      │
└───────────────────────────────────────────┴──────────────────────┘
```
- Adding a note pauses the video. Saving resumes it (configurable).
- The note being typed stays tied to the time captured when you started typing.
- Hovering a seek-bar marker shows a preview of the note. Clicking it seeks.
- The note panel auto-highlights the note closest to the current playback time.
- Deep links: `/watch/<lessonId>?t=754` open at that second.
- "Next lesson" autoplay countdown at the end of a lesson.
- Dark mode by default.

---

## 7. Build and deploy on the UGREEN NAS

**Dockerfile (multi-stage)**
1. `node:20-alpine`: `npm ci && npm run build` builds the frontend into `/dist`.
2. `python:3.12-slim` + `apt install ffmpeg`: install the backend, copy `/dist` in, then run `uvicorn` on port `8080` as a non-root user (PUID/PGID env vars, like other NAS apps).

**Build for the NAS CPU.** UGREEN DXP models are x86_64:
```bash
docker buildx build --platform linux/amd64 -t edunest:latest .
```
There are two ways to get the image onto the NAS:
- **A.** Push to Docker Hub or GHCR (a private repo is fine), then pull it in the UGREEN Docker app.
- **B.** No registry: run `docker save edunest:latest -o edunest.tar`, copy it to the NAS share, and import it in the Docker app (Image → Import).

**docker-compose.yml** (pasted as a UGREEN Docker "Project"):
```yaml
services:
  edunest:
    image: edunest:latest
    container_name: edunest
    ports: ["8090:8080"]
    environment:
      - PUID=1000
      - PGID=10
      - TZ=Etc/UTC
    volumes:
      - /volume1/Videos/Education:/media:ro
      - /volume1/docker/edunest:/data
    restart: unless-stopped
```
The `:ro` mount means the app can never modify or delete your videos.

A `Makefile` / `scripts/release.sh` handles build → tag → push (or save to tar) in one command. GitHub Actions for automatic image builds is optional.

**Backup:** everything you create (notes and progress) lives in `/data/edunest.db`, so include that folder in your UGREEN backup. The Markdown export doubles as a human-readable backup.

---

## 8. Risks and mitigations
| Risk | Mitigation |
|---|---|
| Some files (e.g. old AVI, HEVC in Chrome) won't play in the browser | v1 flags them as "unsupported codec" in the UI. v1.x adds an optional background **remux/transcode to MP4** job (ffmpeg). Pass `/dev/dri` to the container for Intel QuickSync hardware acceleration. |
| First scan of a big library is slow (ffprobe plus thumbnails) | Scan in the background, generate thumbnails lazily and cache them, and do incremental rescans (skip files with an unchanged mtime/size). |
| Renamed or moved files orphan notes | Fingerprint-based re-linking (§3). |
| Exposure outside the LAN | v1 assumes LAN/VPN only (e.g. Tailscale). An optional single password via `APP_PASSWORD` env var can be added for basic protection. |

---

## 9. Milestones

| # | Milestone | Deliverable |
|---|---|---|
| **M0** | Project skeleton | Repo layout (`backend/`, `frontend/`), Dockerfile, compose file, and a dev setup that runs locally against a sample folder on the Mac |
| **M1** | Library and playback | Scanner, course/lesson API, Range streaming, home grid, course page, basic player |
| **M2** | Progress | Resume position, auto-complete, Continue watching, course % complete |
| **M3** | **Notes** ⭐ | Timestamped notes CRUD, seek-on-click, seek-bar markers, `N` shortcut, Markdown + math, deep links |
| **M4** | Notes power features | Course "All notes" view, global search (FTS5), Markdown export |
| **M5** | Polish and deploy | Thumbnails, subtitles, speed and shortcuts, dark mode, mobile/tablet layout, build to NAS, docs |
| *Later* | Extensions | Transcoding, Whisper transcripts (they slot in as a `transcript` table plus a background worker), AI summary/chat per lesson, bookmarks without text, spaced-repetition flashcards from notes |

---

## 10. Open decisions (defaults in **bold**)
0. ✅ v1 draft built: see README.md. SQLite is accessed directly (no SQLAlchemy) and migrations are versioned with `PRAGMA user_version`. The YouTube online lookup (§3.1 #4) isn't built yet.
1. Single user or several profiles (family members with separate notes and progress)? **Single user**. The schema can add a `user_id` later.
2. Login? **None (LAN only)**, with an optional password env var.
3. Stack: **FastAPI + React**. The alternative is a Node/TypeScript backend.
4. Image delivery: **Docker Hub/GHCR**, or a tar import.
5. How are the course folders actually laid out on the NAS (depth, file types)? Look at a sample before writing the scanner.
