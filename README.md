# EduNest

An open-source, self-hosted learning app for your NAS or home server. It turns folders of educational videos into YouTube/Udemy-style courses, with **timestamped notes** that take you back to the exact moment in the video.

- Folders become courses, sub-folders become sections, and videos become lessons. Sorting is natural, so `2` comes before `10`.
- **Notes:** press `N` and the video pauses at the current moment. Notes are written in Markdown and support LaTeX math. They appear as markers on the seek bar, and clicking one jumps to that moment. Each course has an "All notes" page, notes are full-text searchable, and they export to Markdown with deep links.
- **Progress:** each lesson resumes where you left off and is auto-completed at 90% watched. The home page has a *Continue watching* row; remove a course from it with the × on its card, or empty it with *Clear all*. Your progress is kept, and a course comes back once you watch it again.
- **Metadata:** read from yt-dlp `.info.json` files, embedded tags, or the filename. That includes YouTube **chapters**, which show on the seek bar. Thumbnails come from sidecar images, embedded covers, or an auto-generated frame.
- `.srt` and `.vtt` subtitles next to a video are picked up automatically.
- **Transcripts and subtitles** for every video (optional): a searchable *Transcript* tab that follows the video, and an extra track in the CC menu. They come from subtitle files, YouTube captions, or speech-to-text on the NAS. See [Transcripts](#transcripts-optional).
- **Summary and study notes** (optional, needs an OpenRouter API key): a *Summary* tab with a short overview of the video and detailed study notes, always in English, with timestamps that jump to the moment. *Save to my notes* turns the study notes into your own timestamped notes. Non-English videos can also get **English subtitles**, translated line by line. See [Summaries and study notes](#summaries-and-study-notes-optional).
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

### Your data

Everything EduNest stores lives in the `/data` volume:

- `edunest.db` is a SQLite database with users added in Settings, course access, each user's progress and notes, and the security log.
- `secret.key` is used to keep logins stable across restarts.
- `thumbs/` holds generated thumbnails.

Every change is written to disk (`synchronous=FULL`) before the app replies, so a crash, a container restart, an image update or a power cut doesn't lose saved notes or progress. At most the last few seconds of the playback position can be lost. **Include the `/data` folder in your NAS backups.** Your video folders are mounted read-only and are never modified.

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

## Transcripts (optional)

Transcripts are made by **[Lectern](https://github.com/vijayliebe/lectern)**, a separate open-source service that runs as a second container in the same compose project. It tries, in order:
1. a subtitle file next to the video,
2. YouTube captions: the YouTube id comes from the `.info.json` file, or from a search by title that only accepts a video of the same length,
3. speech-to-text on the NAS (faster-whisper), for everything else. On an Intel i3 this takes very roughly as long as the video itself with the `small` model, so it runs slowly in the background, one video at a time.

YouTube is asked carefully: one request at a time, 10–30 s apart, with a pause of an hour or more if YouTube ever pushes back. Each video is fetched only once.

**To turn it on**
1. Build and import the Lectern image too: `git clone git@github.com:vijayliebe/lectern.git ../lectern`, then `make lectern-save` → `lectern-latest.tar`.
2. Use the `lectern` service from [docker-compose.yml](docker-compose.yml). Mount the **same folders at the same paths** as in EduNest, and set the same random key in `LECTERN_API_KEY` and `EDUNEST_AI_KEY` (`openssl rand -hex 24`).
3. After the next scan, every video is queued. **Settings → Transcripts** shows progress. On the watch page, admins can ask for a video to be looked up again or transcribed from its audio.

**MeTube settings, recommended:** add these options to MeTube's `YTDL_OPTIONS` so new downloads come with their YouTube id and English captions, and no YouTube lookups are needed later. Keep any options you already have in the same JSON object, e.g. with a cookie file:
```yaml
    environment:
      YTDL_OPTIONS: '{"cookiefile": "/cookies/cookies.txt", "writeinfojson": true, "writesubtitles": true, "writeautomaticsub": true, "subtitleslangs": ["en-orig"], "subtitlesformat": "vtt"}'
```
Only the untranslated English track (`en-orig`) is requested on purpose. A failed subtitle download makes yt-dlp fail the whole video, and translated tracks are what YouTube rate-limits. Captions for other languages are fetched later by Lectern, one at a time.

**YouTube cookies (optional):** if Settings → Transcripts says YouTube keeps pausing Lectern, mount MeTube's cookie folder into Lectern read-only and set `LECTERN_YT_COOKIES` (see the commented lines in the compose file). Lectern uses its own copy, because yt-dlp rewrites the cookie file after every use. Requests are then tied to that Google account, which is why it's off by default.

## Summaries and study notes (optional)

With an LLM API key (OpenRouter by default), Lectern also writes, from each video's transcript and always in English, whatever language the video is in (Hindi included):
- a **summary**: what the video covers, its key points and an outline, each linked to its moment in the video;
- **study notes**: the video part by part, with explanations, definitions, formulas and examples, and review questions at the end. *Save to my notes* adds each part to your own notes, at its moment in the video;
- **English subtitles** for a non-English video: the *Translate to English* button in the Transcript tab adds an "English · translated" track to the CC menu and an Original/English switch to the transcript.

Each is made when someone first asks for it (it takes up to a few minutes), once per video, and is then shared by everyone who can see that course. They're made again only if the transcript changes, or if an admin clicks *Write again*.

**To turn it on**, add your OpenRouter key to the `lectern` service in the compose file (`OPENROUTER_API_KEY=...`, from openrouter.ai/keys) and redeploy. The default model is Claude Opus 5.5 (`anthropic/claude-opus-5.5`); set `LECTERN_LLM_MODEL` to use any other model OpenRouter offers. To use the Anthropic API directly instead, set `ANTHROPIC_API_KEY` and leave `OPENROUTER_API_KEY` empty. To let only admins ask for new ones, set `EDUNEST_AI_GENERATE=admins` in EduNest. Everyone can still read the ones that exist.

**Cost and privacy:** only the transcript and the video's title are sent to the LLM provider (OpenRouter, which passes them to the model's maker), never the video, and only when someone asks. With the default model (Claude Opus 5.5) a 1-hour lecture costs roughly 10 cents for a summary, 15–25 cents for study notes and 30–40 cents for a translation. Admins see the tokens used under each one. The text is written by AI and can contain mistakes.

## Chat with a video (optional)

The **AI** tab's *Chat* lets you ask questions about the video you're watching, with the same Lectern setup and key as summaries. The model reads the video's whole transcript, so it works for videos in any language (Hindi included); it answers in English, or in the language you write in. Answers stream in as they're written and link to the moments in the video. With *Include my position in the video* on, you can ask about "this part".

- Each user's chat is private, kept per video, and can be cleared with *Clear chat*.
- To keep a public instance from running up the bill, non-admin users can ask at most `EDUNEST_AI_CHAT_PER_HOUR` questions an hour (default 60). `EDUNEST_AI_CHAT=admins` limits chat to admins; `off` turns it off.

## Login and security

Everything requires a login: pages show only the sign-in screen, and every API call, video stream, thumbnail and subtitle answers `401` without a valid session.

- **Users are set only in `docker-compose.yml`** (`EDUNEST_USERS`). There is no sign-up page, no default account and no option to turn the login off. With no users configured, nobody can sign in. The container refuses to start if a user still has the example password from this repository.
- **Passwords:** plain passwords (minimum 8 characters) are hashed with scrypt when the container starts. To keep them out of the compose file, store a hash instead:
  ```bash
  docker run --rm -it edunest:latest hash-password
  ```
  Paste the output as `username:scrypt:…`. Alternatively, point `EDUNEST_USERS_FILE` at a file with one `username:password` per line, e.g. a Docker secret.
- **Sessions:** random 256-bit tokens in an `HttpOnly`, `SameSite=Lax` cookie, which is `Secure` over HTTPS. The database stores only their SHA-256 hash. Changing a user's password or removing the user (and restarting the container) signs that user out everywhere.
- **Brute force:** after 5 failed logins, each further attempt for that username or IP address must wait exponentially longer, up to 15 minutes.
- **Admins vs. users:** only users in `EDUNEST_ADMINS` (default: every compose user) can change Settings, rescan, browse folders, manage users or see the security log.
- **More users from the app:** admins can add regular users with a username and password under **Settings → Users & access**, and reset their password or delete them. Admins can only be defined in docker-compose, so no one can make themselves an admin from inside the app. Every user change is recorded in the security log.
- **Per-user data:** progress, completed lessons, *Continue watching*, notes, note search and note export belong to each user. Nobody, not even an admin, sees another user's notes.
- **Course access:** admins see every course. For each other user, an admin picks **All courses** or **Selected courses only**. A new user sees nothing until access is granted. Courses a user can't see behave as if they don't exist (`404`), including their videos, thumbnails and search results.
- **Upgrading from a version without per-user data:** existing progress and notes are assigned to the first admin listed in `EDUNEST_USERS`.
- **Security log** (Settings → Security): failed and blocked logins, requests made without a login, non-admins trying admin pages, cross-site requests, and successful logins. When something keeps happening, admins see a red **Suspicious activity** badge in the header.

> **Before exposing EduNest to the internet, put it behind HTTPS**, e.g. a reverse proxy with a certificate, a Cloudflare Tunnel, or Tailscale. Over plain HTTP, passwords and session cookies can be read by anyone on the network path.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `EDUNEST_USERS` | — (required) | `user:password` or `user:scrypt:…` entries, separated by commas |
| `EDUNEST_USERS_FILE` | — | File with one `user:password` per line (e.g. a Docker secret) |
| `EDUNEST_ADMINS` | all users | Comma-separated usernames allowed to manage Settings and see the security log |
| `EDUNEST_SESSION_DAYS` | `30` | How long a login stays valid |
| `EDUNEST_COOKIE_SECURE` | `auto` | `auto` = Secure cookie when the request arrived over HTTPS; `true` forces it |
| `EDUNEST_TRUSTED_PROXIES` | private ranges | Reverse proxies allowed to set `X-Forwarded-For` (comma-separated IPs/CIDRs) |
| `EDUNEST_LIBRARIES` | *(every mounted folder)* | Library folders to create on **first start**, separated by `;`. After that, manage them in Settings. |
| `EDUNEST_AI_URL` | — | Address of the Lectern service, e.g. `http://lectern:8000`. Unset = no transcripts. |
| `EDUNEST_AI_KEY` | — | Same value as Lectern's `LECTERN_API_KEY` |
| `EDUNEST_AI_GENERATE` | `everyone` | Who may ask for a new summary, study notes or translation: `everyone` or `admins` |
| `EDUNEST_AI_CHAT` | `everyone` | Who may chat with videos: `everyone`, `admins` or `off` |
| `EDUNEST_AI_CHAT_PER_HOUR` | `60` | Chat questions per hour for each non-admin user |
| `EDUNEST_BROWSE_START` | `/media` | Folder the Settings folder picker opens at |
| `PUID` / `PGID` | `1000` | User and group that own the files in `/data` |
| `PORT` | `8080` | Port inside the container |
| `EDUNEST_BROWSE_ROOT` | `/` | Top folder shown in the Settings folder picker |
| `EDUNEST_SCAN_ON_STARTUP` | `1` | Rescan the libraries when the container starts |
| `EDUNEST_SCAN_INTERVAL_MIN` | `15` | Rescan every N minutes to pick up new downloads (`0` = off) |

## Local development

```bash
make sample          # generate fake course videos in ./sample-media (uses Docker)
make dev-backend     # FastAPI on :18777 (terminal 1); prints a random login for user 'dev'
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
