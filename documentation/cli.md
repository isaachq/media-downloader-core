# Command line: `mdc`

Back to the [README](../README.md).


```bash
npm install -g media-downloader-core     # or: npx mdc …
mdc setup                                # install + verify yt-dlp and ffmpeg (SHA-256, codec check)
mdc doctor                               # tools, versions, codecs, data folder, free space
mdc info  "https://youtube.com/playlist?list=…"
mdc get   "https://youtube.com/playlist?list=…" -f m4a -i 1-20 -o ~/Music
mdc get   "https://youtu.be/…" -f mp4 -q 1080
mdc logs  <id>                           # replay a session / job / attempt / step from the trace logs
mdc verify                               # re-hash every archived file
mdc sync add @name --folder ~/TikTok-name --daily 08:00   # keep an account in step with a folder
mdc sync run --due                       # the syncs whose time has come (cron, launchd, Task Scheduler)
```

A live dashboard shows each job's progress, speed, retries and sub-task
track (`D✓ C– V▸ F·` = download, convert, validate, finalize). `--json`
streams NDJSON for scripts. Exit codes: 0 ok · 1 some downloads failed ·
2 usage · 3 environment not ready · 130 interrupted (partial downloads are
kept and resume next time).

The CLI and the desktop app share one data folder (tools, archive, logs):
`~/Library/Application Support/Media Download Core` (macOS),
`%APPDATA%\Media Download Core` (Windows), `~/.config/Media Download Core` (Linux).

## Setup sources

| Tool | Source | Verification |
|---|---|---|
| yt-dlp | official GitHub releases (onedir builds) | `SHA2-256SUMS` of the release |
| ffmpeg / ffprobe — macOS | Martin Riedl static builds (arm64, x64) | per-file `.sha256` |
| ffmpeg / ffprobe — Windows, Linux | BtbN static GPL builds (latest stable) | `checksums.sha256` of the release |

After extraction every binary must run and ffmpeg must provide the encoders,
decoders and muxers the profiles need (libx264, libvpx-vp9, libopus,
libmp3lame, AV1 decoding…), or the install is rejected and nothing changes.
