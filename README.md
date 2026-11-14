# EduNest

An open-source, self-hosted learning app for your NAS or home server. It turns folders of educational videos into YouTube/Udemy-style courses, with **timestamped notes** that take you back to the exact moment in the video.

- Folders become courses, sub-folders become sections, and videos become lessons. Sorting is natural, so `2` comes before `10`.
- **Notes:** press `N` and the video pauses at the current moment. Notes are written in Markdown and support LaTeX math. They appear as markers on the seek bar, and clicking one jumps to that moment. Each course has an "All notes" page, notes are full-text searchable, and they export to Markdown with deep links.
- **Progress:** each lesson resumes where you left off and is auto-completed at 90% watched. The home page has a *Continue watching* row.
- **Metadata:** read from yt-dlp `.info.json` files, embedded tags, or the filename. That includes YouTube **chapters**, which show on the seek bar. Thumbnails come from sidecar images, embedded covers, or an auto-generated frame.
- `.srt` and `.vtt` subtitles next to a video are picked up automatically.
- **Multiple library folders** are managed in **Settings**. Each one is either a *folder of courses* or a *single course*.
- Renamed or moved files keep their notes and progress, because files are matched by fingerprint.
- Video folders are mounted read-only, so the app never writes to them.

## Deploy on a NAS (tested with UGREEN; any Docker host works)

1. **Build the image** on your Mac. UGREEN NASes are x86_64, so build for `linux/amd64`:
   ```bash
   make save            # → edunest-latest.tar
   ```
   Copy the `.tar` to the NAS and import it in **Docker → Image → Import**. If you prefer a registry, use `make push IMAGE=ghcr.io/<you>/edunest` instead.
2. **Create a Project** in the Docker app and paste [docker-compose.yml](docker-compose.yml). Edit the volume lines so each NAS folder with videos is mounted under `/media/...`, and set `PUID`/`PGID` to your NAS user (run `id` over SSH to find them).
3. Open `http://<nas-ip>:8090`. On first start, each mounted folder is added as a library and scanned. Check **Settings** to switch any of them between *Folder of courses* and *Single course*.

Everything you create (notes and progress) lives in the `/data` volume (`edunest.db`), so include that folder in your NAS backups.

### Adding another video folder later
1. Add a volume line to the compose file, e.g. `- /volume2/New Courses:/media/new:ro`.
2. Redeploy the project.
3. In the app, go to **Settings → Add folder** and click the new folder under *Folders mounted into the container*.

### Folder layout

```
/media/deep-learning/            ← library ("Folder of courses")
├── CS231n/                      ← course
│   ├── cover.jpg                ← optional course cover (also folder.jpg / poster.jpg)
│   ├── 01 - Intro/              ← section
│   │   ├── 01 Welcome.mp4       ← lesson
│   │   ├── 01 Welcome.en.srt    ← optional subtitles
│   │   └── 01 Welcome.info.json ← optional yt-dlp metadata (title, description, chapters)
│   └── 02 - CNNs/ ...
└── Karpathy Zero to Hero/ ...
```

To get the best metadata for YouTube downloads, use yt-dlp with:
```bash
yt-dlp --write-info-json --write-thumbnail --embed-chapters --embed-metadata <url>
```

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `EDUNEST_LIBRARIES` | *(every mounted folder)* | Library folders to create on **first start**, separated by `;`. After that, manage them in Settings. |
| `EDUNEST_BROWSE_START` | `/media` | Folder the Settings folder picker opens at |
| `PUID` / `PGID` | `1000` | User and group that own the files in `/data` |
| `PORT` | `8080` | Port inside the container |
| `EDUNEST_BROWSE_ROOT` | `/` | Top folder shown in the Settings folder picker |
| `EDUNEST_SCAN_ON_STARTUP` | `1` | Rescan the libraries when the container starts |
| `EDUNEST_SCAN_INTERVAL_MIN` | `15` | Rescan every N minutes to pick up new downloads (`0` = off) |

## Local development

```bash
make sample          # generate fake course videos in ./sample-media (uses Docker)
make dev-backend     # FastAPI on :18777 (terminal 1)
make dev-frontend    # Vite on :5173, proxies /api (terminal 2)
make run             # or: build the real image and run it on http://localhost:8090
```

The stack is FastAPI with SQLite (including FTS5 full-text search) for the backend, and React, Vite and Tailwind for the frontend. ffmpeg and ffprobe are only needed for thumbnails and durations, and they're included in the image.

## Keyboard shortcuts (watch page)

| Key | Action |
|---|---|
| `N` | Add a note at the current time |
| `Space` / `K` | Play / pause |
| `←` `→` | Seek ±5 s |
| `J` `L` | Seek ±10 s |
| `<` `>` | Change speed |
| `F` | Fullscreen |
| `C` | Subtitles |
| `M` | Mute |
| `0`–`9` | Jump to 0–90% |
| `Shift+N` / `Shift+P` | Next / previous lesson |

## Contributing

Issues and pull requests are welcome. For local setup, see [Local development](#local-development).

## License

[MIT](LICENSE)
