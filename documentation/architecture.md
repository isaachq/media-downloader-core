# Architecture and reliability

How the engine schedules work, stays light under heavy loads and validates every file. Back to the [README](../README.md).

## Retries, sub-tasks and tracing

- Each job runs `download → convert → validate → finalize`; every step has a state (`pending | in-progress | success | failed | skipped`).
- Transient failures are retried up to 3 times; the wait doubles (2 s, 4 s, 8 s) and never exceeds 15 s. A download with no activity for 2 min is treated as stalled and retried.
- Every attempt records the step it failed in, the error, and the last status/progress it reached.
- An Instagram post is not part of that 3. It tries five anonymous doors, one per try with its own Accept-Language, and, only if those fail, three reads with the user's session. The first success starts the download. No session after the five is `needs-sign-in` (or, after a refusal rather than a wall, `retry-later` with the wait). A session the site no longer accepts is `needs-sign-in` at once; one that still fails is `retry-later` in about 5 minutes. None of those errors is tried again by the loop. Stories, highlights and profile listings still ask for a session first.
- Ids are 32-character base62 strings: `sessionId → batchId → jobId → attemptId → stepId`. Every log line carries them and is appended to `logs/trace-YYYY-MM-DD.jsonl` (14 days kept); `mdc logs <id>` replays any of them.

## Concurrency model

One JavaScript thread orchestrates. The heavy work happens elsewhere, in parallel:

| Work | Where it runs |
|---|---|
| Downloading, merging | `yt-dlp` child process per job (+ its `ffmpeg`) |
| Converting, validating | `ffmpeg` child process per job |
| SHA-256 of finished files | `HashPool` — worker threads, started on demand, exit when idle |
| Queue, events, state | main thread — never blocked: all I/O is async, progress is parsed line by line |

- **At most ⌊logical CPUs / 2⌋ jobs** run at once (`MediaDownloader.maxConcurrency()`); `setConcurrency(n)` is clamped to it. `maxCpuShare: 0.6` (or `setMaxCpuShare(0.6)`) raises the ceiling to ⌊CPUs × 0.6⌋ — never more, so about 40% of the machine stays free. A job holds its slot through download → convert → validate → move, so the cap covers the whole pipeline.
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

### The nightly matrix

`npm test` runs on fakes and finishes in under a minute. The matrix runs the whole engine on real media — every source family (yt-dlp, TikTok, Instagram, Facebook, a player page) serving the same real clip through its local fake, × the 26 profiles, plus slideshows and a carousel — with the real ffmpeg, about 80 s:

```bash
MDC_MATRIX=1 npx tsx --test test/matrix.test.ts
```

Every output is probed and the probes land in `reports/matrix-<date>.json`; `.github/workflows/nightly.yml` runs it every night on Ubuntu and Windows with a JUnit file beside the manifest, kept as an artifact for 30 days.

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
| SHA-256 of finished files | off the main thread | worker-thread pool, idle workers exit; a shared cancel signal carries no listener per file |
| Cancel / exit → child processes | O(1) per child | the whole tree (Windows `taskkill /T` before the parent; POSIX process group), stdout drained before the result settles |
| Pending journal compaction | O(live), streamed | appends and the compaction take turns on one lock: nothing written while compacting is lost |

## Memory and resource discipline

- Child-process output is consumed as a stream of lines; stdout is only collected when needed (metadata JSON), stderr is a bounded tail buffer (`TailBuffer`).
- yt-dlp emits progress at most every 250 ms (`--progress-delta`), and the engine throttles `job` events per job (`progressIntervalMs`), so a busy queue doesn't flood Electron IPC.
- Snapshots are frozen and cached until the job changes — reading state allocates nothing.
- Finished jobs beyond `retainFinishedJobs` are released; timers and abort controllers are cleared the moment a job ends.
- The archive is an append-only JSON-lines log: one line per download (O(1)), streamed on load, compacted when stale records pile up.
- The pending queue is persisted with debounced atomic writes (one write for a 500-item playlist, not 500).
- The task queue is a linked list indexed by id: enqueue, cancel, prioritize and dequeue are O(1) for any playlist size.
- `dispose()` (or `await using`) stops analyses and jobs, kills process trees, flushes and closes files, terminates workers, removes temp files and listeners.

## Integrity validation

`validation: 'full'` (default) proves every file before it reaches the user's folder:

