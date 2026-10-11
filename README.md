# media-downloader-core

**A download engine built for heavy workloads — not one video, many:**
playlists with thousands of items, batches queued back to back, hours of
unattended backup. Every hot path is O(1) or O(n) by design, work runs on a
⌊CPUs/2⌋ pool of processes and threads so the machine stays responsive,
memory stays flat, and **every file is validated** before it's delivered.

UI-agnostic — drive it from the `mdc` CLI, the [desktop app](#desktop-app-beta),
an Electron main process or a server. Zero runtime dependencies: it
orchestrates `yt-dlp`, `ffmpeg` and `ffprobe`, and installs/verifies them
itself (`mdc setup`).

> **Educational project.** It is meant for learning and for backing up content
> you own or are allowed to download. Respect each site's terms of service and
> copyright law; you are responsible for how you use it.

```ts
import {MediaDownloader} from 'media-downloader-core'

await using dl = new MediaDownloader({dataDir: '/path/to/app-data'})
dl.on('job', job => console.log(job.status, job.progress.fraction))

const result = await dl.analyze('https://www.youtube.com/playlist?list=…')
if (result.kind === 'playlist') dl.addPlaylist(result, {kind: 'audio', container: 'm4a'}, '/Users/me/Music')
await dl.whenIdle()
```

## Desktop app (beta)

[`app/`](app) is a desktop front end for macOS and Windows: Electron, React and
[Ant Design](https://ant.design). Paste a video or playlist link, pick a format
and a quality, and the batch is checked, forecast for disk space, downloaded on
the ⌊CPUs/2⌋ pool and verified file by file.

![Paste a link, download it as MP4, check its integrity report](docs/demo.gif)

### What's new in beta 4

- **TikTok behind its verification page** — when TikTok answers with its "please wait" check (yt-dlp can't get past it either), the app opens the page in its own hidden, sandboxed browser, where the check passes by itself, and carries on over plain HTTP with that session. Nothing is solved by our code; a captcha still hands TikTok to yt-dlp.
- **Progress while a link is read** — a long profile or playlist shows how far the listing has got ("150 of 500 items") and can be cancelled.
- **Faster second looks** — a profile listed in the last 15 minutes reopens instantly, and asking for more continues where the listing stopped; a listing that comes back short gets a second pass.
- **The first update you don't install by hand** — beta 3 shows a banner for beta 4: one button and the app updates itself.

### In beta 3

- **TikTok, built in** — paste a video, a short link (`vm.tiktok.com/…`) or a whole profile (`tiktok.com/@user`, up to 500 posts by default) and pick what to back up from the preview.
- **Car & USB friendly names** — `001-Cancion-Nandu-k1gsZ.mp3`: letters, numbers and hyphens only, and MP3 tags in ID3v2.3, the version car stereos read.
- **Updates inside the app** — a banner announces a new version; one button downloads it, checks it against GitHub's SHA-256, installs it and restarts.
- **Linux** — `.deb`, `.rpm` and AppImage for x64 and ARM; **Windows** setup survives antivirus locks; **macOS** builds are signed ad hoc so they run on Apple Silicon.
- Remembered window size, a start-up screen with retries, an estimated time left per batch, and the first language that matches your system (Spanish or English).

The full list is in the [changelog](CHANGELOG.md).

*A real run: paste a link → MP4 (H.264/AAC) → every frame decoded and checked → integrity report.*

| Preview of a YouTube Mix | Downloading, with the estimated time left |
| --- | --- |
| ![Pick what to download from a Mix](docs/screenshots/preview.png) | ![A running batch with its forecast and estimated time left](docs/screenshots/batch.png) |

![Dark theme in Spanish](docs/screenshots/home-dark-es.png)

### Installing

Download the installer for your system from the
[releases page](https://github.com/isaachq/media-downloader-core/releases).
On first launch the app installs yt-dlp and FFmpeg from their official sources
(checksum-verified). The betas are not signed with an Apple or Microsoft
certificate yet, so the system warns the first time; this is expected.

**macOS** (Apple Silicon and Intel) — `.dmg`

1. Open the `.dmg` and drag **Media Download Core** to **Applications**.
2. Open the app. macOS says *"Apple could not verify 'Media Download Core' is
   free of malware…"* — click **Done**.
3. Go to **System Settings → Privacy & Security** and click **"Open Anyway"**
   next to the message about Media Download Core. Confirm with your password.
4. From then on it opens normally.

> Right click → Open no longer skips this on macOS 15 and later. Alternative,
> in Terminal: `xattr -dr com.apple.quarantine "/Applications/Media Download Core.app"`

**Windows** (x64 and ARM) — `.exe`

1. Run the installer. If SmartScreen says *"Windows protected your PC"*, click
   **More info → Run anyway**.

**Linux** (x64 and arm64) — pick your distribution's package:

```bash
# Ubuntu / Debian            (ARM: …-linux-arm64.deb)
sudo apt install ./Media-Download-Core-<version>-linux-amd64.deb
# Fedora / RHEL / openSUSE    (ARM: …-linux-aarch64.rpm)
sudo dnf install ./Media-Download-Core-<version>-linux-x86_64.rpm
# then open it from the app menu, or
media-download-core
```

The `.deb` adds an AppArmor profile on Ubuntu 24.04+ so Chromium's sandbox
can run (24.04 restricts the user namespaces it needs). The `.AppImage` runs on
most other distributions (`chmod +x` it first; Fedora needs `sudo dnf install
fuse-libs` for it); on Ubuntu 24.04+ prefer the `.deb`.

Settings, tools and the download history live in `~/Library/Application Support/Media Download Core`
(macOS), `%APPDATA%\Media Download Core` (Windows) or `~/.config/Media Download Core` (Linux),
shared with the `mdc` command line.

### Updates

The app checks this project's releases at start-up and every 6 hours (Settings →
"Check for updates automatically"; About → "Check for updates" any time). When a
new version is out, one button downloads it in the background, verifies it and
restarts into it; running downloads continue after the restart.

| | Installs by |
| --- | --- |
| macOS | swapping the app bundle once the old one has quit, then reopening it (the app must be in a folder you can write to, e.g. Applications) |
| Windows | running the installer silently, which starts the new version |
| Linux AppImage | replacing the file, then starting it |
| Linux `.deb` / `.rpm` | the system package manager, through your desktop's password prompt |

Only files from this repository's releases are accepted, and only when their
size and SHA-256 match what GitHub publishes for them; on macOS the new bundle
must also be this app, at the offered version, with a valid signature.

### Features

- **Preview**: a playlist, YouTube Mix or channel opens a list of everything it holds first — filter, select all / some, or just the linked video — and only the picked items are downloaded. A Mix (an endless, auto-generated radio) loads its first 50 by default; load more from the preview.
- **Batches**: preflight (available / unavailable with the reason), disk forecast from real bitrates, progress weighted by size and the **estimated time left** — measured from this computer's real throughput, so you can start a big batch and walk away — plus paged item list, cancel, clear finished. New links queue behind the running batch.
- **Downloads**: one row per job with progress, speed, ETA, the D·C·V·F sub-tasks (failed / in-progress / success), retries and their reason.
- **Integrity**: the verdict of every file, with codecs, decoded vs expected duration and SHA-256 one click away.
- **Settings**: download folder, simultaneous downloads (capped at ⌊CPUs/2⌋), integrity level, long-video threshold, browser cookies, tags and cover art, notifications.
- **Logs**: live, every line with its batch / job / attempt / step ids (click one to trace it), plus tracing of any session / batch / job / attempt / step id.
- **Car & USB friendly names** (default): only letters, numbers and hyphens — `001-Cancion-Nandu-k1gsZ.mp3` — and MP3 tags in ID3v2.3, the version car stereos read. Switch it off in Settings to keep titles as they are.
- **Setup**: first launch installs yt-dlp and FFmpeg from their official sources, checksum-verified; the tools are shared with `mdc`.
- English and Spanish, light / dark / system theme, window size and position — all remembered.
- A start-up screen shows each phase; a failing phase is retried and, if it still fails, says why and resumes from there.

### Building from source

```bash
cd app
npm install
npm run dev        # development, hot reload
npm test           # UI tests (Vitest + Testing Library)
npm run test:e2e   # the real Electron app end to end (Playwright, fake tools)
npm run dist:mac   # dist/*.dmg + *.zip (arm64, x64)
npm run dist:win   # dist/*.exe installer (x64, arm64)
npm run dist:linux # dist/*.AppImage + *.deb + *.rpm (this machine's architecture; .rpm needs rpmbuild)
```

The interface is built with [Ant Design](https://github.com/ant-design/ant-design)
(MIT) — thank you to the Ant Design team for an excellent, free component library.

## Command line: `mdc`

```bash
npm install -g media-downloader-core     # or: npx mdc …
mdc setup                                # install + verify yt-dlp and ffmpeg (SHA-256, codec check)
mdc doctor                               # tools, versions, codecs, data folder, free space
mdc info  "https://youtube.com/playlist?list=…"
mdc get   "https://youtube.com/playlist?list=…" -f m4a -i 1-20 -o ~/Music
mdc get   "https://youtu.be/…" -f mp4 -q 1080
mdc logs  <id>                           # replay a session / job / attempt / step from the trace logs
mdc verify                               # re-hash every archived file
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

## Scheduling: schedule → batch → jobs

```ts
import {BatchScheduler, MediaDownloader} from 'media-downloader-core'

const engine = new MediaDownloader({dataDir})
const scheduler = new BatchScheduler(engine)        // maxActiveBatches: 1
await scheduler.restore()                           // batches pending at last shutdown
scheduler.on('batch', batch => render(batch))       // status, preflight, counts
scheduler.schedule({url, profile, outDir})          // never blocks — waits its turn
```

Submitting a url never blocks and never overloads the machine. Each url
becomes a **batch**; batches run one at a time (configurable) and each fans
out into jobs on the ⌊CPUs/2⌋ pool:

1. **checking** — the url is resolved and every item is checked in parallel
   (bounded by the same pool). The metadata fetched here is handed to the
   jobs, so nothing is extracted twice — downloads start immediately.
2. **running** — one job per downloadable item. Unavailable items are closed
   right away with a reason and an actionable hint (`private`, `removed`,
   `geo-blocked`, `needs-sign-in` → "use --cookies", …).
3. **closed** — `completed`, `completed-with-errors`, `failed` or
   `cancelled`, with a report of what couldn't be downloaded and why; then
   the next scheduled batch starts.

Before a job gives up it tries alternatives: fresh extraction for expired
links, and the best available format when the requested resolution doesn't
exist (`format-fallback`, recorded in its attempt history). Pending batches
are saved and resumed by `restore()` after a restart.

**Pick before downloading.** `engine.analyze(url, {maxEntries})` lists a
playlist without extracting each item; pass the entries the user picked as
`selection` and the batch downloads exactly those, without listing the url
again — stable even for lists that change between calls:

```ts
const list = await engine.analyze(url, {maxEntries: 200})
if (list.kind === 'playlist') {
  const picked = list.entries.filter(entry => wanted.has(entry.id))
  scheduler.schedule({url, profile, outDir, selection: {title: list.title, entries: picked}})
}
```

`maxItems` caps a list (listed by yt-dlp itself, so the rest is never fetched).
A **YouTube Mix** (`list=RD…`, see `isYouTubeMix()`) is an endless radio that
yt-dlp would paginate into the thousands, so it defaults to 50.

## TikTok (built-in extractor)

TikTok videos and whole profiles are read by the library itself, not by
yt-dlp — over plain HTTP, with the same pool, retries, conversion, integrity
checks and file naming as everything else:

```ts
scheduler.schedule({url: 'https://www.tiktok.com/@user', profile: {kind: 'audio', container: 'mp3'}, outDir})
scheduler.schedule({url: 'https://vm.tiktok.com/ZM…/', profile: {kind: 'video', container: 'mp4'}, outDir})
```

| | How |
| --- | --- |
| A post | Its public page: the data TikTok embeds for its own player. Media is fetched from the CDN with the same session's cookie and a TikTok Referer (the CDN refuses anything else). |
| A profile | The public listing (`creator/item_list`), walked backwards by date: de-duplicated by id, pinned posts don't move the cursor, a page that repeats itself gets a fresh identity, stalls step back a week instead of looping. Capped at **500 posts** by default (`maxItems`). |
| Encoding | MP4: **H.264 first** (car stereos, TVs, old phones), H.265 only as a fallback; MKV / WebM: highest resolution. Audio formats fetch the **smallest** encoding — the soundtrack is the same — and an encoding without sound is skipped. Sizes are exact (TikTok reports them), so the disk forecast is too. |
| Pace | One shared **Pacer** for tiktok.com: 2 requests at a time, ~1.5–2.5 s apart; a refusal (403 / 429 / empty answer) makes *every* request back off 30 s → 10 min. Media downloads aren't paced; conversions run on the ⌊CPUs/2⌋ pool. ~500 posts take roughly 20–40 minutes. |
| Verification pages | TikTok sometimes answers with a "please wait" check that only a browser passes. The library never solves it; a host that has a browser passes one in (`tiktok.browser`) — the desktop app uses a hidden, sandboxed Chromium window that loads no images or video — and the library adopts that session (cookies + user agent) so the listing and downloads continue over plain HTTP. Measured: a blocked profile opened in under a second against the local fake, and a real 1,022-post profile listed 500 posts in ~70 s. |
| Fallbacks | Without a browser, or when even the browser gets a captcha, the source steps aside for 10 minutes (a circuit breaker) and yt-dlp handles TikTok meanwhile. A page whose layout changed falls back to yt-dlp for that post (`extractor-fallback` in its attempts). |
| Listing | Progress is reported page by page (`analyze(url, {onProgress})`). A listing is kept for 15 minutes: a reopened profile answers from memory, and asking for more continues below the posts already known. A listing that comes back more than 5% short of the profile's post count gets a second, merged pass. |

No request signatures are generated and no anti-bot challenge is solved.
Photo posts (slideshows) aren't supported yet and are reported as such.
TikTok's terms restrict automated access: use this to back up content you
are allowed to keep, at the default pace. `tiktok: false` sends TikTok to
yt-dlp like any other site.

## Retries, sub-tasks and tracing

- Each job runs `download → convert → validate → finalize`; every step has a state (`pending | in-progress | success | failed | skipped`).
- Transient failures are retried up to 3 times; the wait doubles (2 s, 4 s, 8 s) and never exceeds 15 s. A download with no activity for 2 min is treated as stalled and retried.
- Every attempt records the step it failed in, the error, and the last status/progress it reached.
- Ids are 32-character base62 strings: `sessionId → batchId → jobId → attemptId → stepId`. Every log line carries them and is appended to `logs/trace-YYYY-MM-DD.jsonl` (14 days kept); `mdc logs <id>` replays any of them.

## Concurrency model

One JavaScript thread orchestrates. The heavy work happens elsewhere, in parallel:

| Work | Where it runs |
|---|---|
| Downloading, merging | `yt-dlp` child process per job (+ its `ffmpeg`) |
| Converting, validating | `ffmpeg` child process per job |
| SHA-256 of finished files | `HashPool` — worker threads, started on demand, exit when idle |
| Queue, events, state | main thread — never blocked: all I/O is async, progress is parsed line by line |

- **At most ⌊logical CPUs / 2⌋ jobs** run at once (`MediaDownloader.maxConcurrency()`); `setConcurrency(n)` is clamped to it. A job holds its slot through download → convert → validate → move, so the cap covers the whole pipeline.
- **CPU budget for ffmpeg:** each decode/encode gets `⌊limit / running jobs⌋` threads — a lone job validates with all of them, a full pool uses one each. Total never exceeds ⌊CPUs/2⌋.
- **Fragments:** `fragmentsPerDownload` (default 3) parallelizes HLS/DASH fragments inside one download; network-bound, near-zero CPU.

Measured with `scripts/stress.ts` (fake binaries, 12-CPU Intel Mac, 1000 jobs):

| Metric | Result |
|---|---|
| Peak simultaneous jobs | 6 (= ⌊12/2⌋) |
| Event-loop delay | p50 1.1 ms · p99 6.5 ms |
| Jobs kept in memory | 50 of 1000 (`retainFinishedJobs`) |
| Heap growth | ~1.2 KB per archived item (the archive index); nothing else accumulates |

## Built for heavy loads

Measured with `scripts/batch-bench.ts` (one playlist batch, fake tools so the
network isn't the variable; 12-CPU Intel Mac, 6 workers):

| Items in the batch | 300 | 2,000 | 5,000 |
|---|---|---|---|
| Preflight (all items checked) | 0.8 s | 4.2 s | 10.6 s |
| Scheduler events emitted | 41 · 0.0 MiB | 239 · 0.1 MiB | 579 · 0.3 MiB |
| Heap growth for the whole batch | 2.9 MiB | 5.1 MiB | 7.3 MiB |
| Event-loop delay p99 | 4.3 ms | 3.7 ms | 3.9 ms |

On real YouTube urls, chunked preflight checks 6 videos in 7.7 s instead of
14.1 s (one yt-dlp process per chunk instead of per url), and the jobs reuse
the metadata it fetched — downloads start without a second extraction.

### Long videos: weighted concurrency and a disk forecast

A 6-minute clip and a 2-hour 4K video don't cost the same: the long one is
gigabytes on disk (2× while merging, 3× when converting) and minutes to
hours of CPU to validate or convert. Every job is classified from its
preflight data and occupies capacity accordingly:

| Tier | When | Weight | At once on 12 CPUs (capacity 6) |
|---|---|---|---|
| normal | under 30 min (any audio) | 1 | 6 (N/2) |
| long | video of 30 min or more | 1.5 | 4 (**N/3**) |
| heavy | long and 1440p+/uncapped, or converted locally | 2 | 3 (N/4) |

Mixed batches share the capacity (e.g. 2 long + 3 normal = 6 units), in
strict FIFO order so heavy jobs never starve; ffmpeg threads are split in
proportion to weight. `longVideoMinutes` tunes the threshold.

When the preflight ends, the scheduler **forecasts the disk**: estimated
size of every new item (the site's figure, or duration × a conservative
bitrate), archived items excluded, plus the peak of temporary copies of the
jobs that run at once — on the same volume or separately, by device id. If
it doesn't fit, the batch stops **before downloading anything**:
`Not enough disk space: the batch needs 48.2 GB and ~/Videos has 31.0 GB free`
(`diskCheck: 'block' | 'warn' | 'off'`). Each job re-checks its own peak
before it starts.

### Complexity of the hot paths

| Operation | Cost | How |
|---|---|---|
| Queue a job / start / cancel / prioritize | O(1) | doubly linked list indexed by id |
| Job progress → event | O(1), ≤ 4/s per job | cached frozen snapshots, throttled emits |
| Batch progress → event | O(1), ≤ 4/s per batch | incremental counters; items are paged (`items(id, {offset, limit})`) and streamed one by one (`item` event), never sent whole |
| Record a download / a pending job | O(1) | append-only logs (`archive.jsonl`, `pending.jsonl`), amortized streaming compaction |
| "Already downloaded?" | O(1) + one `stat` | in-memory index of path + size only (≈ 273 B per archived file; 50,000 files ≈ 13 MiB) |
| Choose formats for a video | O(formats) | catalog indexed in one pass |
| Release finished jobs | O(1) amortized | insertion-ordered set, oldest first |
| Enqueue a 5,000-item batch | O(n), sliced | 250 jobs per event-loop turn — the UI thread never stalls |
| SHA-256 of finished files | off the main thread | worker-thread pool, idle workers exit |

## Memory and resource discipline

- Child-process output is consumed as a stream of lines; stdout is only collected when needed (metadata JSON), stderr is a bounded tail buffer (`TailBuffer`).
- yt-dlp emits progress at most every 250 ms (`--progress-delta`), and the engine throttles `job` events per job (`progressIntervalMs`), so a busy queue doesn't flood Electron IPC.
- Snapshots are frozen and cached until the job changes — reading state allocates nothing.
- Finished jobs beyond `retainFinishedJobs` are released; timers and abort controllers are cleared the moment a job ends.
- The archive is an append-only JSON-lines log: one line per download (O(1)), streamed on load, compacted when stale records pile up.
- The pending queue is persisted with debounced atomic writes (one write for a 500-item playlist, not 500).
- The task queue is a linked list indexed by id: enqueue, cancel, prioritize and dequeue are O(1) for any playlist size.
- `dispose()` (or `await using`) stops analyses and jobs, kills process trees, flushes and closes files, terminates workers, removes temp files and listeners.

## Format profiles

| Profile | Container | Video | Audio | Notes |
|---|---|---|---|---|
| `{kind: 'video', container: 'mp4'}` | MP4 | **H.264** | **AAC** | Plays everywhere. YouTube serves H.264 up to 1080p; above that `requiresConversion: true`. |
| `{kind: 'video', container: 'webm'}` | WebM | VP9 / AV1 / VP8 | Opus / Vorbis | YouTube's native best quality (4K/8K), no conversion. |
| `{kind: 'video', container: 'mkv'}` | MKV | any | any | Best streams, untouched. |
| `{kind: 'audio', container: 'm4a'}` | M4A | – | AAC | Stream copy when the source is AAC. |
| `{kind: 'audio', container: 'opus'}` | Ogg | – | Opus | Stream copy when the source is Opus. |
| `{kind: 'audio', container: 'mp3'}` | MP3 | – | MP3 | VBR V0 by default (`quality: '0'`) or a bitrate (`'192K'`). |
| `{kind: 'audio', container: 'flac' \| 'wav'}` | FLAC / WAV | – | FLAC / PCM | Lossless container; the source is still lossy. |

`maxHeight` caps the resolution. For a single video, `analyze()` returns the
real choices with size estimates; for a playlist, generic profiles that are
resolved per entry at download time. When a site lacks the target codecs,
only the offending stream is re-encoded locally.

## Integrity validation

`validation: 'full'` (default) proves every file before it reaches the user's folder:

1. it exists and is not empty;
2. `ffprobe` parses it, and the **container and codecs** match the profile (cover art isn't counted as video);
3. its **duration** matches the site's metadata (tolerance: max(3 s, 2%));
4. `ffmpeg -xerror` **decodes every frame** of video and audio with zero errors and **reaches the end** of the timeline.

`'quick'` replaces step 4 with a packet read (≈50× faster; catches truncation, not bitstream corruption). `'none'` trusts yt-dlp.

Failures are retried from scratch; a file that still fails ends as `failed` with code `validation` and structured `issues` (`{code, message, params}`).
yt-dlp writes into a private work folder; only validated files are moved into the destination (cross-volume moves copy → verify size → rename), so a truncated file never appears under its final name.

## Backups: archive, resume, verify

- **Archive** (`archive.jsonl`): one record per `site:id:profile`. Re-adding a playlist downloads only new or missing items. Each record stores the file's **SHA-256**; `verifyArchive()` re-hashes everything and reports files that went missing, changed size or changed content.
- **Queue persistence** (`queue.json`): `restoreQueue()` re-queues what was pending when the app closed or crashed.
- **Resume**: each job's work folder is derived from url + profile, so a retry or a restart continues the `.part` files.

## Errors

Every failure has a stable `code` — `network`, `expired`, `unavailable`, `disk-full`, `validation`, `conversion`, `binary-missing`, `invalid-request`, `cancelled`, `unknown` — plus an English `message`, optional `params` and `details` (stderr tail). Hosts localize by code. Only transient codes are retried, with exponential backoff and jitter.

## Security

- Requests are validated at the boundary (`add()`): http(s) urls only, profiles checked at runtime, absolute output folders, cached metadata accepted only from the engine's own cache. In Electron this is the line between the untrusted renderer and the main process.
- The url is passed after `--`, so a crafted "url" can never be parsed as a yt-dlp option.
- yt-dlp updates are verified against the release's `SHA2-256SUMS` before extraction.

## API

```ts
new MediaDownloader({
  dataDir,                      // absolute; archive, queue, temp files, updated yt-dlp
  binaries?: {ytDlp, ffmpeg, ffprobe},
  concurrency?,                 // default ⌊CPUs/2⌋, never more
  validation?: 'full' | 'quick' | 'none',
  fragmentsPerDownload?: 3, maxRetries?: 3, checksums?: true, useArchive?: true,
  embedMetadata?: true, embedThumbnail?: false,
  jsRuntime?,                   // default: this Node.js (Electron: app binary as Node)
  cookiesFromBrowser?, cookiesFile?, rateLimit?, extraYtDlpArgs?,
  progressIntervalMs?: 250, minFreeSpaceBytes?: 512 MiB, retainFinishedJobs?: 1000,
})

dl.analyze(url, {signal?, maxEntries?})  → VideoAnalysis | PlaylistAnalysis
dl.add(request) · dl.addVideo(analysis, profile, outDir) · dl.addPlaylist(analysis, profile, outDir, {indexes?})
dl.cancel(id) · dl.cancelAll() · dl.retry(id) · dl.prioritize(id) · dl.clearFinished()
dl.pause() · dl.resume() · dl.setConcurrency(n) · dl.setValidation(level)
dl.jobs() · dl.job(id) · dl.stats · dl.whenIdle()
dl.restoreQueue() · dl.verifyArchive(onProgress?, signal?) · dl.updateYtDlp() · dl.resolveBinaries()
dl.dispose()  /  await using

events: 'job' (any change, throttled) · 'completed' · 'failed' · 'idle' · 'log'
```

Job lifecycle: `queued → downloading → processing → converting → validating → finalizing → completed`, or `skipped` (already archived), `failed`, `cancelled`.

## Electron

See [`examples/electron`](examples/electron) for main-process + preload wiring.
Ship the binaries with electron-builder `extraResources`, per platform:

```
resources/bin/darwin/  yt-dlp/ (unzipped yt-dlp_macos.zip)  ffmpeg  ffprobe
resources/bin/win32/   yt-dlp/ (unzipped yt-dlp_win.zip)    ffmpeg.exe  ffprobe.exe
```

- Use yt-dlp's **onedir** builds: the single-file builds unpack themselves on every launch (measured 25 s vs 0.7 s per call on macOS).
- Keep ffmpeg and ffprobe in the same folder (yt-dlp looks for ffprobe next to ffmpeg). They need libx264, libvpx, libopus and libmp3lame.
- `updateYtDlp()` installs newer versions into `userData/bin/yt-dlp/<version>/`; they take precedence over the bundled one.
- YouTube needs a JavaScript runtime for some formats; by default the engine passes the Electron binary itself (`ELECTRON_RUN_AS_NODE=1`), so nothing extra ships.

## Development

```bash
npm install
npm test            # unit + orchestration + integrity (integrity needs ffmpeg/ffprobe)
npm run typecheck   # strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess, …
npm run lint        # biome
npm run build       # dist/: ESM + CJS + .d.ts
npm run stress      # orchestrator benchmark with fake binaries
npm run demo -- "https://www.youtube.com/watch?v=jNQXAC9IVRw"     # list choices
npm run demo -- "https://www.youtube.com/watch?v=jNQXAC9IVRw" 0   # download choice 0
```

## Changes

See [CHANGELOG.md](CHANGELOG.md).

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for learning, personal and other
noncommercial use; commercial use is not permitted. Anyone who shares any part
of this software, modified or not, must include the license and this notice:

```
Required Notice: Copyright (c) 2026 isaachq <isaac.hernandez.qz@gmail.com> (https://github.com/isaachq/media-downloader-core)
```

For commercial licensing, contact isaac.hernandez.qz@gmail.com.
