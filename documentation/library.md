# Library guide

Using `media-downloader-core` from Node.js. Back to the [README](../README.md).

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
  tiktok?, instagram?, facebook?,   // false, or each built-in extractor's options (pacing, browser, cookies, queries)
  progressIntervalMs?: 250, minFreeSpaceBytes?: 512 MiB, retainFinishedJobs?: 1000,
})

dl.analyze(url, {signal?, maxEntries?})  → VideoAnalysis | PlaylistAnalysis
dl.add(request) · dl.addVideo(analysis, profile, outDir) · dl.addPlaylist(analysis, profile, outDir, {indexes?})
dl.cancel(id) · dl.cancelAll() · dl.retry(id) · dl.prioritize(id) · dl.clearFinished()
dl.stop(id)                   // a live recording: stop and keep it (finalized, validated, archived); cancel discards
dl.pause() · dl.resume() · dl.setConcurrency(n) · dl.setValidation(level)
dl.jobs() · dl.job(id) · dl.stats · dl.whenIdle()
dl.restoreQueue() · dl.verifyArchive(onProgress?, signal?) · dl.updateYtDlp() · dl.resolveBinaries()
dl.dispose()  /  await using

events: 'job' (any change, throttled) · 'completed' · 'failed' · 'idle' · 'log'
```

Job lifecycle: `queued → downloading → processing → converting → validating → finalizing → completed`, or `skipped` (already archived), `failed`, `cancelled`.

A live recording (a Twitch channel on the air) is a job like the others whose download step lasts until
`dl.stop(id)` (or the stream ends, or 12 h): its progress is `{live: true, elapsedSec, bytes}` with no
`fraction`, `totalBytes` or `eta`, so a host shows the time recorded instead of a bar.

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

## Mix lists: links of any sites, one batch

```ts
const mix = await engine.analyzeMix(pastedText, {profile, onProgress: p => bar(p.checked / p.total)})
// mix.valid: the links that download, in the order pasted, with what their check found
// mix.skipped: what was left out, each with its line and reason; mix.summary: counts by site and reason
scheduler.scheduleMix(mix, {profile, outDir, title: 'Mix list'})   // one batch, not one per link
// a link in a format of its own (the rest in `profile`): formats: {[url]: {kind: 'audio', container: 'mp3'}}
```

A **mix list** is a pasted list of independent links of any sites, downloaded as
**one batch**. Nothing new downloads it: `scheduleMix` hands the scheduler a normal
batch (a `selection` of single items with `flat: true` and `mix: true`), so the
pool, retries, integrity checks, archive, report, cancel and `restore()` all work
as for any batch. Its files go straight into `outDir`, named as single downloads.

- **Local first, O(n).** `planMix(text)` (also in `media-downloader-core/detect`,
  pure, for the apps' renderers) finds every link of the text (several per line,
  inside sentences, unwrapped from trackers), drops repeats by `linkKey` (scheme,
  `www.`, mobile hosts, trailing slash, fragment and tracking parameters don't
  count) and reports lines with no link. One pass and a Set: 50,000 lines plan in
  well under a second. Lists (playlists, channels, profiles, stories) are left out
  as `listing` before any request: they have a preview of their own.
- **One network pass.** What is left is checked by the batches' own `preflight`:
  natively read sites paced by their source, the rest through yt-dlp in chunks,
  ⌊CPUs/2⌋ processes at a time. Links that turn out to name the same media
  (`youtu.be/x` and `youtube.com/watch?v=x`, a short link and its post) are found
  by the media's identity and kept once; links damaged at the source are left
  out; those already downloaded with `profile` are marked `archived`.
- **Partial failures never fail the list.** Each refusal lands in `skipped` with
  a reason (`unsupported`, `unavailable`, `private`, `needs-sign-in`, `damaged`,
  `error`) and the engine's `JobError`, for the apps to word like any failure.
  A site's bot check isn't final: such a link stays in, checked when it downloads.
- **Nothing is checked twice.** `scheduleMix(mix, …)` hands the checks to the
  batch, which skips its own preflight for them (their metadata is reused by the
  downloads). `scheduleMix(text, …)` also works: the batch checks the links itself
  and shows the ones it can't download as unavailable.

## Format profiles

The core supports **26 base format profiles** across MP4, WebM, MKV, and audio containers:

| Family | Profiles | Target Codecs & Muxing | Notes |
|---|---|---|---|
| **MP4** | Best, 2160, 1440, 1080, 720, 480, 360 | Video: **H.264** · Audio: **AAC** | Maximum device compatibility (iOS, Android, macOS, Windows, TV). |
| **WebM** | Best, 2160, 1440, 1080, 720, 480, 360 | Video: **VP9** (or AV1/VP8) · Audio: **Opus** | Native high-efficiency open formats. |
| **MKV** | Best, 2160, 1440, 1080, 720, 480, 360 | Video: Preserved / H.264 · Audio: Preserved | Matroska container guaranteed. Stream-copied when source is compliant. |
| **Audio** | M4A, MP3, Opus, FLAC, WAV | M4A (AAC), MP3 (MP3), Opus (Opus), FLAC (lossless), WAV (PCM) | Video tracks and cover art stripped from stream; cover art kept as attached pic. |

### Processing kinds & execution planning

Each choice internally declares its `ProcessingKind`:
- `'none'`: The downloaded media already matches the required container, codecs, and resolution. Moved directly.
- `'remux'`: Fast stream copy (`-c copy`) without generational loss when codecs are compliant but the container differs (e.g. MP4/WebM to MKV). I/O-bound.
- `'transcode'`: Audio or video re-encoding required (e.g. resolution downscaling, codec conversion). CPU-bound.
- `'extract'`: Audio track extraction from a video source into a dedicated audio container.

### Resolution cap contract

- `maxHeight` acts as a strict upper bound cap (`height <= maxHeight`).
- `Best` (omitted `maxHeight`) preserves the highest resolution available without artificial upscaling.
- If a source stream exceeds `maxHeight`, the engine downloads the closest stream above the cap and scales it down locally using FFmpeg, preserving aspect ratio, orientation, SAR/DAR, and even dimension constraints (`scale=-2:targetShort` / `scale=targetShort:-2`).
- If the source resolution is smaller than `maxHeight`, it is preserved as-is without upscaling.

### Deterministic defect protection

Post-conversion validation distinguishes between genuine source damage (`damaged-source`) and deterministic transformation defects (e.g. `unexpected-container`, `unexpected-video-codec`, `resolution-exceeded`). Transformation defects fail immediately with actionable diagnostic hints, preventing wasteful retry storms against unchangeable outputs.


## Electron

See [`examples/electron`](../examples/electron) for main-process + preload wiring.
Ship the binaries with electron-builder `extraResources`, per platform:

```
resources/bin/darwin/  yt-dlp/ (unzipped yt-dlp_macos.zip)  ffmpeg  ffprobe
resources/bin/win32/   yt-dlp/ (unzipped yt-dlp_win.zip)    ffmpeg.exe  ffprobe.exe
```

- Use yt-dlp's **onedir** builds: the single-file builds unpack themselves on every launch (measured 25 s vs 0.7 s per call on macOS).
- Keep ffmpeg and ffprobe in the same folder (yt-dlp looks for ffprobe next to ffmpeg). They need libx264, libvpx, libopus and libmp3lame.
- `updateYtDlp()` installs newer versions into `userData/bin/yt-dlp/<version>/`; they take precedence over the bundled one.
- YouTube needs a JavaScript runtime for some formats; by default the engine passes the Electron binary itself (`ELECTRON_RUN_AS_NODE=1`), so nothing extra ships.