1. it exists and is not empty;
2. `ffprobe` parses it, and the **container and codecs** match the profile (cover art isn't counted as video);
3. its **duration** matches the site's metadata (tolerance: max(3 s, 2%));
4. `ffmpeg -xerror` **decodes every frame** of video and audio with zero errors and **reaches the end** of the timeline.

`'quick'` replaces step 4 with a packet read (≈50× faster; catches truncation, not bitstream corruption). `'none'` trusts yt-dlp.

Failures are retried from scratch; a file that still fails ends as `failed` with code `validation` and structured `issues` (`{code, message, params}`).

**Damaged at the source.** When the file came down whole and fails as broken (`decode-failed`, `decode-errors`, `incomplete-decode`, `duration-mismatch`, `probe-failed`, `file-empty` — not a codec or container mismatch, which is about the conversion), one fresh download confirms it; the second failure marks the media in `damaged.json` (`MediaDownloader.damaged`, by media id and url) and the job fails with hint `damaged-source` instead of spending its remaining retries. From then on the scheduler's check settles such items as unavailable (`damaged-source`) and a loose job fails at once. `damaged.remove(key)` lets one try again.

**Checks after the batch.** `validationTiming: 'after-batch'` (or `setValidationTiming`) finishes batch jobs as they download — probed only, archived with `validation: 'none'`, `JobSnapshot.validationPending` — and once every download of the batch has ended the batch turns `validating` (`BatchSnapshot.validation = {done, total}`) and `checkLater()` checks the files at the configured level, a few at a time. Passing files get that level in their record; a file broken at the source is marked damaged and kept (its record carries `damaged`); one failing for another reason is removed with its record so it can be downloaded again.
yt-dlp writes into a private work folder; only validated files are moved into the destination (cross-volume moves copy → verify size → rename), so a truncated file never appears under its final name.

## Backups: archive, resume, verify

- **Archive** (`archive.jsonl`): one record per `site:id:profile`. Re-adding a playlist downloads only new or missing items. Each record stores the file's **SHA-256** and the integrity check it passed; `verifyArchive()` re-hashes everything and reports files that went missing, changed size or changed content.
- **History** (`archive.list({offset, limit, search})`): finished downloads newest first, a page at a time, searched by title or file name without case or accents. The log is read once; after that pages come from memory and follow every new download. Measured with 10,000 records: first page 128 ms, later pages 0.06 ms, a search 3 ms, each new download 0.6 ms.
- **Queue persistence** (`queue.json`): `restoreQueue()` re-queues what was pending when the app closed or crashed.
- **Resume**: each job's work folder is derived from url + profile, so a retry or a restart continues the `.part` files.

## Errors

Every failure has a stable `code` — `network`, `expired`, `unavailable`, `disk-full`, `validation`, `conversion`, `binary-missing`, `invalid-request`, `cancelled`, `unknown` — plus an English `message`, optional `params` and `details` (stderr tail). Hosts localize by code. Only transient codes are retried, with exponential backoff and jitter.

### Failure diagnostics

`diagnoseFailure({url, error, stage, elapsedMs, resolvedUrl?, analysis?})` turns any of those
errors into a report a person can paste into an issue, built in O(1) from what the engine
already has (no request is made, nothing is sent anywhere):

| Field | |
| --- | --- |
| `target_url`, `resolved_url` | the link as given, and where a short link led |
| `platform` | `facebook` · `instagram` · `tiktok` · `youtube` · `unknown` (`platformOf(url)`: one hash lookup per host suffix) |
| `detected_media_type` | `video` · `reel` · `photo_with_audio` · `carousel` · `profile` · `short_link` · `unknown` |
| `failure_stage` | `URL_VALIDATION` · `REDIRECT_RESOLUTION` · `METADATA_PARSE` · `STREAM_EXTRACTION` · `MUXING` · `NETWORK_IO` |
| `error_code` | `LOGIN_WALL_DETECTED`, `REDIRECT_LOOP`, `REDIRECT_DEAD_END`, `RATE_LIMITED`, `TIMEOUT`, `DASH_AUDIO_MISSING`, `PHOTO_AUDIO_PARSE_ERROR`, `MUXING_FAILED`, `UNSUPPORTED_URL`, `REMOVED`, `PRIVATE`, `NO_MEDIA`, `FORMAT_CHANGED`… |
| `http_status`, `execution_time_ms`, `engine`, `message` | the status the error names, the time spent, the engine's own code and hint |
| `stack_snippet` | the last lines of the error, query strings (signed media urls) removed, at most 1 KB |

The Android app keeps the last 20 of these on the phone and offers them on every failure
("Copy diagnostic report").

## Security

- Requests are validated at the boundary (`add()`): http(s) urls only, profiles checked at runtime, absolute output folders, cached metadata accepted only from the engine's own cache. In Electron this is the line between the untrusted renderer and the main process.
- The url is passed after `--`, so a crafted "url" can never be parsed as a yt-dlp option.
- yt-dlp updates are verified against the release's `SHA2-256SUMS` before extraction.
