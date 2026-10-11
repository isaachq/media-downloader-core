# media-downloader-core

**A download engine built for heavy workloads — not one video, many:**
playlists with thousands of items, batches queued back to back, hours of
unattended backup. Every hot path is O(1) or O(n) by design, work runs on a
⌊CPUs/2⌋ pool of processes and threads so the machine stays responsive,
memory stays flat, and **every file is validated** before it's delivered.

UI-agnostic — drive it from the `mdc` CLI, an Electron main process or a
server. Zero runtime dependencies: it orchestrates `yt-dlp`, `ffmpeg` and
`ffprobe`, and installs/verifies them itself (`mdc setup`).

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

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free for learning, personal and other
noncommercial use; commercial use is not permitted. Anyone who shares any part
of this software, modified or not, must include the license and this notice:

```
Required Notice: Copyright (c) 2026 isaachq <isaac.hernandez.qz@gmail.com> (https://github.com/isaachq/media-downloader-core)
```

For commercial licensing, contact isaac.hernandez.qz@gmail.com.
