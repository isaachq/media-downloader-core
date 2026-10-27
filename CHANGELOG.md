# Changelog

## Unreleased

### Status

Beta 11 on `feature/beta-11` (plan: Threads, HLS, Twitch, Bluesky, SoundCloud, Snapchat, CI,
supported sites). One line per planned commit: done, then verified with what. This block goes
away when the beta closes.

- [x] 0 `ci: 5-minute budget` · done · verified locally: `test:fast` 483 pass in 58 s, `test:integrity-smoke` 2 pass in 2 s, `test:heavy` 75 pass in 28 s, app unit 204 pass, `test:e2e:smoke` 3 pass in 27 s. Pending: the Actions before/after table on Isaac's first push (before: CI check jobs 15.7 to 16 min, one mix test waited a real 15-minute YouTube pause; app jobs 3.2 to 4.3 min)
- [x] 1 `source(threads)` · done · verified locally: `typecheck` and `lint` clean, `test:fast` 519 pass / 0 fail (16 Threads tests against the fake, Threads detection), `test:heavy` 75 pass, `perf --quick` within 10% of the baseline (no regression); live `live:matrix --platform threads` 17 of 17 links pass, `--native` 17 of 17, `--native --download` 13 of 13 single posts (H.264 720x1280 + AAC, JPEG / WebP pictures, carousel folders); CDN Range answers 206, no rate limit seen. Not verified: a private profile and a signed-in session (no account), GIFs, reposts and quotes as links, the razr 50
- [x] 2 `core(hls)` · done (no Source wired yet: Twitch VODs and SoundCloud come in their own commits) · verified locally: `typecheck` and `lint` clean, `test:fast` 604 pass / 0 fail / 2 skipped (44 HLS tests against the fake origin), `test:heavy` 80 pass (5 HLS tests with the real ffmpeg: TS → mp4, fMP4 as is, AES-128, a discontinuity, demuxed audio, all decode clean), `perf --quick` within 10% of the baseline; `scripts/hls-bench.ts` on 18,000 segments × 16 KB: parsed list 4.1 MiB, live heap growth 1.2 MiB at k = 3 and 6, event-loop p99 6.9 / 5.5 ms, 1.000 requests per segment, a kill at 9,000 resumed with 10 segments asked twice (bound W + 1 s = 232; 10 to 236 across runs), 245 / 304 segments a second (Windows Defender costs ~7 ms on the first open of each new file); live end to end: Mux's public test VOD (64 TS segments, 480p, 634.6 s, 9 s) and Apple's advanced fMP4 example (201 segments, demuxed E-AC-3 track, 600 s) ffprobe right and decode clean. Not verified: a real Twitch VOD, SoundCloud and Bluesky playlists, a signed playlist expiring live, the razr 50 (its ffmpeg's concat demuxer and bsfs)
- [x] 3 `source(twitch)` · done (clips; VODs and video listings on `core(hls)`) · VODs verified locally: `typecheck` clean, `lint` clean (`biome check` on src, test, scripts, documentation: `biome check .` stops on a nested biome.json in an untracked `.claude/worktrees/` checkout), `test:fast` 615 pass / 0 fail / 2 skipped (12 new VOD and video-listing tests against the fake GraphQL + usher over `fake-hls`: a finished VOD, codecs per profile, highlights and uploads, a muted VOD, a token running out mid-download, subscriber-only, deleted, a native failure to yt-dlp, a playlist still open, a 3-page listing with a recording VOD, an incremental listing, batched checks), `test:heavy` 80 pass, `perf --quick` within 10% of the baseline on every metric (archive.loadMs −1.4%, no re-run needed); live `live:matrix --platform twitch` 33 of 33 links, `--native` 33 of 33, `--native --download` 13 of 13 short VODs (past broadcasts, highlights, uploads, a past premiere: H.264 1920x1080, 1280x720 and 1080x1920 + AAC, full decode clean) and TW-08, a 1 h 1 min 50 s past broadcast (3,710 s), in 444 s end to end (download, assembly and the engine's full decode validation), 2.86 GB, ffprobe H.264 1920x1080 60 fps + AAC, 3,710.25 s against the VOD's 3,710 s, a full decode on its own (`ffmpeg -xerror` into the null muxer, 220 s) exits 0 with no decoder error (one repeated video DTS noted by the null muxer, which the engine counts benign) node working set 85 to 183 MB throughout. Four VODs first picked (highlights 5938473, 6732619, 1484137772 and the muted past broadcast 2795007999) fail the decode check natively and the same way through yt-dlp and through ffmpeg on usher's playlist alone: damaged at the source, replaced in the compendium. Checked live: usher answers H.264 only for `supported_codecs=h264`, `av1,h265,h264` and `av1` alike (32 channels' latest VODs, no HEVC or AV1 VOD found), a recording VOD's playlist is open (EVENT, no ENDLIST), muted parts are `-muted.ts` (200; `-unmuted` 403), the videos cursor and `totalCount` past page 3. Clips verified locally (a81efa5): `typecheck` and `lint` clean on this commit's files (the in-progress `src/core/hls/` excluded), `test:fast` 562 / 560 pass / 0 fail (19 Twitch tests against the fake, Twitch detection), `test:heavy` 75 pass, `perf --quick` no regression in code this commit touches (archive.loadMs and stress swing with machine load; archive imports nothing changed here); live `live:matrix --platform twitch` 14 of 14, `--native` 14 of 14, `--native --download` 10 of 10 single clips (H.264 1920x1080 or 1280x720 + AAC per ffprobe). Client ids re-checked live: the web player's gets `IntegrityCheckFailed` on listing page 2, yt-dlp's (the default) reads pages 1 to 3; both read single clips and batches of 15. Not verified: a subscriber-only clip or VOD (none found anonymously), an HEVC or AV1 VOD, a CDN token running out mid-download on the real CDN (VOD segments are unsigned), a 429 from gql.twitch.tv or usher, the razr 50. Pending: the sign-in (app commit 10)
- [x] 3b `core(hls): live recording` · done · verified locally: `typecheck` clean, `lint` clean (`biome check` on src, test, scripts), `test:fast` 638 pass / 0 fail / 2 skipped on this commit (22 recorder tests on the fake live origin's simulated clock, each under 0.5 s: from the window and from now, half-target waits after an empty read, Stop keeps, Stop wakes a wait, a stop before anything is a cancel, Cancel, maxDuration by media and by wall clock, a gap, offline by empty reloads and by 404 and before anything, a 403 refresh, a refresh that renumbers the session, refused, a refresh that says it is over, AES-128 rotation, skip, a lost segment, a stalled segment, fMP4 periods; a CLI row for a live job), `test:heavy` 81 pass (a recording with an ad left out and a gap finalized by the real ffmpeg: H.264 + AAC, the recorded duration ± 0.5 s, full decode clean, `validateFile` full ok), `perf --quick` within 10% of the baseline on every metric (a first run beside a live recording showed batch metrics up to +75%; alone: batch.preflightSec −9.8%, validate.fullSec +6.5%, the rest under ±5%); `scripts/hls-record-bench.ts` 10,000 segments (5.6 h of stream) in 129 s: live heap 11.89 MiB at 2,000 segments and 12.01 MiB at 10,000 (largest step 0.36 MiB; the 14.3 MiB at 1,000 is start-up garbage), 1.000 segment request and 1.000 reload per segment, event-loop p99 9.4 ms; live through the engine (native, full validation): Stop on summit1g after 180 s kept 202 s (22 s of window + 180 s), validated, checksummed and archived; Cancel on cdawg after 30 s kept nothing and left no work folder (details in 3c). Not verified: an app quit during a recording (dispose cancels: the folder stays and a restored job records anew), a stopped recording whose validation fails (the engine's retry would see the stop and end cancelled), the razr 50
- [x] 3c `source(twitch): live channels` · done · verified locally: `typecheck` and `lint` clean (src, test, scripts), `test:fast` 648 pass / 0 fail / 2 skipped (10 new Twitch live tests against the fake GraphQL + usher + live origin, about 2 s together: record → stop with the analysis's read feeding the recording, H.264 for MP4 and the audio_only variant, ads titled `Amazon|…` and ads told only by their date range left out with their seconds counted and kept with `skipAds: false`, the ad predicate, a token refresh, ENDLIST, an offline channel and one going offline, a refresh that finds it offline, never yt-dlp, Stop and Cancel through the engine with the archive entry and no work folder left), `test:heavy` 81 pass, `perf --quick` within 10% of the baseline; `live:matrix --platform twitch --native` 33 of 33. Live, through the whole engine (native, ffmpeg / ffprobe from the PATH, `validation: 'full'`): summit1g from the window, Stop after 180 s → 202 s kept (22 s of window + 180 s), 101 segments, no gap, 0 s of ads, converted, validated (decoded 202 s), SHA-256, archived as `live-322020126170-1793086943`, file `summit1g-2026-10-26-15-38-dayz-chillin-…-live-322020126170-1793086943.mp4`; ffprobe H.264 Main 1920x1080 60 fps + AAC LC 48 kHz stereo, 202.003 s, `ffmpeg -xerror` full decode exit 0; cdawg cancelled after 30 s → `cancelled`, no file, no work folder. A first run (xqc, 170 s kept, valid, decode clean) lost 17 segments to one gap: a segment request hung for the download watchdog's 60 s while the window is ~30 s; live segments now give up after 10 s (`LIVE_STALL_MS`, tested), and a 3-minute xqc rerun recorded 202 s without a gap. Checked live: the token comes with the stream in one raw query on the default client id, usher's `/api/channel/hls/` (and `/api/v2/`) master, 2 s TS segments titled `live`, target duration 6, PDT on every segment. Not verified: a real ad break (none came: 0 s skipped in every run), a refusal or the broadcast ending during a recording, HEVC / AV1 live variants, 12 h, a subscriber-only or geo-blocked stream, the razr 50
- [x] 3d `source(twitch): sign-in and live playback` · done (the design's defaults: sign-in from the browser cookie jar; signed token reads on the web player's client id, listings anonymous on yt-dlp's; `JobSnapshot.recording` added) · verified locally: `typecheck` clean, `lint` clean (`biome check` on src, test, scripts, documentation), `test:fast` 680 pass / 0 fail / 2 skipped (9 new tests on the fake: the auth-token only on Clip / Vod / VodToken / LiveStream and on the web id, listings and batched checks anonymous on yt-dlp's id; subscribed downloads of a subscriber-only VOD and a forbidden clip; signing in after a visitor's read; `members-only` without access; a 401 → one anonymous retry, one warning, 30 minutes anonymous, the host asked again after; refusals in flight told once; `livePlayback` sharing the analysis's query with the recording; `JobSnapshot.recording` on stop, max-duration, offline and the end of a broadcast; the engine's cookies file signing the token reads), `test:heavy` 81 pass, `perf --quick` within 10% of the baseline (batch cpuMsPerItem +9.9%, nothing on that path changed); `live:matrix --platform twitch --native` 33 of 33, anonymous. Not verified (no Twitch account): a real `auth-token` minting an allowed token on the web id, yt-dlp's id with that token, the integrity check on signed token queries, Firefox / Edge exporting `.twitch.tv auth-token` on Windows, a subscriber-only stream
- [x] 3e `core: clear stale work folders` · done (work folders are `work/<shortHash(url|profile[|photo-post mode])>`, owned by one url + profile; a restart or a retry resumes from them, so the sweep keeps every request of the pending journal, filtered-out batch jobs included, and every job already added; it runs once, in the first `restoreQueue()`, and jobs wait for it) · verified locally: `typecheck` clean, `lint` clean (`biome check` on src, test, scripts, documentation), `test:fast` 682 pass / 0 fail / 2 skipped (2 new engine tests with the fake tools: stale folders cleared, restored, filtered-out batch, already-added and foreign folders kept and the jobs complete; a first launch sweeps nothing), `test:heavy` 81 pass, `perf --quick` within 5% of the baseline; `live:matrix --platform twitch --native` 33 of 33. Not verified: a real crash on the desktop app or the razr 50 (the leftovers are simulated as folders)
- [x] 4 `source(bluesky)` · done · verified locally: `typecheck` and `lint` clean, `test:fast` 540 pass / 0 fail (20 Bluesky tests against the fake, Bluesky detection), `test:heavy` 75 pass, `perf --quick` within 10% of the baseline (no regression); live `live:matrix --platform bluesky` 19 of 19 links pass, `--native` 19 of 19, `--native --download` 15 of 15 single posts (original JPEG / PNG blobs byte for byte, no WebP; H.264 1080x1920 and 720x1280 + AAC); getBlob ignores Range, no rate limit hit. yt-dlp 2026.10.21 has a Bluesky extractor (posts only, the same API and blobs): nothing handed to it. Not verified: a `!no-unauthenticated` account, did:web and third-party PDS live, a PDS 429, the HLS fallback (waits for `core(hls)`), the razr 50
- [x] 5 `source(soundcloud)` · done (on `core(hls)`, after Twitch VODs) · verified locally: `typecheck` and `lint` clean, `test:fast` 627 pass / 0 fail / 2 skipped (22 SoundCloud tests against the fake on `fake-hls`, each under 0.4 s: client id rotation, a playlist link that ran out and segments re-signed, DRM from the formats and from a playlist, a Go+ snippet and a preview beside a whole format, sets 50 ids a request answered out of order, a private set's token, profile pagination through short pages, `known`, a secret-token track, legacy MP3 progressive and HLS, short links, DataDome; SoundCloud detection), `test:heavy` 80 pass, `perf --quick` back to back against `3ad64fa` on this machine: archive and validate within 4 %, stress and batch within noise (the base run swung 1.19 to 2.47 s on preflight under the machine's load; this one better on every speed metric), stress heap growth 1,963 KiB (+10 % on that run's 1,778, +0.6 % on the saved baseline's 1,950); live `live:matrix --platform soundcloud` 17 of 17 links pass, `--native` 17 of 17, `--native --download` 8 of 8 single tracks as M4A: AAC 44.1 kHz ~161 kb/s, ffprobe length equal to the track's to the millisecond on the clear HLS (213.886 s, 125.852 s, 232.250 s, 258.685 s, 97.005 s, 213.046 s), the legacy MP3s within 0.06 s, every file decoded in full with no error; a 57-minute mix (3431.334 s, ~344 segments) in 38 s, its length to the millisecond, decoded clean. Not verified: a private `s-` set, a Go+ preview and `policy: BLOCK` live (none seen from Mexico), DataDome's 403 (not reproduced), the hydration id going stale live, `encrypted-hls` (AES-128) live, a playlist link expiring mid-download live (only in the fake), the razr 50
- [x] 6 `source(snapchat)` · done · verified locally: `typecheck` and `lint` clean, `test:fast` 502 pass / 0 fail (18 Snapchat tests against the fake, Snapchat detection), `test:heavy` 75 pass, `perf --quick` within 10% of the baseline; live `live:matrix --platform snapchat` 15 of 15 links pass, `--native` 15 of 15, `--native --download` 8 of 8 single items (spotlights H.264 540x960 + AAC, a story snap 480x846, highlight JPEGs). Not verified: short links (no live code), a private profile page, a picture in a live story, the razr 50
- [x] 7 `release: library 1.21.0` · done (Isaac tags `lib-v1.21.0`; then `npm view` and a grep of the five new LinkSites in `dist/detect.js`) · verified locally on 41eb91e + the bump: the library half of `test:full` is green: `check` (typecheck, lint, `test:fast` 682 pass / 0 fail / 2 skipped), `test:heavy` 81 pass, `build`, `pack:check` (ESM, CJS, CLI 1.21.0); `perf --quick` on a quiet machine within 7% of the baseline everywhere (on 82f87ec; 3d within 10%, 3e within 5%) (archive loadMs +3.1%: the +22% seen earlier was another run on the machine). The app half (`npm --prefix app run typecheck`) fails until commit 8 gives the five new sites a tag and a name: expected, closed there
- [x] 7b `fix(sync): idle before a run is announced as ended` · done · found by CI on PR #55 (windows-latest, `test:fast`: "is already syncing" right after `whenDone`) · verified locally on Windows: the new assertion fails without the fix and passes with it, `test/sync.test.ts` 10 of 10 five runs in a row, `check` (typecheck, lint), `test:fast` 684 tests / 682 pass / 0 fail / 2 skipped
- [x] 7c `fix(bluesky): CDN first for a minute when a PDS gives no reset` · done · found by CI on PR #55 (macos-latest, `test:fast`: a second post asked the rate-limited PDS again, 4 blob requests for 3) · verified locally: the test now waits 120 ms between the two downloads (past its 50 ms cool-down, as the slow runner did) and fails without the fix, passes with it; `test/bluesky.test.ts` 20 of 20 three runs in a row; typecheck, lint, `test:fast` 684 / 682 pass / 0 fail / 2 skipped
- [x] 8 `app: site tags and icons` · done (icons and colours approved by Isaac) · verified locally: `npm --prefix app run typecheck` clean (closes the failure noted in 7), `lint` clean (289 files), `site:check` 14 languages up to date, app unit 14 files / 204 pass (every locale has every key), `test:e2e:smoke` 3 pass in 14 s; the tag smoke test now pastes one link per new site and checks its `data-site`, its name and that its icon draws (computed classes `ant-tag-default`, `-blue`, `-purple`, `-orange`, `-gold`; the screenshot waits 400 ms for the colour to ease in)
- [x] 9 `app: supported sites` · done · verified locally: `npm --prefix app run typecheck` clean, `lint` clean (293 files), `site:check` 14 languages and the README up to date, app unit 15 files / 207 pass (`shared/sites.test.ts`: every `LinkSite` and a file link listed once, yt-dlp sites are desktop only, every language has every site's words and a sign-in reason exactly where `signIn`; the label and the line under a pasted link in English and Spanish), `test:e2e:smoke` 3 pass (the tag test opens the list: 13 rows, Twitch's sign-in reason, YouTube desktop only; the line under a Snapchat and a YouTube link); the website's Spanish page checked at 672 px wide: 13 rows, no sideways scroll. Cost: O(sites) once per dictionary and per page, O(1) per pasted link (`SITE_BY_LABEL`)
- [x] 10 `app: sign-in for threads and twitch` · done · verified locally: `npm --prefix app run typecheck` clean, `lint` clean, app unit 15 files / 207 pass (How to sign in lists YouTube, Instagram, Facebook, Twitch, Threads and VK with the supported-sites words and says Twitch's session never chats, follows or subscribes), `test:fast` 684 / 682 pass / 0 fail / 2 skipped (the fake yt-dlp's jar now carries a Twitch subscriber's auth-token and a Threads session; the fake ffmpeg concatenates a concat list), `test:e2e` 18 of 18 in 1.2 min including the new @full 'a subscriber-only Twitch VOD downloads once a browser session is chosen' (fake GraphQL + usher + HLS: signed out the analysis says Sign-in required with no Authorization sent; with Firefox's session the VOD completes, one file, and every signed request is OAuth fake-ok on the web player's id). Found by that test and fixed: a refusal worded 'signed-in account' (Twitch, Threads, Bluesky) or 'watched signed in' (VK) did not get the how-to-sign-in line. Not verified: a real twitch.tv auth-token (no account), a real private Threads profile
- [x] 10b `app: twitch live` · done · verified locally: `npm --prefix app run typecheck` clean, `lint` clean (297 files), `site:check` up to date, app unit 17 files / 224 pass (`main/live-proxy.test.ts` 10: master and media rewrites (variants to mdc-live://sid/v/i, segments to /s/<b64>, PREFETCH dropped, PDT and DATERANGE kept), only https *.ttvnw.net segments (http, another host, ttvnw.net.evil.com, 127.0.0.1 refused and never fetched), 5 refused requests share one re-sign, 3 re-signs in a row then 502, Range passed on and a 10 MB body streamed with at most 2 chunks pulled ahead, 4 sessions at most; `renderer/src/live.test.tsx` 6: a live preview opens Record / Watch not a download, the card shows REC and a clock never a percent, Stop calls stop, Discard asks then cancels, saving then gone, Watch opens hls.js on mdc-live://sid1 and closing lets the session go, off the air shows Try again, the quit question; `main/redownload.test.ts`: a live record is never downloaded again), `test:e2e` 19 of 19 in 1.5 min including the new @full 'records a live Twitch channel, stops and keeps the file; a discarded one leaves nothing' (fake GraphQL + usher + live origin on a test-driven clock: Record, the clock past 0:00, Stop and save, one MP4, Finished tagged Live recording; again and Discard: no new file, no work folder; again and quit: the question, Stop, save and quit, the app exits with 2 MP4s). Found and fixed while testing: concurrent refused playlists used up the re-sign budget one request each. Not verified: Watch against real Twitch (needs the packaged app: the dev origin passes Twitch's allow-list and would hide a broken proxy; the release smoke opens one live channel), a recording of hours, the macOS Dock quit with no window
- [x] 11 `app: beta 11 e2e` · done (the record → stop → discard → quit run landed with 10b, as its design said; this adds the cross-site check) · verified locally: `npm --prefix app run typecheck` clean, `lint` clean, app unit 224 pass, `test:e2e` 20 of 20 in 1.6 min (the 17 of beta 10 and the 3 of beta 11 before this one pass unchanged) including the new @full 'beta 11: a mix list of the five new sites is checked at once and downloads as one batch': Threads, Bluesky, Twitch, Snapchat and SoundCloud from their local fakes (test hooks MDC_BLUESKY_ORIGIN, MDC_SNAPCHAT_ORIGIN, MDC_SOUNDCLOUD_ORIGIN beside Twitch's and Threads'), each tagged with its site, 5 ready, the clip as an MP4 of its own and the rest as the list's M4A, one batch 5/5 done, 4 M4A and 1 MP4 on disk, Finished names every site. Seen, not changed: a SoundCloud track in a list set to a video format is left out as Unavailable (it has no picture); the list's format or the link's own fixes it
- [x] 12 `release: app 0.2.0-beta.22` · done (Isaac merges PR #55 and tags `lib-v1.21.0`, then `app-v0.2.0-beta.22`) · verified locally: `npm run test:full` green in 275 s on Windows: library typecheck, lint, `test:fast` 684 / 682 pass / 0 fail / 2 skipped, `test:heavy` 81 pass, build, `pack:check` (1.21.0, 13 files), app typecheck, app unit 17 files / 224 pass, `test:e2e` 20 of 20 in 1.4 min; `site:check` 14 languages and the README up to date; the website's New in beta 22 section checked in the browser (6 cards, one icon each). CI on PR #55 green on every commit through 3fde830, longest job 4 min 25 s. Pending after the tags: `npm view media-downloader-core@1.21.0`, the dist grep of the five LinkSites, the 7 release assets, and the packaged app opening one live channel (Watch)
- [ ] Android `feature/beta-11` (phone repo) · not done (also: the live player on Media3 ExoPlayer, a foreground service while recording)

## App 0.2.0-beta.22 · library 1.21.0

Five new sites — Threads, Bluesky, Twitch, SoundCloud and Snapchat — read by the library itself;
native HLS downloads; Twitch live channels recorded and watched; one list of the supported sites.

**Library 1.21.0**

- **Bluesky: a PDS that limits this network without saying when it resets keeps pictures
  on the CDN for at least a minute**, not only for the pacer's cool-down (a few
  milliseconds in tests, seconds in use): the next post no longer asks the limited PDS
  first. The CDN serves the same pictures; the PDS's window is 5 minutes. Cost: O(1).
- **A sync that ends lets the next one start at once.** A finished run was announced (and
  `whenDone` resolved) a moment before the account read as idle, so a sync started right
  then could be refused as "already syncing" (seen on Windows CI). The account is idle
  before its run says it ended; it reads as downloading before its batch can end; and each
  account's run writes go one after the other, so a batch that ends at once is never
  covered by its own "running". Cost: O(1) per write (a promise chain per account).
- **Native HLS downloads for VODs and tracks (`core/hls`, internal: Twitch VODs are its first Source).** A master
  playlist's variants become the shared `Rendition`, so `rankRenditions` picks as it does for every
  native source (H.264 first for MP4 within the height cap, the audio-only variant or a demuxed audio
  track alone for audio); a media playlist is downloaded by k segment workers (the engine's
  `fragmentsPerDownload`, default 3, clamped to ⌊CPUs/2⌋, passed to sources as the new
  `SourceDownload.fragments`) ahead of one in-order appender per track, a 2k reorder window. Each
  segment goes to a Range-resumable `.part`, is checked from two small reads (the claimed media's
  first bytes, an HTML page refused, AES block length and PKCS#7 padding), renamed `.done` and
  streamed into one file per discontinuity period (AES-128 decrypted on the way, keys fetched once,
  an LRU of 4); a constant-size cursor in `state.json` (tmp + rename, at most once a second) makes a
  cancel, a crash or a kill resume where it stopped. One `ffmpeg -c copy` joins the periods with the
  concat demuxer (timestamps stay monotonic across discontinuities) and muxes a demuxed audio track
  in; a single fMP4 period is handed over as it is. BYTERANGE single-file playlists, EXT-X-MAP before
  or after EXTINF and repeated after a discontinuity (yt-dlp #10878), EXT-X-GAP, EXT-X-DEFINE,
  per-site uri rewrites (Twitch `-unmuted` → `-muted`), a wrong playlist Content-Type and redirects
  are handled; a 401/403 re-signs the playlist through the Source (one call per refusal wave, at most
  max(3, ⌈hours⌉ + 1)); a missing segment fails as a resumable `network` error (or is skipped when
  asked), a full disk is `disk-full`, never a gap. **Live streams are never downloaded**: a playlist
  without an end is refused as `live-now` before any segment is asked for; the parser still reads
  sliding windows in full (media and discontinuity sequences, program date-time, date ranges with
  their CLASS and attributes, segment titles) and the segment fetcher, key cache, appender, state
  writer and assemble step are separate pieces for the recorder to come. DRM (FairPlay, Widevine,
  PlayReady) is `format-unavailable` with a message that says DRM; SAMPLE-AES is `stream-only`.
  `VideoCodec` gains `'av1'` (ranked after H.265 and before H.264 outside MP4). `fetchMedia` takes a
  `range` and links the caller's signal with one listener it removes (no `AbortSignal.any` per call,
  whose Android polyfill left a listener on the job's signal each time), and no longer arms a
  24-hour request timer per call (`HttpSession` treats `timeoutMs: Infinity` as none): each held
  ~2 KB for a day, 36 MB over 18,000 segments. Fake origin `test/helpers/fake-hls.ts`, 44 fast tests,
  5 heavy ones with the real ffmpeg, `scripts/hls-bench.ts`. Cost: parsing O(L) once per playlist
  (L characters), O(n) memory for n segments; download O(1) per segment: 1 request, ≤ 1
  constant-size state write per second, O(1) progress; ≤ k requests in flight, ≤ W = 2k segment
  files on disk, memory O(k × 64 KB). Requests per item: 1 master + 1 per track playlist + n
  segments + 1 per distinct key + 1 init per period + the refresh budget (each O(n) to re-check: O(n)
  total). One ffmpeg -c copy pass O(bytes); P periods → a P-line concat list. Disk peak 2× the media
  (period files + output). Validation and SHA-256 stay the engine's existing steps.

- **Live recording on `core/hls` (`recordHls`, internal: Twitch live channels are its one Source), and
  a Stop action in the engine.** A live media playlist (a sliding window) is recorded into one file
  from the oldest segment the window still holds (`from: 'window'`, the default; `'now'` starts at
  the newest one), one segment at a time, until the playlist ends (ENDLIST), the user stops it, a cap
  (`maxDuration`, default 12 h of media or of wall clock) or the stream goes offline (10 reloads in a
  row with nothing new, or a re-sign that says it is over). The playlist is re-read every target
  duration (at least 1 s), half of it after a read that brought nothing, as hls.js does; segments are
  taken by media sequence (one subtraction finds the first new one in the window, nothing is taken
  twice), and when the program date-times say the numbering restarted (a refresh that opened a new
  session) the window is re-anchored by date. A jump in the numbering is a gap: counted, dated, and
  written as a new period, so the concat demuxer keeps timestamps contiguous; an EXT-X-GAP segment or
  one still failing after two retries is a gap too and never fails the recording; a segment that sends
  nothing for 10 s is dropped and asked again (`LIVE_STALL_MS`: a download's minute would let a
  30-second window move past the next segments, which is what one live run lost before it). A caller's `skip`
  leaves segments out (Twitch's ads), their seconds counted. A 401/403/410 asks `refreshUrl` for a
  freshly signed url (three refusals in a row end it as `refused`); a refused segment re-signs once and
  is taken again from the fresh copy. AES-128 keys go through the same key cache (key rotation, IV from
  the media sequence), fMP4 periods start with their own init segment, and the period files are joined
  by the same single `ffmpeg -c copy` as a download. Once something is recorded, a playlist that fails
  ends the recording and keeps it instead of failing the job. **Stop keeps, Cancel discards**:
  `MediaDownloader.stop(id)` (true when a running job was told to stop) ends a recording after the
  segment in flight and the file goes through the engine's usual convert, validate, checksum and
  archive steps, the job `completed`; `cancel(id)` aborts it and the work folder is deleted as for any
  cancelled job; a stop before anything was recorded is a cancel. `SourceDownload.stop` carries the
  signal to sources (those that only download what exists ignore it); `SourceFile.recording` reports
  how a recording ended, its gaps and the seconds left out, which the engine logs. A live job's
  progress is `live: true`, `elapsedSec` and `bytes` (also in `downloadedBytes`, with `speed`), never a
  `fraction`, `totalBytes` or `eta`; the CLI shows `REC` and the time recorded. Fake live origin
  (`startFakeLive` in `test/helpers/fake-hls.ts`: a window that advances on a simulated clock, ads,
  signed tokens, renumbering sessions, AES rotation, fMP4, a stalled edge), 22 fast tests, a heavy one with the real
  ffmpeg (an ad left out and a gap: one mp4, H.264 + AAC, the recorded duration, a clean full decode,
  valid by `validateFile`), and `scripts/hls-record-bench.ts`: 10,000 segments (5.6 h of stream),
  live heap 11.9 MiB at 2,000 segments and 12.0 MiB at 10,000, 1.000 segment request and 1.000 reload
  per segment, event-loop p99 9.4 ms. Cost: O(1) per segment (one request, one append, O(1)
  progress); per reload one request and O(w) parsing for a window of w segments (w set by the site,
  not by the length of the recording); memory O(w) for the current window + a 4-key cache + one
  [period, bytes] pair per period (a period per gap, ad break or discontinuity), never the list of
  recorded segments: flat over 12 hours. The expensive re-sign happens only on a refusal (at most
  three in a row). One ffmpeg -c copy at the end, O(bytes); disk peak 2× the recording.

- **Twitch clips and VODs, natively.** Clips (`clips.twitch.tv/<slug>`, `clips.twitch.tv/embed?clip=`,
  `twitch.tv/<channel>/clip/<slug>`, on www., m. and go.) and a channel's clips
  (`twitch.tv/<channel>/clips`, its `?range=24hr|7d|30d|all` honoured, a week without one, as
  the site), anonymous, from plain GraphQL queries on `gql.twitch.tv` (never the persisted
  hashes, which rotated four times in 13 months). A clip is one query: its H.264 encodings
  (1080p60 down to 360p) and the HEVC 1440p its playback token names, each a signed progressive
  MP4 (`?sig=&token=`), ranked by `rankRenditions` (MP4 takes H.264, MKV / WebM the HEVC) and
  streamed with Range; checks of clips not read yet go 15 a query (aliases). A listing is
  `clips(first: 100)` pages, top by views, every clip signed in its page, so listed clips are
  never read again; Twitch ends every listing at 1,000. The `Client-ID` is an option
  (`twitch.clientId`): the default is yt-dlp's (`ue6666qo983tsx6so1t0vnawi233wa`), which read
  every listing page live; the web player's (`kimne78kx3ncx6brgo4mv6wki5h1ko`) gets
  `IntegrityCheckFailed` past page 1. A deleted clip or channel is `removed`; a token that says
  forbidden (subscriber-only) is `needs-sign-in`; an integrity check is `source:blocked` (yt-dlp
  for 10 minutes) and a renamed field or a clip without encodings `source:format-changed`
  (yt-dlp for that url). A VOD whose broadcast is still going (`status: RECORDING`) fails
  natively as `live-now`, never handed to yt-dlp (which would record it); a channel on the air
  is recorded from its link (next entry). The live check is its own function
  (`TwitchSource.liveStream`, `readLiveStream`: stream id, login, display name, title, start). VODs (`/videos/<id>`, `/<channel>/v/<id>`, `/<channel>/video/<id>`, the player,
  `/schedule?vodID=`): past broadcasts, highlights, uploads and past premieres, downloaded by
  `core/hls`. One query brings the VOD and its playback token, one usher request its master
  playlist (`supported_codecs=h264` for an MP4 profile, `av1,h265,h264` otherwise; usher
  answered H.264 only for every VOD tried live), variants without sound left out and the rest
  ranked by `chooseVariant`; segments (fMP4 or MPEG-TS) go k at a time with `fragments`,
  a refused one re-signs through a fresh token and the same variant of a new master, and
  Twitch's muted parts keep the `-unmuted` → `-muted` rewrite. Recorded as `v<id>`, the id
  yt-dlp gives them. A channel's videos (`/<channel>/videos`, its `?filter=` and `&sort=`
  honoured) are `videos(first: 100)` pages by the page's cursor, with `totalCount`; listed
  VODs are kept, so their checks read nothing and their downloads only their token, and an
  incremental walk (`known`) stops at the known ones when newest first. A VOD still
  recording stays `live-now` (listed with `isLive`, never handed to yt-dlp), and so does one
  whose playlist has no end yet; a subscriber-only VOD (a forbidden token, or usher's 403
  `vod_manifest_restricted`) is `needs-sign-in`; a deleted one is `removed`; any other
  native failure (usher answering a page, a renamed field) is `source:format-changed` and
  goes to yt-dlp, as clips do. New `LinkSite` `'twitch'`, option `twitch`
  (`clientId`, `endpoints` with `usher` and `videoFields`, `pacing`, `maxListItems`), fake
  GraphQL and usher over the fake HLS origin, tests, live matrix scenarios TW-01..08. Cost: one
  GraphQL request per clip, per VOD and per channel checked (⌈n / 15⌉ for n checks of clips or
  VODs not read yet), O(q) to read its q encodings; a clip listing costs ⌈n / 100⌉ requests for
  n clips (at most 10), a video listing ⌈n / 100⌉ for n VODs, O(1) per item (Map by id, cursor
  Set), memory O(n) of ~2 KB per clip, ~0.5 KB per VOD; 0 requests to download a listed clip,
  one media GET per file, streamed, constant memory. A VOD costs 1 GraphQL + 1 usher + 1 media
  playlist before its segments (a listed one: 1 token query instead of the read; one just
  analyzed: none), then 1 GET per segment (~1 per 10 s, O(1) each), memory O(segments) for the
  parsed list and O(k) streams; the expensive read happens once per VOD per token (~20 h),
  never per segment. Clips and VODs kept in 2,000-entry LRUs (6 h at most, never past their
  token), VOD tokens and masters 100, listings 100 each, concurrent reads of one item shared.

- **Twitch live channels, recorded.** A channel link (`twitch.tv/<channel>`, `player.twitch.tv/?channel=`)
  on the air is no longer `live-now`: its analysis is one live item (`isLive: true`, its qualities
  from usher's channel master, titled `<channel> <started-at> <title>`) and its download records the
  stream through `recordHls`. One raw GraphQL query brings the stream and its playback token together
  (`user(login).stream` and `streamPlaybackAccessToken(channelName)`), one usher request the channel's
  master (`/api/channel/hls/<login>.m3u8`, `supported_codecs=h264` for an MP4 profile, every codec
  otherwise; variants without sound left out), and `chooseVariant` picks the quality as for a VOD; an
  analysis's read feeds the recording that follows within a minute. Isaac's defaults (recorder.md
  §7), all under the new option `twitch.live`: from the oldest segment the window holds (`from:
  'window'`, about 30 s on Twitch), **ads left out** (`skipAds: true`: a segment titled other than
  `live` — Twitch titles them `Amazon|…` — or dated inside an `EXT-X-DATERANGE` of CLASS
  `twitch-stitched-ad`; their seconds are counted in `SourceFile.recording.skippedSeconds` and the
  engine's log), a 12-hour cap (`maxDuration`), offline after 10 empty reloads (`emptyReloads`). A
  refused playlist re-signs through a fresh query and usher request, the same quality by its name; a
  re-sign that finds the channel offline, or on a new broadcast id, ends the recording, kept. The
  file is named `<channel> <started-at> <title>` (the broadcast's start, local time) and archived as
  `live-<stream id>-<recording start>`, so recording the same broadcast again later is a new file.
  Nothing live is ever handed to yt-dlp: a failure that would send a VOD there fails a recording with
  the source's own reason. A VOD still recording stays `live-now` (its message names the channel link
  that records it), and a channel on the air stays `live-now` in a batch's checks (a list never
  records). Fake `LiveStream` query, stream tokens and live usher over the fake live origin, 10 new
  tests (record → stop, codecs and audio, ads both ways and `skipAds: false`, the ad predicate, a token
  refresh, the stream ending, an offline channel and one going offline, a refresh that finds it
  offline, never yt-dlp, Stop and Cancel through the engine). Cost: before the first segment 1
  GraphQL request and 1 usher request (none right after an analysis); then 1 playlist request per
  reload (every target duration: about every 6 s on Twitch) and 1 per segment (2 s each: 1,800 an
  hour), O(1) each, memory flat (the recorder's); the ad check O(1) by title, O(r) by the r date ranges
  a window lists (a handful); 1 query + 1 usher request per re-sign, only on a refusal.

- **Twitch sign-in, live playback for a host's player, and how a recording ended.** `twitch.cookies`
  (a `SessionProvider`, read once and every 6 h): the engine passes the `.twitch.tv` cookies of the
  jar it reads for yt-dlp, as it does for Instagram, Facebook and Threads (a host's own
  `twitch.cookies` wins). Only `auth-token` is used, never as a cookie: it goes as `Authorization:
  OAuth <auth-token>` on the single reads that mint a playback token (a clip, a VOD and its token, a
  live stream), on the web player's client id (`twitch.authClientId`, default `kimne78…`: twitch.tv
  mints the token for it); listings and batched checks stay anonymous on yt-dlp's id. Subscriber-only
  VODs, clips and streams then play; a clip a listing found forbidden passes its check signed in and
  is read once more, signed, at download, and a subscriber-only VOD read before signing in gets one
  signed token. Still forbidden with a session is `members-only` ("the signed-in Twitch account has
  no access"), without one `needs-sign-in` as before. A refused session (401, what Twitch answers an
  invalid or revoked token for the whole query; or an integrity check on a signed read) retries the
  read once anonymously, drops the cookies, warns once, and keeps every read anonymous for 30 minutes
  (`SESSION_REFUSED_MS`, as Meta's) before asking the host again; a signed read's integrity check
  never sends clips to yt-dlp. `MediaDownloader.livePlayback(url, {signal, fresh})` (and
  `TwitchSource.livePlayback`, the optional `MediaSource.livePlayback`, the `LivePlayback` type): a
  channel's signed master url (H.264, what a browser's MSE plays), its expiry and the broadcast's
  summary, built and never fetched, sharing the one-minute read of the analysis and the recording;
  `undefined` off the air or for another link. `JobSnapshot.recording` (`RecordingSummary`, now in
  the shared types): how a live recording ended (`stopped`, `endlist`, `offline`, `max-duration`,
  `refused`), its seconds, gaps and lost segments, and the seconds of ads left out, set when the
  download step hands the recording over and cleared by a retry. Fake: `Authorization` on the web id
  (`fake-ok` subscribed, `fake-nosub` without access, anything else a 401), tokens and usher that
  honour it, a log of every query's client id and header; 9 new tests (the header only on token
  reads, subscribed downloads, signing in after a visitor's read, members-only, a 401 → one
  anonymous retry and the 30-minute window, refusals in flight told once, `livePlayback` sharing the
  analysis's query, `JobSnapshot.recording` on stop, max-duration, offline and the end of a
  broadcast, the engine's cookies file signing the token reads). Not checked live (no Twitch
  account): a real `auth-token` minting an allowed token, yt-dlp's id with that token, the integrity
  check on signed token queries, Firefox and Edge exporting `.twitch.tv` cookies on Windows. Cost: 0
  extra requests without a session or with one that works; a refused session costs 1 request once
  per 30-minute window, never per link; the session is loaded once per 6 h (one jar read the engine
  shares); header building O(1); `livePlayback` 0 or 1 GraphQL request and no usher request;
  `JobSnapshot.recording` O(1) memory per job.

- **Bluesky, natively.** Posts (`bsky.app/profile/<handle|did>/post/<rkey>`, its `/quotes`,
  `/likes` and `/reposted-by` pages, `at://` uris) with pictures (`images`, up to 4, and the new
  `gallery` embed, up to 10), a video, or a quote with media of its own, and public profiles
  (`/profile/<actor>`, its `/media`, `/video`, `/posts`, `/replies` tabs read as its media
  posts), all from the public AppView without a session. A post is one `getPostThread`; checks of
  posts not read yet go 25 at a time through `getPosts` (handles resolved once each); a profile is
  one `getProfile` and one `getAuthorFeed` (`posts_with_media`, `includePins`) per 100 posts, every
  post whole in the page. The pinned post comes first and once, never counted in `known`; reposts
  and others' posts are left out. Every file is the author's **original blob** from their own PDS
  (`com.atproto.sync.getBlob`; the PDS found once per account in its DID document, plc.directory
  or did:web), paced per PDS host and read for its `ratelimit-*` headers; a picture falls back to the
  CDN's WebP re-encode when the PDS refuses or limits; a video is the blob's progressive MP4 (one
  stream, started over once if it breaks: a PDS ignores Range), never HLS. A pure quote, a link
  card or a text post is `format-unavailable`; a deleted post or account is `removed`; an account
  labelled `!no-unauthenticated` is `needs-sign-in`. yt-dlp's Bluesky extractor reads the same API
  for posts only: nothing is handed to it. New `LinkSite` `'bluesky'`, option `bluesky`
  (`endpoints`, `pacing`, `pdsPacing`), fake and tests, live matrix scenarios BS-01..04. Cost: one
  AppView request per post (⌈n / 25⌉ for n checks, plus one resolveHandle per handle), O(media) to
  read it; a profile costs 1 + ⌈n / 100⌉ requests for n posts, O(1) per post to list (Map by rkey,
  cursor Set), memory O(n) summaries; one DID document per account per session; one blob GET per
  file, streamed, constant memory; posts kept in a 5,000-entry LRU, handles and PDSs 2,000, concurrent
  reads of one thing shared.

- **SoundCloud, natively (audio only) on `core/hls`.** Tracks
  (`soundcloud.com/<user>/<track>`, on `www.` and `m.`, the embed player's `?url=`), private tracks
  by their secret link (`/<track>/s-<token>`), sets (`/sets/<set>[/s-<token>]`, playlists and
  albums), public profiles (`/<user>`, `/tracks`, `/likes`, `/sets`, `/albums`) and
  `on.soundcloud.com` short links (one 302 through `followShortLink`; the sharer's `si` and `utm_*`
  never reach the API), from the anonymous `api-v2` with the web app's own `client_id`: the
  `soundcloud.clientId` option, else the home page's hydration id, else the last bundle script's,
  streamed and left at the first match (the 2.9 MB bundle never held whole); read once per session,
  and on a 401 the refused id is set aside and another read once (a second 401 is
  `source:format-changed`). A track, a set or a user is one `/resolve`; a set's stubs go 50 a
  request to `/tracks?ids=`, put back in the set's order by id (the API answers unordered; a
  missing id was removed); listings follow `next_href` to its end (pages come back short), every
  track whole in its page, so **a listed track is never read again**. The media is the clear HLS
  fMP4 AAC (160k, else 96k) through `downloadHls`: the 5-minute playlist link is fetched at once
  and minted again if it already ran out, and a segment the CDN refuses re-signs the playlist
  through a new transcoding call; a single fMP4 period is the M4A as it is (no ffmpeg), and the
  engine's M4A step copies the AAC. Old tracks' MP3 / Opus too: progressive through `fetchMedia`
  (re-minted once, resumed with Range), MP3 HLS joined with one `-c copy`. A video profile is
  refused before any request (`invalid-request` / `format-unavailable`). **Refused as what they
  are, never handed to yt-dlp**: DRM-only label releases (`cbc-` / `ctr-encrypted-hls`, about 40 %
  of the catalog; also a DRM key in a playlist) are `format-unavailable` with a message that says
  DRM (decision 6: no new hint), a Go+ 30-second preview is `format-unavailable` unless a whole
  format exists (taken instead), `policy: BLOCK` is `geo-blocked`, a deleted or private-without-
  its-token track is `removed`. A changed API (an unknown shape, no known format, every format
  404) is `source:format-changed` and a DataDome 403 or a WAF home page `source:blocked` (the
  source steps aside 10 minutes): yt-dlp's SoundCloud extractor takes those. New `LinkSite`
  `'soundcloud'`, option `soundcloud` (`clientId`, `endpoints`, `pacing`, `maxListItems`), fake
  (`test/helpers/fake-soundcloud.ts`, on `fake-hls`) and 22 tests, live matrix scenarios SO-01..05
  (SC- is Snapchat's) and an `audio` expectation in the live matrix (M4A download, ffprobe codec
  and length against the track's, a full decode). Cost: one api request per track (resolve), one
  mint per download (+1 per refresh, within the core's budget), then the core's HLS cost (1
  playlist + n segments + 1 init, about 6 segments a minute) or one progressive GET, streamed,
  constant memory; a listing costs 1 resolve + ⌈n / 50⌉ pages for n tracks (pages come short: up
  to ⌈n / 47⌉ seen), O(1) per track (Map by id, cursor Set), 0 requests per listed track at check
  time; a set costs 1 + ⌈s / 50⌉ requests for s stubs within `maxEntries`, O(n) to re-order (Map
  by id); the client id costs 1 page (+ at most k ≤ 9 streamed scripts, early stop) once per
  session, and one more read per refused id; tracks kept in a 5,000-entry LRU (30 min), users 500,
  listings 100; concurrent resolves of one page shared.

- **Stale work folders are cleared at start.** A job works in `work/<hash of url and profile>` so a
  retry or the next launch resumes its partial files, and nothing removed the folders nothing would
  resume: a crash or a killed process mid-download or mid-recording, or a job that failed on the
  network in an earlier run (its folder is kept for a retry in the same run), left them on disk for
  good. The first `restoreQueue()` of an engine (the scheduler's `restore()` calls it) now removes
  every `work/` entry named like a work folder (16 hex digits) that no pending request references:
  the folder of every request in the pending journal is kept, the batch jobs the scheduler restores
  itself included, and so is that of every job the engine already has; anything else in `work/` is
  never touched. Jobs wait for the sweep before using their folder, so it never runs under one.
  Logged as "cleared N stale work folder(s)". 2 new tests with the fake tools (stale ones cleared,
  restored, filtered-out, already-added and foreign folders kept, the restored jobs complete; a first
  launch sweeps nothing). Cost: once per engine start, one `readdir` of `work/`, O(p) to hash the p
  pending requests, O(1) per entry to decide, one recursive remove per stale folder; nothing per job.

- **A download whose connection drops while its file is being opened no longer takes the process
  down.** `fetchMedia` opened the file after turning the response body into a stream: a socket that
  closed in between errored a stream nothing listened to yet (an uncaught error). The file is opened
  first now. Cost: none (the same open, earlier).

- **Threads, natively.** Posts (`/@u/post/<code>`, `/@u/post/<code>/media`, `/t/<code>`, on
  threads.com and threads.net) with a video, a photo or a carousel of both, and public profiles
  (`/@u`, its `/media`, `/replies`, `/reposts` tabs read as its threads). A post is one page
  load (`navigationFetch`: Threads gives a page its data only to a request that says it is a page
  load); a profile is one page load and one `POST /api/graphql` per 10 threads, from GraphQL's own
  cursor, every post's media in the answer, so a listed post is never asked for again. Every post
  the owner wrote with media is an entry (self-thread photos included; reposts, quotes and text
  posts out); a carousel is a `slideshow` exactly as Instagram's; a text post is
  `format-unavailable`. `maxEntries` (default 500), `known`, stalls and resumable chunks through
  `walkCursor`. A private account or a post Threads hides from visitors is `needs-sign-in`; the
  browser's threads.com cookies are used when the host has them. yt-dlp has no Threads extractor:
  a changed page or a wall says so itself (`retry-later`), never handed to yt-dlp. New `LinkSite`
  `'threads'`, option `threads` (`queries` overrides the query names and the listing's `doc_id`),
  `ThreadsSource` reuses `MetaClient` (Pacer, session, retries) and Instagram's v1 media reader.
  Cost: one page request per post, O(size of the page) to walk its JSON once; a profile costs one
  page plus ⌈n / 10⌉ queries for n threads, O(1) per post to list (Map by id, cursor Set), memory
  O(n) summaries; one media GET per file (streamed, constant memory); posts kept in a 5,000-entry
  LRU until their links expire, profile pages 30 min, concurrent reads of one page shared.

- **Snapchat, natively.** Spotlights (`/spotlight/<id>`, `/@u/spotlight/<id>`), public profiles
  (`/@u`, `/add/u`, `story.snapchat.com`): the live story, every curated highlight's snaps and
  the spotlights, a curated highlight (`/@u/highlight/<id>`), one story snap (`/@u/<snapId>`), and
  short links (`snapchat.com/t/`, `t.snapchat.com/`; not verified live). One anonymous page read per
  link (the page's own `__NEXT_DATA__`), no session, no browser, no yt-dlp; the media is fetched
  exactly as the page serves it (spotlights keep Snapchat's watermark: the clean render exists and
  is deliberately not used). A picture snap is a one-image photo post (`slideshow`). A profile lists
  what its page embeds (`complete: false` when the page says there is more); a private account is
  `private`, an expired snap `removed`, a page whose data moved falls back to yt-dlp. Bytes from
  the CDN that are not media fail cleanly. New `LinkSite` `'snapchat'`, option `snapchat`
  (`false` hands it to yt-dlp; `endpoints` overrides the origin, the data marker and the routes).
  Cost: one page request per link, O(size of the page) to find and parse its data once; O(1) per
  item to list (`maxEntries`, `known`), one media GET per item, constant memory (streamed);
  pages kept in a 200-entry LRU and items in a 5,000-entry one, reads of one page shared, so a
  whole profile (its listing, checks and downloads) costs one page request.

**Desktop app**

- **Twitch live: record and watch.** A channel on the air opens Record and Watch instead of a
  download. A recording is a job of its own in a Recordings card above the batches (REC, how
  long, how big; Stop and save, or Discard after a confirmation); it starts from the window
  Twitch still holds, leaves ads out, ends at 12 hours, and lands in Finished tagged Live
  recording, never offered for Download again. Watch plays the stream with hls.js 1.7.3 through
  the main process (`mdc-live:`: Twitch's playlists refuse a local page): signed urls never reach
  the window, segments come only from Twitch's media hosts, streamed through; a refused
  playlist is signed again once for every request it held, at most 3 times in a row. Quitting
  or closing the window with a recording running asks: Stop, save and quit, Discard and quit,
  or Keep recording. Cost: O(1) per job event (a set of recordings), O(r) to draw r rows;
  per player segment one request and O(1) work, per playlist reload O(lines).
- **Sign-in for Threads and Twitch**: the browser session chosen in Settings now also reads
  private Threads profiles the user follows and Twitch's subscriber-only videos, clips and
  streams (the engine passes threads.com and twitch.tv cookies; Twitch's only on the reads
  that mint a playback token). How to sign in lists, site by site, what a session opens,
  in the supported-sites list's own words, and says Twitch's session never chats, follows
  or subscribes. An analysis refused for want of a session now says how to sign in for
  Twitch, Threads, Bluesky and VK too, not only YouTube, Instagram and Facebook.
- **Supported sites, in one list**: `app/src/shared/sites.ts` says for each site what it
  downloads, whether some of it needs the user's sign-in, whether yt-dlp reads it and whether
  the Android app has it, with its words in all 14 languages (`site-words.ts`). The label of
  the link box counts them and opens the list; About shows it too; under a pasted link a
  line says what it downloads, what needs a sign-in and when yt-dlp reads it. The README's
  table and the website's (a new section, in every language) are generated from the same
  list by `scripts/build-site.mjs`, and `site:check` fails when either drifts.
- **Five new sites are tagged**: a link from Threads, Bluesky, Twitch, SoundCloud or Snapchat
  shows its site with its own icon and colour (antd's Threads, Twitch and Snapchat icons; drawn
  ones for Bluesky and SoundCloud), named the same in all 14 languages.

## App 0.2.0-beta.21 · library 1.20.2

A session the site refuses no longer stops a public post; the guide's fourth step; buy me a coffee.

**Library 1.20.2**

- **A session the site refuses no longer stops a public post.** Facebook and Instagram read a
  post with the user's session when the host gives one. When the site answers that request
  with a 4xx it does not give a visitor (measured on 2026-10-26: a Facebook account made that
  day got HTTP 400 for public reels that read fine signed out), the client reads the same page
  as a visitor at once (a fresh session: no cookies, the engine's own user agent, since the
  agent the cookies came with is part of what the site refused), drops those cookies and does not ask the host for them again for
  30 minutes (`SESSION_REFUSED_MS`); the log says the session was not accepted. Stories and
  listings asked meanwhile say to sign out and in again, not "sign in" to someone who did.
  When the visitor is refused too, the error stands as before (the site, not the session).
  Cost: O(1) per request (one status check); the extra read happens once per site per
  30-minute window, never per link.

**Desktop app**

- **The guide has a fourth step, lists and the mix list**: a playlist, a channel or a profile
  opens a preview; the mix list takes links of several sites, YouTube included, as one batch,
  each link with its own format. It points at the Mix list button.
- **Buy me a coffee** in About, under the GitHub star: the app is free and has no ads, runs on
  your computer, and support is voluntary (https://buymeacoffee.com/mediadownloadcore). 14 languages.

## App 0.2.0-beta.20 · library 1.20.1

The desktop's mix list, as the Android app's; YouTube's pause notice only when YouTube pauses.

**Library 1.20.1**

- **The gap between two requests is no longer taken for a cool-down.** `Pacer` kept a site's
  back-off (a refusal, a pause) and the normal spacing between starts in one field, so for a
  second or so after any YouTube request `youtubePausedUntil` said YouTube had paused the
  connection: the desktop showed "YouTube is asking to confirm you're not a bot" when it had
  refused nothing (two YouTube links in a mix list were enough), a YouTube link pasted in that
  second was turned away as "waiting", and a real refusal right after a request was taken for
  a pause already running instead of climbing the ladder. The cool-down is its own field now;
  the spacing is unchanged.

**Desktop app**

- **Links go in one by one or as a whole list**: a field (Enter or Add) and Paste list; a
  paste of several links goes in at once. Each link is a numbered card with its site; a
  repeat ("Already in the list") or text that isn't a link says so inside the form. Clear
  all. Every site is accepted, YouTube included (the desktop reads it through yt-dlp).
- **The format is said and chosen in the mix list**: "Format for all links" (the form's
  selects, starting from its choice), and after the check any link can take a format of
  its own (one song as MP3 among videos): one batch, one folder (`MixRequest.formats`).
- **The preview groups what downloads by site**; "Already downloaded" only for links in the
  list's format. What a mix list is moved behind an info button, in a small dialog.

## Library 1.20.0

- **A format per link in a mix list**: `MixRequest.formats` (by `MixItem.url`) gives some
  links a format of their own (one song in MP3 among videos, one video capped at 720p);
  the rest download in `profile`. Still one batch and one folder: each such link is a
  `BatchTarget` of it, so its check is still taken as it was (nothing checked twice),
  and cancel, retry and `restore()` keep each link's format.

## App 0.2.0-beta.19 · library 1.19.0

Beta 19: the mix list (links of any sites pasted together, one batch) and a new brand.

**Library**

- **`MediaDownloader.analyzeMix(input, options)`**: a pasted text (or a list of texts) of
  links of any sites, checked as one. Planned locally first (`planMix`, O(n)): every link
  once in the order pasted, lines with no link reported, repeats dropped by `linkKey`,
  lists (playlists, channels, profiles, stories: `isListingLink`) left out before any
  request, at most 5000 links. The rest is checked in one pass of the batches' own
  `preflight` (native sources paced, yt-dlp in chunks on the ⌊CPUs/2⌋ pool); links that
  name the same media are kept once, those damaged at the source left out, those already
  downloaded with `options.profile` marked `archived`. Returns `{valid, skipped, summary}`;
  each skip has its line, its reason (`MixSkipReason`) and the engine's `JobError`. A
  bot check keeps the link (checked when it downloads); only a cancel rejects, and leaves
  no metadata behind. `onProgress({total, checked})` per link.
- **`BatchScheduler.scheduleMix(mix | text, request)`**: one normal batch for a mix list
  (`selection` + `flat` + `mix: true`), never one per link; its files go straight into
  `outDir`, named as single downloads. From `analyzeMix`, the batch takes the checks as
  they are (no second check; their metadata reused by the downloads); from a text, it
  checks the links itself. Cancel, retry and `restore()` as for any batch.
  `BatchSnapshot.mix` says so.
- **`planMix`, `linkKey`, `MIX_MAX_LINKS`** in `media-downloader-core/detect` too (pure:
  no Node built-ins, no URL class), so the apps show the list as it is typed.
- **`isYouTubeListing(url)`**: a playlist or channel link (a video inside a list is not one).
- **A batch whose items are all known (archived, or checked by a mix list) asks the network
  nothing** instead of calling the preflight with an empty list.

**Desktop app**

- **Mix list** replaces "one batch per link": several links pasted or dropped at once (or the
  new Mix list button) open a list that shows each link's site as it is typed, checks them
  all at once with a progress bar, then shows what downloads (title, length, already
  downloaded, checked on download) and what was left out and why. Any link can be removed;
  one click schedules the rest as one batch, tagged "Mix list" in Batches. Fourteen languages.
- **New brand**: the wildcat emblem, with the download arrow on its forehead (motto: *As above, so below*). New installer icons for macOS (`.icns`), Windows (`.ico`)
  and Linux (16 to 512 px), the Linux window icon, the mark in About with the tagline, the
  README hero, the website's favicon and mark. Brand assets in `assets/brand/`, tray icons
  ready in `assets/tray/`.

## App 0.2.0-beta.18 · library 1.18.0

Beta 18: VK and X videos natively; one box for every site, which the core names; Facebook
share links work again; the desktop in fourteen languages.

**Library**

- **Facebook share links open as a page load.** facebook.com answers `/share/r/<x>/` with
  400 Bad Request to a Chrome whose request says `Sec-Fetch-Mode: cors` (the only mode
  Node's fetch sends), so every reel shared from the Facebook app failed with "This short
  link leads nowhere." `MetaClient.redirectOf` now sends a hop as a top-level navigation
  (`navigationFetch`, `Sec-Fetch-*` as given, no cookies) and falls back to the site's
  session: at most 2 requests a hop, O(hops) as before.
- **`detectLink(text, aliases?)`**: the site of a pasted or shared link (`youtube`,
  `tiktok`, `instagram`, `facebook`, `vk`, `x` or `web`), the link taken out of the text
  around it and unwrapped from `l.instagram.com` / `l.facebook.com`, and whether it points
  straight at a media file. Regular expressions only (no URL class, for Hermes), O(n). Also
  its own pure entry, `media-downloader-core/detect`, for the apps' renderers.
- **X (Twitter) videos natively** (`XSource`, `x: false` turns it off): the anonymous
  syndication answer behind embedded posts (`tweet-result` with react-tweet's token). MP4
  variants ranked by the shared renditions code; a post with several videos is a list
  (`/video/<n>` names one); GIFs as silent videos; a quoted post's video; video cards;
  `t.co` followed (its meta-refresh page too); the fixer hosts (fxtwitter, vxtwitter…)
  read as X. Images-only posts ("This post has no video."), deleted / protected posts,
  profiles and links of other sites fail with their own messages; an answer of another
  shape hands over to yt-dlp. Posts kept 10 min, at most 1000.
- **VK videos natively** (`VkSource`, `vk: false` turns it off): `al_video.php?act=show`
  without a session, progressive MP4 up to 1080 / 1440, its windows-1251 answers decoded by
  a table (no ICU needed on the phone). Videos and clips on vk.com, vk.ru, vkvideo.ru (and
  `m.`), `?z=video…` on any page, the embed, access keys, `vk.cc`, playlists, albums and a
  community's videos (paged, capped by `maxListItems`). Private, deleted and live videos
  fail with their own messages; HLS-only goes to yt-dlp. Paced (2 at a time, ~1 s apart);
  a captcha sends VK to yt-dlp for 10 min; caches bounded (2000 entries, 10 min).
- **Reads of one item at the same time are made once** (`Coalescer`): a post with k videos
  checked in parallel, or an analysis, its check and its download landing together, send 1
  request to the site instead of k. Each caller waits with its own signal: one that gives up
  leaves alone, and the request is aborted only when every caller has left. Used by X and VK.
- **New failure hints** for the apps to say what happened: `no-video` (a post of pictures or
  text), `live-now` (a stream on the air: download it as a recording once it ends) and
  `stream-only` (only offered as HLS, which needs yt-dlp). All three are final: no retries.
  A video only the full extractor reads (an X post with an external player) goes to yt-dlp
  where there is one and says `unsupported-url` without it (the phone), not "try later".
- **Share links: the session is asked when the anonymous visit ends at the login wall**, not
  only when it gets no redirect (one request in the common case, at most 2).
- **detectLink names the X "fixer" hosts (fxtwitter, vxtwitter, fixupx, fixvx) and
  vkontakte.ru**, as the sources take them, and keeps a parenthesis the link opened
  (`wiki/Foo_(bar)`). Still one pass: O(n), also on 200 000 trailing ")".
- **Portable names write Cyrillic in Latin letters** (ICAO 9303, as Russian passports do):
  "Привет, мир" → "Privet-mir", where the title used to vanish and leave the id alone; й and ё
  are in the table too, for a runtime without Unicode data.

**App (desktop)**

- **One link box for every site.** The run mode (YouTube and websites, TikTok, Instagram or
  Facebook, chosen in Settings with a restart) is gone: every site's source is built at
  start, the box tags the link's site (YouTube, TikTok, Instagram, Facebook, VK, X,
  Website, File), Finished lists every site with its tag, and many links pasted at once
  all go to the review. Sync Up and YouTube's account are always there. An old
  settings.json with `mode` still loads.
- **Fourteen languages**: es, en, pt, id, hi, vi, th, tr, ar, fr, de, ru, zh, it, chosen in
  a select with search (by any language's name for it); the system language first, else
  English; antd's own words follow, and Arabic mirrors the window. Plainer en/es copy, with
  no long dashes.
- **The new failure hints in every language** ("This post has pictures or text, but no
  video", "Live right now…", "Offered only as a stream…").

## App 0.2.0-beta.17 · library 1.17.0

Beta 17: a link that fails for a moment is tried again by itself, another way each time;
batches can be thorough; Instagram reads posts in more ways without a session and says when
a photo's song needs one.

**Library**

- **An analysis someone is waiting for is tried up to 3 times** (`ANALYZE_ATTEMPTS`). A
  failure that may pass (network, a refusal, a page without its data — and, with no yt-dlp,
  a native source's "try later") is tried again after 2–5 s, then 8–15 s, each try another
  way: the sources rank their routes by what just answered and rest the ones that refused,
  and Instagram goes in with the user's session first on the third. A final answer (gone,
  private, needs a session, unsupported) or a cool-down longer than the caller waits
  (`COOLING_DOWN`) is answered at once. `analyze(url, {attempts, onRetry})`; sources get
  `attempt` in `analyze()` and `preflight()`.
- **Links straight to a media file download natively** (`DirectFileSource`, extractor
  "Web"): a link whose path ends in a video or audio extension (`.mp4`, `.webm`, `.mkv`,
  `.mov`, `.m4a`, `.mp3`, `.opus`, `.flac`, `.wav`…) on any site is checked with one ranged
  request (there, its type and size; a web page behind the extension says so) and streamed
  to disk, resumed on a retry — on the phone too, with no yt-dlp. `direct: false` hands them
  to yt-dlp.
- **The archive's search finds a file by its SHA-256** — the whole fingerprint or its first
  characters, besides its title and file name.
- **Thorough batches** (`BatchRequest.retries: 'thorough'`, default `'fast'`): an item whose
  check fails in a way that may pass is checked up to 3 times, only the last answer counting
  (`preflight(items, {attempts})`).
- **Instagram: two more routes without a session, and the current query ids from Instagram's
  own page.**
  - The web client's `web_info` query (`27128499623469141`, then `24368985919464652`, ~15 KB
    of JSON with the v1 item; a host's own first via `queries.webInfo`) is the second
    anonymous route.
  - The post page names the query ids its client preloads (`expectedPreloaders`, by
    `queryName`) and its LSD token: `QueryBook` keeps them (24 h / 30 min) and the
    logged-out post query (`PolarisLoggedOutDesktopWWWPostRootContentQuery`,
    `POST /api/graphql`) reads a post whose page came without its item. One pass over a
    page the source fetched anyway: O(H), lookups O(1).
  - The retired `?__a=1&__d=dis` route (404) is gone; the post query `8845758582119845`,
    which asks for a session nowadays, is tried after every anonymous route.
- **Instagram: each route keeps its own standing** (`RouteHealth`). A 401 / 403 rests that
  route (1 min, doubling, at most 30 min) while the others go on; a 429 still cools the whole
  network down, without counting against the route. Routes are tried best first by a score
  that decays back to neutral (half-life 30 min), so a route that failed once is tried again
  later by itself. O(1) per update, O(R log R) to order R ≤ 5 routes.
- **Instagram: a photo post's song is honest.** No logged-out answer carries it: without a
  session the summary says `slideshow.songNeedsSession: true` (sign in to get it); with one,
  the app API is asked once more for the song (`music_metadata`).
- **Instagram: when every route is walled**, the post's oEmbed (a few KB, no session) tells
  "this post is gone" from "this network is limited".
- **Instagram: fewer requests.** Reads of one post at the same time share one request (by its
  numeric id, whatever link named it); a read post is kept until its media links expire (the
  CDN's `oe`, less 10 min) instead of 10 min; a share link is followed once (its redirect
  only); `l.instagram.com/?u=` links are unwrapped without a request
  (`unwrapInstagramRedirect`).

## App 0.2.0-beta.16 · library 1.16.0

Beta 16: a link pasted while a site rate-limits this network answers at once — "try again
in about 2 min" — instead of hanging for up to ten minutes.

**Library**

- **An analysis someone is waiting for fails fast on a rate limit.** When a site answers
  429 (or another refusal), every request to it backs off together: 30 s, then doubling,
  up to 10 min. An `analyze()` slept through that cool-down — on a razr 50, an Instagram
  profile took 14 minutes to fail. It now waits at most `ANALYZE_PATIENCE_MS` (15 s,
  more than the normal spacing between requests) and otherwise fails at once with
  "<Site> is rate limiting this network: try again in about N" (code `network`, hint
  `retry-later`, `details` `COOLING_DOWN`, `params.retryAfterSeconds`), without
  another request while it cools down. Background work keeps waiting its turn: a batch's
  listing and a sync pass `waitForSite: true`, as can any host's own background
  `analyze()`. `withPatience(ms, work)` gives the same limit to any work.

## App 0.2.0-beta.15 · library 1.15.0

Beta 15: Instagram photos and photo carousels download without signing in, photo posts keep
their song, Facebook videos served only as DASH download on the phone too, share links follow
every hop, and every failure can be copied as a report.

**Library**

- **Instagram photos and photo carousels download without a session.** The embed
  page Instagram serves anonymously now carries no data for a post without a video
  (`contextJSON: null`), so a single photo or a carousel of photos fell through to the
  app API and the web query (403 without a session) and failed as "Instagram is
  limiting this network" — or, on desktop, reached yt-dlp's "There is no video in this
  post". The post page a logged-out visitor gets carries the whole item
  (`xig_polaris_media`: every picture of a carousel), and it is now the second
  anonymous route, between the embed and the app API: one request.
- **Photo posts with a song (Instagram's music sticker) keep their song.** A post's
  `music_metadata` / `clips_metadata` music is read (`MetaPost.music`): the slideshow
  MP4 plays it, `images-audio` keeps it beside the pictures (`sound.m4a`), and an audio
  format extracts it. `MediaSummary.slideshow.audio` says so, and the audio choices are
  offered.
- **Facebook videos served only as DASH download natively.** A video with no
  progressive MP4 was handed to yt-dlp — none on a phone. The DASH manifest is now read
  in one linear pass: the best H.264 / H.265 video stream within the cap and the best
  audio stream are streamed to disk and muxed by ffmpeg as a stream copy (constant
  memory, nothing re-encoded). A video whose media fields are all empty (Facebook
  plays nothing to that visitor) says so instead of "the page changed".
- **Share links follow every hop.** `fb.watch`, `/share/r|v|p/`, Instagram's
  `/share/`, `vm.` / `vt.tiktok.com` and `/t/` followed one redirect and gave up on a
  tracker or a login page in between. Up to 5 hops are followed now, each url once (a
  loop is named as one); a login redirect is read for the page it was asked for
  (`?next=`). A share link Facebook or Instagram only resolves for signed-in sessions
  says so.
- **More link shapes.** Facebook posts in public groups (`/groups/<id>/posts/<id>/`,
  `/permalink/`); Instagram codes under a user name on every route
  (`/<user>/reels/<code>/` was read as the profile, `/<user>/tv/<code>/` not at all).
- **Failure diagnostics.** `diagnoseFailure()` turns any error into a report with the
  site, the media type, the stage, a stable code (`LOGIN_WALL_DETECTED`,
  `REDIRECT_LOOP`, `RATE_LIMITED`, `DASH_AUDIO_MISSING`…), the HTTP status, the time
  spent and a sanitized stack snippet; `platformOf()` names a url's site with one
  hash lookup per host suffix. Nothing is sent anywhere: hosts keep and show them.
- **A TikTok post pasted after a listing is not "gone" for nothing.** The cookie a
  profile listing leaves makes TikTok answer some posts "doesn't exist" (10204); 1.14.6
  read such a post again with a fresh jar only when the session had listed it. On a
  razr 50, after a long session, public posts pasted by hand failed that way on every
  read until the app restarted. Any post now gets that second read once a listing ran
  since the jar was last reset; with a clean jar "doesn't exist" is still believed at once.
- **A failed request says why.** Node's fetch reports only "fetch failed" and keeps
  the reason in `cause`; the native sources' errors now carry it
  (`fetch failed (ENOTFOUND www.tiktok.com)`, `(ECONNRESET)`…) — on a phone that
  lost its network, or a site that dropped the connection, the report tells which.
- **Setup on Windows uses Windows' own `tar`.** A GNU tar earlier on the PATH (Git for
  Windows', MSYS2's) read `C:\…` as a remote host and the yt-dlp archive failed to
  extract.

**Development**

- **A live URL matrix, local only** (`npm run live:matrix`): real public links per
  scenario (watch links, reels, share links, photo posts, carousels, profiles…) read by
  the whole engine, timed, every failure classified, with jitter between links;
  `--native` runs it as the phone does (no yt-dlp), `--download` probes every file.
  Never part of CI.

## App 0.2.0-beta.14.7 · library 1.14.7

Beta 14.7: a TikTok photo post asked as images is no longer "already downloaded" because
its MP4 is, and its folder opens for everyone on a phone.

**Library**

- **A photo post kept as a folder has an archive key of its own.** The key was
  `site:id:format`, so an MP4 of a carousel, its images, and its images with
  their sound shared one record: asking for the images after the MP4 (same
  format and quality) was skipped as already downloaded, on the phone and on
  desktop. A photo post kept as images now adds its mode to the key
  (`tiktok:<id>:video:mp4:best#images`, `#images-audio`) and to the record
  (`ArchiveEntry.slideshow`); the record's `profile` is unchanged. Every
  other key — videos, and photo posts made an MP4 — is the one 1.14.6 wrote,
  so existing archives keep matching with no migration.
- **The engine knows a photo post before downloading it.** The scheduler takes
  it from the listing (`PlaylistEntry.slideshow`) or the link's analysis and
  passes it to the job (`JobRequest.photoPost`), so the preflight skip, the
  forecast's "already downloaded" count and the job's own check use the same
  key as the record. A video asked with an images mode keeps its plain key
  (it is never downloaded twice), and so does an Instagram or Facebook
  carousel with videos, which is the same folder whatever the mode
  (`MediaSummary.slideshow.videos`). A host adding a job itself without
  `photoPost` gets the folder's key looked up first, then the plain one.
  `isArchived()` and `archiveKey()` take the mode as an optional last argument.
- **Downloading a record again keeps its mode.** `BatchTarget.slideshow` sets
  what one entry's photo post becomes; the desktop app's "download missing
  files again" uses it, so a missing folder of images came back as an MP4
  before and comes back as images now.
- **A carousel folder moved to another volume gets normal permissions.** A
  slideshow's folder is assembled in the engine's work folder; when the
  destination is on another volume it was copied with `fs.cp`, which keeps
  the source's modes. On Android the work folder is in the app's private
  storage (`700`), so the folder in shared storage opened for the app alone
  (`adb shell ls`: permission denied). The copy now makes its folders with
  `fs.mkdir` and gives each file the mode a new file gets there; a single file
  copied across volumes too. Still copied to `.partial` and renamed, O(files).
- **A slideshow's work folder depends on its mode.** An interrupted "images +
  audio" download no longer leaves its soundtrack in a later "images only"
  folder of the same post.

**App**

- "Download missing files again" brings a carousel kept as images back as
  images, in the same folder.
- Retrying a failed carousel download (the Failed card) keeps the mode it was
  asked in; it was retried as an MP4.

## App 0.2.0-beta.14.6 · library 1.14.6

Beta 14.6: the false "doesn't exist" after a TikTok profile listing is fixed at its cause.

**Library**

- **TikTok: the listing cookie is dropped when it makes a post "not exist".**
  Testing 1.14.5 on the phone showed the 10204 answers are not a passing
  throttle: the same posts kept getting them across retries and back-offs,
  and all of them downloaded at once with a clean cookie jar. A profile
  listing leaves a cookie that makes TikTok call some of its own posts gone
  (10204) or private (10216). A post this session has seen is now read once
  more in the same attempt with that cookie dropped (one reset shared by the
  downloads in flight, as for the shell page). On the phone, a profile listed
  and its 840 videos downloaded right after (closed and reopened halfway):
  one such reset, no retries, 839/840; the one failure was a post called
  private that two earlier runs had downloaded, which is now handled the same
  way. If TikTok still says so with fresh cookies, the job retries up to twice
  before it is believed.
- **No shared back-off for it.** 1.14.5 made every download wait after each
  such answer, which slowed a whole profile to a crawl (30 videos in 11
  minutes on the phone); only the post's own job retries now.

## App 0.2.0-beta.14.5 · library 1.14.5

Beta 14.5: big TikTok profiles no longer lose videos to a false "no longer exists", and a
batch brought back after the app closed starts downloading at once.

**Library**

- **TikTok: a listed post is not dropped on TikTok's first "doesn't exist".**
  Right after a profile listing, TikTok answers some video pages with status
  10204 for posts it serves again minutes later (measured on a phone: 56 of
  the first 164 posts of an 840-video profile, all downloadable later). The
  reader took that as deleted and never retried. Now a post this session has
  seen (in a listing or an earlier page) is read up to two more times: each
  time everybody backs off (the shared Pacer, longer each time) and the job
  retries; only if TikTok still says so is it reported as removed. A link
  nobody listed is still removed at once. O(1) per read: one cache lookup and
  a map of the posts waiting for another read.
- **A restored batch is not checked again.** `BatchScheduler.restore()`
  re-ran the network preflight over every item before downloading, including
  those already archived: 840 TikTok posts at the site's pace is ~28 minutes of
  "Checking". Restored batches now go straight to their downloads (each item
  is read when it downloads; archived ones are skipped as before).
- **A list asked again checks only what isn't downloaded yet.** Items already
  in the archive skip the network preflight (O(n): one O(1) archive lookup and
  a stat per item, 200 at a time).

## App 0.2.0-beta.14.4 · library 1.14.4

Beta 14.4: a TikTok profile's videos download again when the video page is a shell.

**Library**

- **TikTok: a video page without `webapp.video-detail` is still downloaded.**
  Bulk profile downloads were failing with "TikTok video page without video
  details" while the same video, opened on its own, worked: after a listing,
  TikTok sometimes returns a shell page. The reader now follows that page's
  canonical url, then `/api/item/detail/`, then the post the listing already
  parsed. A listing also leaves a bot cookie that makes later video pages a
  shell with no post: that page is read once more with a fresh jar, which is
  the page the CDN accepts. When the shell remains and the host has an in-app
  browser, that video url is loaded there once — the page a real client gets —
  and its session is what the CDN accepts. That page (and, when TikTok
  includes it, the plain HTTP page) carries the post in a second script,
  `#api-data`, which is read from the HTML already in hand. Each step is one
  request (or an O(1) cache read); a page that really has no data script still
  goes to yt-dlp.

## App 0.2.0-beta.14.3 · library 1.14.3

Beta 14.3: the app quits when it's closed, even right after it opens; macOS saves without
waiting on the drive's own cache.

**Library**

- **macOS: no drive-cache flush before an atomic rename.** Beta 14.2 made
  `writeAtomic` and the compactions of the archive and the pending journal
  flush the temp file to disk before renaming it. On macOS Node turns that
  flush into `F_FULLFSYNC` (the drive's own cache), which can stall on a
  virtual disk long enough that a quit waiting on it never ends: the macOS
  end-to-end run hung on a quit-and-relaunch test in 2 of 3 runs after
  38 green ones. APFS is copy-on-write and renames atomically, so macOS
  keeps the old-or-new guarantee without it (`FLUSH_BEFORE_RENAME`);
  Windows and Linux keep the flush.

**App**

- **Closing the app within a second of opening it no longer leaves it
  running.** The window is shown on its first paint, or a second later all
  the same; that second's timer touched the window even when a quit had
  already destroyed it. The "Object has been destroyed" error opened
  Electron's "Uncaught Exception" dialog, and the process waited on it
  forever (macOS `sample`: every sample of the main thread in
  `-[NSAlert runModal]` under a Node timer). This was the macOS end-to-end
  hang on the quit-and-relaunch test, which closes the relaunched app
  0.86 s after its window. A closed window is now let go, and the timer and
  the "opened again" handler (a second launch while this one quits) check
  that the window still exists.
- End-to-end: an app that doesn't quit within 20 s is killed and the test
  fails right there, saying so, instead of on the 2-minute timeout with the
  worker's teardown stuck for 2 more; a failed test carries what the app
  printed (main-process stdout / stderr), and CI keeps the results of a
  failed run as an artifact.

## App 0.2.0-beta.14.2 · library 1.14.2

Beta 14.2: the Finished tab's check no longer sticks and can bring deleted files back; the
history and the pending queue survive torn writes and power cuts; a Big-O pass on the hot paths.

**Library — durability of the stores (history, pending queue, damaged list)**

- **A record written after a torn line is no longer lost.** A crash or a
  full disk in the middle of an append left part of a line; the next
  append was written right after it, on the same line, so both were
  unreadable on the next start (the history forgot a finished download,
  the pending journal an item). The archive and the pending journal now
  look at the last byte when they open (and remember a failed write) and
  start the next record on a new line.
- **A line of another shape no longer stops the archive from opening.**
  Valid JSON that isn't a record (`null`, `{"op":"put"}`, a key that isn't
  a string) threw in `open()`. Every line is now checked
  (`parseArchiveLine`, `parseJournalLine`) and skipped alike by every pass,
  so record numbers still agree.
- **Records of older versions load, fields of newer ones are kept.** A
  record missing its size or finish time gets 0 instead of breaking the
  sort and the totals; unknown fields survive updates and compaction.
- **Nothing the user had is dropped silently.** Compaction moves the lines
  it can't read (torn writes, operations of a newer version) to
  `<archive>.rejected`. A pending-queue or damaged-list file that can't be
  read back (empty after a power cut, cut short, another shape) is moved
  to `<file>.corrupt-<time>` instead of being overwritten by the next save.
- **Renames only after the data is on disk.** `writeAtomic` and the
  compactions of the archive and the journal fsync the temp file before
  renaming it over the old one, so a power cut leaves the old file or the
  new one, never an empty one. Each `writeAtomic` has its own temp name
  (two writes at once to one file no longer clash); the damaged list uses
  it too.
- Temp files of a compaction a crash cut short are removed on open, once
  older than 10 minutes (a younger one may be another process's).
- `DownloadArchive.removeMany` writes all its removals at once (one write,
  O(k)) instead of one append per key.

**Library — Big-O pass on the hot paths** (measured at 50,000 records or items)

- **Preflight: 7.7 s → 1 ms.** Grouping a batch's items by native source
  copied the group's array for every item (O(n²)); a first TikTok sync or a
  large profile batch froze the event loop for seconds. It pushes now.
- **`LineSplitter`: O(L) per line.** A line still open was glued to each
  new chunk and rescanned from its start; a 2 MB `--dump-json` line over
  ~30 chunks cost ~10 ms instead of ~0.5 ms, for every preflighted item.
  The pieces are now joined once, when the newline arrives.
- **`DownloadArchive.matching(query)`**: every match of a query and its
  bytes in one pass (O(n); O(1) with no filter), for a host that needs all
  of them instead of paging. **`version`** moves with every change, so a
  host can cache what it derives. Sorted views (oldest, largest, smallest)
  are kept until the next change: a size-sorted page went from 13.7 ms to
  1.1 ms.
- `verifyArchive` takes its records from memory: checking 2 files no
  longer reads the whole log from disk (126 ms → 2.7 ms).

**App**

- **Finished: the check's progress ends with the check.** It was shown in
  a toast with no end (`duration: 0`) as well as in the card above the
  table; a progress event arriving after the answer (IPC events and
  `invoke` replies are not ordered against each other) opened the toast
  again and put the card back, so "Checking files… n of n" stayed on
  screen. The progress now lives only in the card, and events outside a
  check this list started are ignored.
- **Finished: a file already gone is not checked again.** With rows
  picked, only those still on disk are checked; picking only missing ones
  turns "Check" off and says why. Missing rows keep their "File not
  found" tag instead of a "Checking" spinner.
- **Finished: one check at a time.** The main process runs check requests
  one after another (never two hashing the same disk), and while one runs
  the list turns off "Check", "Remove missing records", "Download missing
  again" and "Remove from list".
- **Finished: "Download missing again".** Files deleted or moved can be
  downloaded again from the link their record kept: one new batch, each
  into its old folder, under its old name (the list position is read back
  from the file name when it is exactly what that position gives) and in
  its old format. Files damaged at the source stay excluded. "Remove
  missing records" now says it forgets the link too, and points here
  first.
- Removing records from the history is one `removeMany` call instead of
  one call per key; picking records by key reads the archive once (O(n))
  instead of paging through the whole filter.
- **Finished: pages and refreshes reuse what was computed.** The matches
  of a filter are kept per (filter, sort, history version): a page change
  or the 2 s refresh during a batch is O(page), not a filter of the whole
  history. "Check all", "Remove missing", "Download missing again" and the
  CSV export take all matches in one pass (110 ms → 1.4 ms). The
  Missing / Changed filters reuse the last disk scan for 30 s (per record,
  so a file recorded again is looked at again): a refresh stats only the
  new files, not all of them. The batch groups are recomputed only when
  the history changed.
- **Failed downloads window: O(S + F).** The selection was compared with
  the failed list job by job (25M comparisons per render at 5,000 failed,
  10 renders a second during a batch) and the batch filter counted each
  batch with its own pass. Sets and one counting pass now.
- **Jobs table: no sort.** Working, queued and finished rows come out of
  one pass in three buckets, in the order the sort produced (O(J), not
  O(J log J) on every update).
- **Batch items: an item off the page shown no longer re-renders the
  table.**

## App 0.2.0-beta.14.1 · library 1.14.1

**Library**

- **Instagram: anonymous posts read again.** Since 2026-10-15 Instagram
  serves the embed page (`/p/<code>/embed/captioned/`) only to requests
  that say they are a page load (`Sec-Fetch-Mode: navigate`); everything
  else gets the login page, on every network. Node's built-in fetch always
  sends `Sec-Fetch-Mode: cors` and cannot be told otherwise, so the
  anonymous routes now go through `navigationFetch` (node:http(s), headers
  as given) and the embed is asked for with the headers Chrome sends for a
  cross-site iframe. The local fake walls the embed the same way.

## App 0.2.0-beta.14 · library 1.14.0

Beta 14: hardening after beta 13. Found by reviewing beta 10 → 13 and running the suites: no behaviour the
user asked for changes; what changes is what happens at the edges — a
cancel on Windows, Ctrl+C in the CLI, a long batch compacting its journal,
a check of a long history, a large playlist read under load — and the
strings the beta 12 screens had in one language only.

**Library**

- **Windows: a cancel kills the whole tree.** `killTree` terminated the
  parent (yt-dlp) at once and ran `taskkill /T` beside it; `taskkill` walks
  the tree from a live parent, so it found nothing and the ffmpeg under it
  went on writing. Now `taskkill` goes first and the direct kill is the
  fallback once it is done or could not run.
- **The host's signals are its own.** The library no longer installs
  `SIGINT` / `SIGTERM` handlers that call `process.exit()`: they cut short
  the CLI's own Ctrl+C sequence (dispose the engine, freeze the journal,
  then exit) and Electron's quit. The `exit` hook that kills live children
  stays.
- **A large stdout is never cut short.** After a child exited, its result
  was settled 150 ms later whether or not its pipes were drained — a
  playlist's JSON read slowly under load could be truncated. The watchdog
  now waits 2 s of silence and every chunk still arriving re-arms it.
- **Pending journal: appends during a compaction are kept.** A chunk flushed
  while compacting reopened the old file, which the compacted one was then
  renamed over — those jobs were gone on the next launch. Appends and
  compaction now take turns on one lock.
- **Hash pool: no listener left per file.** A check of a long history hands
  one signal to every file; each queued file left its abort listener on it
  until the check ended (a warning past ten, memory over thousands). The
  listener is removed once the file starts or ends.
- **Subtitle streams only into MKV.** The remux mapped `0:s?` for every
  container; ffmpeg refuses to copy text subtitles into mp4 / webm, and the
  job failed as "could not convert". They are mapped for Matroska only.
- **Tests.** The 26-profile conformance and characterization suites skip
  without ffmpeg (as the integrity suite does) instead of failing; `npm test`
  runs at most four files at once, so the real transcodes do not starve
  the timed scenarios. New regression tests for the journal race, the
  shared-signal listeners, the large stdout and the kill order (a child with
  a detached grandchild, as yt-dlp with its ffmpeg).
- **Format plan, the next gates.** Beside the 26 profiles, every shape a
  site serves — H.265 and 10-bit HEVC, VP9 and AV1 WebM, a silent clip, a
  portrait video, one rotated by metadata, variable frame rate — asked as
  mp4, webm and mkv under a cap (24 cases), and the five audio profiles from
  an AAC soundtrack. A conversion-resilience suite: a cancel in the middle
  of a transcode or an extraction leaves nothing behind, a valid file under
  a false extension is a deterministic defect (and the remux makes it
  real), the right container with the wrong codec is transcoded, a cap
  above the source never upscales, a silent source asked for audio is
  "unavailable". CI runs the library on Node 20, 22 and 24, and packs the
  tarball into an empty project to load it as ESM and CJS
  (`npm run pack:check`).
- **A broken conversion is a defect, not a damaged source.** When the file
  that fails its check is what a conversion here produced (ffmpeg said 0 and
  wrote something that does not decode, or ends early), the job fails at
  once: downloading the source again would only feed the same conversion.
  Source damage is still what it was — a file as the site served it,
  confirmed once more, then marked (`checkVerdict`, `stage` on the
  validation error).
- **Bundles follow the profile.** A carousel with a video, asked as a video
  profile, used to come back as the folder the site served; now each clip of
  the folder is made to match the profile (container, codecs, cap) under its
  own name and checked with the profile's rules — its pictures as they came
  (`convertBundle`, `validateBundle({video})`). A slideshow was already a
  video in any container; a silent one asked for audio is "unavailable".
- **The nightly matrix.** `test/matrix.test.ts` (`MDC_MATRIX=1`): the whole
  engine on every source family — yt-dlp, TikTok, Instagram, Facebook, a
  player page — each serving the same real clip through its local fake, ×
  the 26 profiles, in one attempt each, nothing left in the work folder;
  plus a slideshow with and without a soundtrack in every container and a
  carousel with a video. Every output is probed and the probes written as a
  JSON manifest beside a JUnit file; `.github/workflows/nightly.yml` runs it
  every night on Ubuntu and Windows and keeps the reports. The fakes serve
  real media on request (`media: {video, image, sound, duration}`), the fake
  yt-dlp copies `MDC_FAKE_MEDIA_VIDEO` / `_AUDIO` and converts audio with
  `MDC_FAKE_FFMPEG`. `docs/FORMAT-REGRESSION-PLAN.md`: every box but Android.

**App**

- Every string of the beta 12 screens goes through the dictionary: presets,
  link tags, the Downloads filter, the environment card in Settings, the
  speed tooltip and the About credits read in the chosen language (they
  were Spanish or English only).
- The in-browser demo bridge (sample data, ~950 lines) is loaded only
  outside Electron, on demand: it is no longer part of the desktop bundle,
  and a desktop window whose preload failed shows the error instead of
  sample files.
- The window is shown and focused without the always-on-top flip, which
  stole focus on every launch and flashed over full-screen apps on macOS.
- The force-quit watchdog gives the shutdown 10 s (was 4 s): the engine's
  own dispose already gives up on its pool after 3 s, so the pending
  journal always has its time to freeze.
- The header's speed badge read every job on every store change (O(jobs),
  up to 10×/s); the store now keeps the sum per change, O(1), as it does
  the counts. The Downloads table derives its rows, its filter counts and
  the filtered rows in one pass instead of three.

 
## App 0.2.0-beta.13 · library 1.13.1

Beta 13: Core format regression fixes, guaranteed Matroska container remuxing, 26 format and quality profiles conformance matrix, deterministic transformation defect classification, and full UI test coverage. Version 1.13.1 addresses format regression defects, introduces comprehensive 26-profile format guarantees, explicit processing kinds, resolution downscaling, and fail-fast handling for transformation defects:
 
- **MKV conversion & remuxing:** Requests for MKV output (e.g. `video:mkv:360`) are now guaranteed to produce real Matroska container files (`.mkv`). Source MP4/WebM streams are remuxed with stream copy (`-c copy`) when codecs are compliant, avoiding unnecessary generational loss. Primary streams are explicitly mapped (`-map 0:V:0 -map 0:a? -map 0:s?`), preventing attached picture covers from being promoted to primary video.
- **Explicit `ProcessingKind`:** Added `ProcessingKind = 'none' | 'remux' | 'transcode' | 'extract'`. Native renditions and player-page sources declare accurate processing kinds, distinguishing I/O-bound stream copy remuxing from CPU-intensive video/audio transcoding in cost calculations, job tiering, and disk space estimation.
- **Resolution downscaling contract:** When a requested resolution cap (`maxHeight`) cannot be fulfilled natively by the remote source, the smallest stream above the cap is downloaded and downscaled locally via FFmpeg (`scale=-2:targetShort` for landscape, `scale=targetShort:-2` for portrait), guaranteeing `height <= maxHeight` while preserving aspect ratio, even dimensions, and orientation without artificial upscaling.
- **Deterministic defect classification:** Added `isTransformationDefect()` to classify post-conversion container, codec, or resolution mismatches as deterministic defects rather than transient network errors or source media corruption. Failed conversions fail immediately with structured issues, completely eliminating wasteful retry storms that re-download the same identical source.
- **Opus audio extraction optimization:** `extractAudio` stream-copies Opus bitstreams directly when extracting from Opus audio sources, eliminating re-encoding loss.
- **Full 26-profile conformance test suite:** Introduced synthetic media lab generator (`test/helpers/media-lab.ts`) and data-driven 26-profile conformance suite (`test/conformance-26.test.ts`) validating container, codec, resolution cap, and full bitstream integrity across all MP4, WebM, MKV, and audio targets.
 
## App 0.2.0-beta.12 · library 1.12.0

Beta 12: Big O performance optimizations, robust process tree cleanup, and UI/UX refinements. In the core library: guaranteed synchronous cleanup of child processes (eliminating zombie yt-dlp and ffmpeg processes on Windows and POSIX), immediate O(1) hash pool aborts, mutex-protected queue compaction, and fail-safe concurrency slots. In the app: real-time SHA-256 verification progress card with per-file status badges, single reactive toast notification, batch completion alert with 1-click navigation to Finished files, presets with busy guards, and a horizontal 2-column About modal. All emoticons and raw emojis have been replaced across the UI with clean Ant Design vector icons.

**Child process tree termination.** On Windows, exiting or cancelling a download now forcibly terminates the entire process tree using `taskkill /pid <pid> /T /F` synchronously, preventing orphaned background worker processes from locking files or consuming CPU. On POSIX platforms, `SIGKILL` is sent to the process group. Watchdog timers are unref'd to prevent event loop hanging.

**O(1) HashPool aborts.** Cancelled verification tasks in `HashPool` immediately detach and abort before dispatching to worker threads, saving CPU cycles when batches or jobs are cancelled mid-flight.

**QueueStore atomic synchronization.** `QueueStore.load()` now awaits any pending in-flight debounced writes, avoiding race conditions during shutdown or rapid consecutive reload sequences. `PendingJournal` uses sequence counters and promises to prevent file compaction collisions.

**Real-time verification progress card & live tags.** When checking files in the Finished tab, the app displays a dedicated `<Progress status="active" />` card with total counts (`Verificando integridad SHA-256: X de Y`), row-level spinning badges (`<Tag color="processing"><SyncOutlined spin /> Verificando...</Tag>`), and an in-place updating singleton notification toast to avoid toast spam across large playlists.

**Batch completion alert & navigation.** When all jobs in a batch complete, `JobTable` renders a clean success `<Alert>` with a direct action button to switch to `Finished`. In `BatchList`, the `Finished` button is highlighted as primary for completed batches. Native and in-app completion notifications now include a direct action button.

**Horizontal About modal & clean icon design.** The About dialog is redesigned into a balanced horizontal two-column layout separating community acknowledgments from open-source project credits. All emoticons and emoji characters across headers and lists have been replaced with vector SVG icons (`@ant-design/icons`).

## App 0.2.0-beta.11 · library 1.11.0

Beta 11: Instagram reels without a session the way the apps that "just work"
read them, and errors that say what to do — wait (Instagram is limiting this
network) or sign in (Facebook keeps most videos for signed-in visitors now) —
instead of "the site changed". In the app, nothing else changes: the same
screens, the same sign-in help. In the library: what the Android host did
around it, now in it — Instagram posts read without a session, TikTok
sessions handed over like the others, Facebook's signed-in-only videos said as
such, and hosts without yt-dlp.

**Instagram: the anonymous routes first.** A post or reel is read first the
way yt-dlp, cobalt and gallery-dl read a public one, one request each: the
embed page (`/p/<code>/embed/captioned/`, its `contextJSON`) and the Android
app's API (`i.instagram.com/api/v1/media/<pk>/info/`, asked as the app; the
`pk` comes from the shortcode). Only then the web client's query, the post
page (which now also reads `xig_polaris_media.if_not_gated_logged_out`, the
logged-out data yt-dlp reads since July 2026), the browser and the session.
Photos and carousels come through these routes too. A route that says the
post is gone or private ends the search at once.

**"This network", not "sign in".** When every route to a public post got
Instagram's wall (a login page, 401 / 403 / 429, "please wait a few
minutes"), the error is the new `MetaError('walled')`: hint `retry-later`,
"Instagram is limiting this network right now…" — no longer the "login or
verification page" message that read as a request to sign in. yt-dlp still
gets the link where there is one.

**`TikTokOptions.cookies`.** TikTok takes the user's session the way
Instagram and Facebook do: `cookies: () => Promise<SessionCookies |
undefined>`, asked for when the source starts reading and again every 6
hours; pages, listings and media go with it. A host no longer wraps `fetch`
to add it. All three sources also accept `{cookies, userAgent}` from the
provider (`SiteSession`): the agent that earned an in-app sign-in goes with
its cookies. The engine does not pass browser cookies to TikTok by default.

**Facebook videos kept for signed-in visitors.** Since October 2026
facebook.com serves a video page to a visitor without a session as its
"video not found" root with the login form preloaded and no media at all
(`VideoHomeVideoNotFoundRootQuery`). That is now `login-required` (hint
`needs-sign-in`, "Facebook shows this video to signed-in accounts only"),
not `format-changed`; to a signed-in session it is `removed`. A video page
is now read with the user's session when the host gives one (it used to be
loaded only for stories and listings).

**`ytDlp: 'optional'`.** `DownloaderOptions.ytDlp: 'optional'` is for hosts
without yt-dlp (a phone): ffmpeg and ffprobe are required, yt-dlp is used
when there is one. Without it, a link a built-in extractor would hand to
yt-dlp fails with that extractor's own reason (code `unavailable`, its hint
or `retry-later`); a source that would step aside for a while is asked all
the same; anything else that needs yt-dlp fails with `binary-missing`, never
a failed spawn. New: `BinaryManager.available()`, `AvailableBinaries`,
`YtDlpPolicy`. `resolve()` and `resolveBinaries()` still require all three.

## App 0.2.0-beta.10 · library 1.10.0

Beta 10: Instagram and Facebook in the app, one site per run, and the
feedback of beta 9 — failed downloads retried together, files broken at the
source never downloaded twice, downloads first and checks after, 60% of the
processors, a cancel that drops one download only, and the history filtered
and cleaned.

**One site per run.** Settings → Site: *YouTube and websites* (the default:
YouTube and player-page sites), *TikTok*, *Instagram* or *Facebook*. Each run
builds only that site's source and shows only its own screens: Sync Up (and
its schedule) exists only in TikTok mode, YouTube's sign-in only in the web
mode, and a link of another site is refused under the field before anything
is asked (the main process refuses it too). Finished shows the files of that
site. Changing the site restarts the app (a button does it), and waits for
the open batches. This ends the TikTok bug where Sync Up seemed to start
from Finished → Check again: in any other mode it can't run at all.

**Failed downloads, together.** The Failed card opens the list of this
session's failed downloads from every batch; pick some or all and they go
into one new batch, each to the folder, format and list position it had
(library: `BatchRequest.targets`). Files damaged at the source are listed,
not offered.

**Damaged at the source.** A file that comes down whole and still fails its
check (it doesn't decode, ends early, ffprobe can't read it — e.g. "moov atom
not found") is downloaded once more to be sure, then marked *damaged at the
source* and never downloaded again: not by that job's remaining retries, not
by a later batch (the check says so per item), not by a loose job. Its
tooltip says why. Settings → Damaged at the source lists them and lets one
try again (library: `MediaDownloader.damaged`, `damaged.json`, hint
`damaged-source`).

**Download first, check after.** Settings → Download first, check after: a
batch downloads back to back, then checks all its files at once (new batch
status `validating`, with its progress). A broken file is marked damaged and
kept where it is; one failing for another reason is removed so it can be
downloaded again (library: `validationTiming: 'after-batch'`,
`checkLater()`, `JobSnapshot.validationPending`).

**Up to 60% of the processors.** Settings → Allow up to 60% of the
processors raises the most downloads at once from ⌊CPUs/2⌋ to ⌊CPUs × 0.6⌋,
about 40% staying free (live; on machines where that is the same number the
setting says so). Library: `maxCpuShare`, `setMaxCpuShare()`.

**Cancel drops one download.** Cancelling a download (Downloads, or the new
Cancel on a batch's Items) removes only that item: the batch goes on and
completes without it, counts it apart (`BatchCounts.cancelled`), and "Retry
failed" leaves it alone. Cancel batch now says it stops everything.

**Finished.** Filter by Integrity (verified, not checked, checksum only,
damaged at the source, missing, changed) and Size, sort by size or date —
all in the main process, over the whole history. *Remove missing records*
forgets the files deleted or moved since (the files you still have are not
touched).

**Nothing waits forever.** A player-page lookup is bounded (45 s, then the
attempt fails and is retried) and the app's hidden browsers never wait on a
page that stopped answering — a page that never gave its player a link used
to keep a download "Downloading" and its batch open indefinitely. Cancelling
a TikTok page no longer closes the browser window other lookups share.

**Signing in, explained.** Settings → Cookies → *How to sign in* walks
through using a signed-in session: sign in on your usual browser (Google /
YouTube, Instagram, Facebook), choose that browser in the app, allow the
one-time permission your system asks for (macOS Keychain "Always Allow",
Safari's Full Disk Access, closing Chrome / Edge on Windows or using
Firefox, the Linux keyring). The same steps are in the README and on the
website, and "Sign-in required" points to them.

**Website.** A "New in beta 10" section, the sign-in guide for each system,
and Instagram and Facebook in the features — English and Spanish.

**Found by a live regression, fixed.** Every site was run for real (a
YouTube video, a TikTok profile, an Instagram post, a Facebook video and a
Facebook page, two player-page searches of hundreds of results):

- A file served whole but unreadable ("moov atom not found") was retried
  four times as an unknown error; it now counts as a broken file and is
  marked damaged at the source on the second try.
- Instagram / Facebook answering 403 waited out 30 s + 60 s of cool-downs
  before failing (91 s on screen with nothing happening). A 403 is a wall,
  not a rate limit: the browser tries once, then yt-dlp reads the link at
  once — the Instagram post now downloads in 10 s. Any other 4xx but 429
  (e.g. a 400 to the listing query) hands the link to yt-dlp at once too,
  and when yt-dlp doesn't know the link either the user reads the site's
  reason, not "Unsupported URL".
- Errors read as words ("Error invoking remote method…" is gone), with how
  to sign in when a site keeps something for signed-in sessions.
- In a batch longer than the jobs the engine keeps in memory (1,000), the
  files released before the check after the batch were never checked; they
  are kept until it runs.
- The check after a batch shares the CPU by file size (largest first, more
  threads): the same kind of batch checked in about half the time.
- "Retry failed" no longer offers files damaged at the source; a forecast
  without sizes says so instead of showing dashes; cancelling a batch while
  it checks leaves no file saying it still waits.
- Two old tests that timed the machine (a 5 s bound, 15 ms sleeps) failed
  under load: they now count requests and use their own clock.

Performance, measured against the branch before these changes with the
perf harness (same machine, at rest, alternating order): batch, stress and
archive within noise or better — nothing on the hot paths got slower.

Tests: library 300 (new: the same cancel and check-after scenarios on
YouTube, TikTok, Instagram, Facebook and player-page fakes, a stuck player,
unreadable files, a 403 / 400 from Meta, a long batch checked after), app
136 unit + 15 end-to-end (one site per run, cancel one, failed into one
batch, check after with a damaged file, history filters and cleanup) —
the library suite passed three times in a row.

### Library 1.10.0 · Instagram and Facebook


**Instagram and Facebook, natively.** Two new built-in extractors beside
TikTok's, on the same architecture (`MediaSource` + `HttpSession` + `Pacer` +
retries + circuit breaker + `BrowserAssist` + yt-dlp fallback), with the
plumbing lifted into `src/sources/meta/` so the two share it instead of each
carrying a copy of TikTok's:

- `MetaClient`: the session, the pacer, reads retried after the shared
  cool-down, a browser for pages that only open in one, stepping aside for
  10 minutes when the site blocks the source, and — new — a signed-in session
  supplied by the host (cookies), since both sites keep stories and most
  listings for signed-in accounts.
- `walkCursor`: cursor pagination with the guarantees of TikTok's date walk
  (O(1) de-duplication, stalls, incremental "caught up" after 20 known items,
  resume from a kept cursor, a cap falling mid-page re-reads that page).
- One post model (`MetaPost`: video / photo / carousel / story) and one
  download path (best encoding for the profile, every mirror of each; a
  slideshow MP4 or a folder of pictures; a carousel with videos as a folder).
- `src/sources/renditions.ts`: the encoding ranking and the format choices,
  shared with TikTok (TikTok's behaviour is unchanged; 38/38 tests as before).
- `InstagramSource`: posts, reels, carousels and photos, whole profiles (the
  web client's timeline query by cursor; the feed API when signed in), stories
  and highlights (signed in). `FacebookSource`: videos, reels, posts with a
  video, a profile's or page's videos (the Videos tab, then the web client's
  pagination query with the page's tokens), stories (signed in).
- `DownloaderOptions.instagram` / `.facebook` like `tiktok`. Both take the
  user's session from the browser cookies the engine already reads for yt-dlp
  (`parseNetscape`, new), else `cookiesFile`. Query ids live in one file per
  site and can be overridden (`queries`).
- Errors in the engine's terms: `needs-sign-in` for stories without a session,
  `private`, `removed`, `retry-later`; a login wall or checkpoint →
  `source:blocked` (yt-dlp for a while); a changed page or rotated query →
  `source:format-changed` (yt-dlp for that url).
- 38 new tests against local fakes of both sites (login walls, rate limits,
  checkpoints through a browser, rotated queries, DASH-only videos, stories,
  carousels, cursor paging, memory and incremental listings). Full suite 274.

Not in this release yet: Sync Up for Instagram and Facebook accounts, and
verification against the live sites (the fakes serve the shapes known when
this was written; see the README).


## App 0.2.0-beta.9 · library 1.9.0

Beta 9: a player-page link works again without being configured first.
Library 1.9.0 adds the `unsupportedUrlSource` option and the
`source-fallback` attempt strategy; nothing existing changes.

**Player-page links on any site, none named.** A search or video page of a
player-page site that wasn't in the user's `sites.json` failed with
"Unsupported URL" (yt-dlp has no extractor for it), though the app reads such
sites natively. Now any http(s) link yt-dlp doesn't support is tried as a
player page, whatever its host — no site is named in the code or shipped with
the app:

- `unsupportedUrlSource(url)` (new option): the engine asks the host for a
  source made for that url's host — the app makes a `PlayerPageSource`, its
  browser kept on that host — and uses it instead of failing. When it finds
  videos there, the host is read that way from then on.
- In all three places a url meets yt-dlp: the preview (analyze), the checks
  (preflight) and the downloads — a job queued before a restart, refused by
  yt-dlp, retries with the host's source at once (`source-fallback`, not one
  of its retries).
- A page that is no player page either (no video page, no videos listed)
  still fails with yt-dlp's "Unsupported URL". YouTube links and hosts a
  configured site claims never take this path.
- Chunked checks match yt-dlp's `ERROR: Unsupported URL: <url>` to its own
  url; it names no id, so it used to be assigned in order.

**Integrity checks ~17% lighter on H.264.** Profiled with a new performance
harness: orchestration already runs at 99% of what the tools allow, memory
stays flat however many jobs run, SHA-256 goes at 1.2 GiB/s. The one heavy
cost per job is the `full` check, ffmpeg decoding every frame. It now skips
the deblocking filter, which only smooths frames already rebuilt and reads
nothing from the file: every error is still found (60 of 60 random
corruptions, as before), for 5.28 s → 4.39 s per minute of 1080p H.264 on one
thread. VP9 and AV1 barely change.

**Performance harness** (`npm run perf`): every benchmark run several times in
fresh processes, medians compared with a per-machine baseline (worse/better
past a threshold, `--fail-on-regression`), the machine recorded with each
result; `npm run perf -- profile <scenario>` writes a CPU profile and lists
the hottest functions. Benchmarks print `--json`; a `validate` scenario
times integrity checks on a real 1080p clip (needs ffmpeg).

## App 0.2.0-beta.8 · library 1.8.0

Beta 8: YouTube's bot check handled one step at a time — tokens the app
makes, then the user's choice (sign in, a browser, or wait) — and the fixes
found on the way. Library 1.8.0 adds `PoTokenService`, `PoTokenBroker`,
`YouTubeGate`, the cookie helpers, `setYouTubeAccount` / `clearYouTubeAccount` /
`waitOutYouTube`, the `youtube` event and the `youtube.*` options; nothing
existing changes.

**YouTube's attestation key is learned, not kept in the code.** GitHub's
secret scanning flagged the API key the attestation sends. It was YouTube's
public browser key — served to every visitor in youtube.com's own scripts,
not a credential of this project — but it belongs to YouTube and changes when
YouTube wants. The app now learns it from YouTube, cheapest way first: memory;
the header the page's own attestation call sends (nothing fetched); the last
key that worked, on disk; YouTube's scripts. A key YouTube refuses is learned
again. A test fails if a Google API key ever appears in the repository.

**YouTube's "confirm you're not a bot": a ladder, and no more Keychain prompts.**
On a Mac, choosing Chrome's session raised the Keychain prompt again and again:
every yt-dlp process — each check, each download — read the browser's cookies
itself. And the session didn't help when the browser wasn't signed in: the
downloads went on only because choosing a browser ended the pause.

- **Cookies read once.** A browser's cookies are read into a private jar once
  (again after 6 h, or another browser) and every run gets its own copy: one
  Keychain prompt for a whole batch. Runs no longer share one cookies.txt that
  yt-dlp writes back to as it exits.
- **A ladder, climbed only when YouTube refuses** (`src/youtube/gate.ts`):
  1. PO tokens and retries after 15 s, 1.5 min and 5 min (they don't use up a
     download's retries);
  2. still refused: YouTube requests **stop and wait** — not failed — and the app
     says why and offers to sign in, use a browser's session, or wait 30 min;
  3. the user's choice: everything goes on from where it was.
- **PO tokens, made by the app — for learning** (README, "YouTube: attestation").
  YouTube's attestation runs in a youtube.com page the user never sees (an
  offscreen view attached to no window), in two ways that share little; the
  library's `PoTokenService` picks the one that works, cools a broken one down
  and reports it; a yt-dlp plugin asks a loopback broker for each token. Checked
  on a real connection: tokens in ~2 s, then ~0.5 ms each, accepted by yt-dlp
  with only the `mweb` client (which needs one).
- **Signing in inside the app**, only when YouTube requires it and the user
  agrees: Google's own page in a window, the session kept in the app's
  partition, YouTube's and Google's cookies only — for YouTube runs only.
  Settings shows the account and signs it out.
- **The YouTube watch** (daily workflow): the app's probe on a real Electron and
  yt-dlp. When YouTube changed something, one pull request in English and
  Spanish says so and what to do; it closes itself once healthy again.
- yt-dlp gets only the app's JavaScript runtime (`--no-js-runtimes` first): an
  installed Deno no longer takes over.

**Fixes found on the way.**

- A cancel that came just before yt-dlp started was lost: the download ran to
  the end and its file was kept. Checks and previews had the same hole. A
  signal aborted already never fires `abort` again; it is checked first now.
- A test of player-page listings failed about once in thirty runs on some
  Windows machines: the test servers took any free port, and when Hyper-V, WSL
  or Docker move the free range down (here 1024–15000) one of the ports Node's
  fetch refuses ("bad port") comes up now and then. The test servers never take
  one now; a timing assertion became a check that the pages go out together.

**The Windows update asks for an administrator when it must.** To know
whether it could write the app's folder, the update asked Windows with
`fs.access`, which only reads the read-only attribute: it answered yes for
Program Files, which only an administrator may write (seen on a real
machine: access OK, writing EPERM). An install for everyone was updated
anyway — the installer asks for permission itself — but the app never went
through its own administrator prompt (`elevate.exe`), and a copy in Program
Files that Windows has no record of was updated as one for this user only,
putting a second copy in the user's folder. The app now checks by writing a
file and deleting it.

- `mdc doctor` checks the data folder the same way: on Windows it said a
  folder only an administrator may write was fine.
- The Windows update test checks that an install for everyone, updated by
  a user who is not an administrator, goes through the administrator's
  prompt.
- `scripts/stress.ts` runs on Windows: it uses the tests' fake tools (Node
  scripts) instead of shell scripts.

## App 0.2.0-beta.7.2 · library 1.7.1

Beta 7.2 replaces beta 7.1, which is withdrawn: everything in beta 7 and
7.1 is here — Sync Up, retrying failures by cause, Downloads and Finished by
batch, TikTok slideshows, several links, notifications, first steps, and
YouTube's bot check handled — with the fix below.

**The update on Windows, fixed.** "Update now" downloaded the new version,
the app closed — and nothing was installed; the app had to be reinstalled
by hand. Reproduced on a real Windows machine: the PowerShell helper that
was to run the installer once the app closed died with the app, before its
first line. Now:

- The app hands the update straight to the installer, in its own update
  mode (`--updated`, as electron-updater does): the installer waits for the
  app to close, installs silently and starts the new version.
- It installs for the scope the app was installed for (this user, or
  everyone), read from Windows' record of the install, and asks for an
  administrator's permission — the usual Windows prompt — only when an
  install for everyone needs it.
- Every step is written down; if the update doesn't go in, the next start
  says so ("The update to … did not finish") instead of nothing at all.
- The app closes for the update even if something hangs while it shuts
  down (after 20 s).
- A test installs the app on a real Windows machine and updates it, for one
  user and for everyone, and with an installer that fails.

**Library 1.7.1.** `isYouTubeUrl()` is exported (1.7.0 listed it but kept it
inside), and it publishes without npm's `always-auth` warning.

## App 0.2.0-beta.7.1 · library 1.7.0

*Withdrawn: replaced by 0.2.0-beta.7.2, which includes all of it.*

Beta 7.1 replaces beta 7, which is withdrawn: everything in beta 7 is here,
with the fix below. Coming from beta 6, this is the whole beta 7 — Sync Up
(TikTok accounts kept in step with their folders), retrying failures by
cause, Downloads and Finished by batch, TikTok slideshows, several links at
once, notifications, first steps — described under 0.2.0-beta.7 below.

**YouTube's "Sign in to confirm you're not a bot", handled.** Too many
requests in a short time — pasting a Mix, reloading its list a few times
and checking its 50 videos at once — makes YouTube block the connection for
a while. Every video then failed with that message and was marked
*unavailable*, as if it had been removed. Tried on a real case: once
blocked, every YouTube client yt-dlp offers is refused; only time or a
signed-in session gets through. Now:

- It is a *bot check*, not "unavailable". Items the check could not ask
  about are downloaded anyway, and checked as they download.
- YouTube is asked politely: checks pause between requests (yt-dlp's own
  "sleep" pace) and downloads start a second apart.
- When YouTube blocks, every YouTube request pauses together — 5, then 10,
  then 20 minutes — and the downloads try again by themselves, instead of
  each one hammering it and failing.
- A banner says so, with the time they try again, and offers to go on at
  once with the session of a browser where you are signed in to YouTube
  (Safari needs Full Disk Access to read its cookies; Chrome, Firefox, Edge
  and Brave don't). Browser cookies now apply at once, without restarting.
- A browser's cookies that can't be read are named as such
  (*cookies unreadable*).

**About** links the repository, and asks for a star on GitHub if the app
helped you.

**Library.** Error code `blocked` and hints `bot-check` /
`cookies-unreadable`; `setCookiesFromBrowser()` (live) and
`youtubePausedUntil`; `isYouTubeUrl()`. `Pacer.resume()` now wakes the
callers already waiting out a cool-down (before, they slept it through —
TikTok's verification-page recovery benefits too). Each release starts its
winget manifests by itself.

## Library 1.6.1

**Capped listings of player-page sites stop at the cap, whatever page answers
first.** The listing reads its first pages together and then reads ahead only
as far as the cap needs — sized by page 1. When page 1 answered last, the
size was unknown and the read-ahead went on: 26 of 20 pages in the worst
case instead of 2 (the results were right, the requests weren't needed). The
page size is now the largest page read so far, which never undercounts.
`package.json` is in the form npm publishes (`npm pkg fix`), and the
workflow builds before publishing, so publishing warns about nothing. The
library publishes with npm Trusted Publishing: no token is stored anywhere.

## App 0.2.0-beta.7 · library 1.6.0

*Withdrawn: replaced by 0.2.0-beta.7.1, which includes all of it.*

**Sync Up: TikTok accounts kept in step with their folders.** Turned on in
Settings, it sits next to New download. Add an account — its folder may
already hold its videos, recognized by the post id in their names, the
history or their tags — and each sync downloads only what the folder is
missing, as one ordinary batch: now, daily at a time, or every few hours
(while the app is open; `mdc sync run --due` from cron, launchd or Task
Scheduler otherwise). The first sync reads the whole account, to fill gaps
anywhere; later ones stop where the folder's posts start (seconds). A folder
keeps one format: a folder of MP4 files gets MP4, and a different format, a
mixed folder or a stray file in another format is refused before anything
downloads. *Check* tells what is new without downloading; *Full check* also
tells what TikTok no longer lists. Each account keeps a history of its runs.
Tried on a real 835-file folder: 4 posts were missing (3 of them years old);
they were downloaded as MP4 like the rest.

**No warnings.** Every deprecated Ant Design 6 property is gone (Space
`orientation`, Alert and notification `title`, Drawer `size`, Statistic
`styles`, Modal `mask`, `Space.Addon`, `Listy` instead of `List`), and the UI
tests now fail on any warning, so none comes back.

**Retry what failed, and see why.** A batch counts its failures by cause —
removed, private, network, rate-limited… — and items the check found
unavailable, on its card and in the run report. "Retry failed (N)" downloads
them again in one click: the batch reopens, counts again and closes with true
totals. Retrying a single download now goes through its batch too (before,
the batch never heard of it and kept stale counts). The report retries every
batch at once.

**Downloads and Finished, one batch at a time.** Both tabs filter by batch;
a batch card opens either one already filtered. The history records each
file's batch, so Finished filters batches of earlier sessions too (files of
older versions stay under "All batches"). Finished can also check files again
(re-hash against the recorded SHA-256, four at a time, with progress), export
the list as CSV (UTF-8, opens in any spreadsheet) and forget entries (the
files stay on disk).

**TikTok slideshows.** Photo posts download as an MP4 (each image N seconds,
default 3, over the soundtrack — cut, or padded with silence), as a folder of
images with the soundtrack, or as images only; with an audio format, just the
soundtrack. The choice sits in the preview (and in a small window for a
single link) and is remembered. Images of different sizes are fitted one by
one (ffmpeg would otherwise drop the timeline at each size change), in TV
range 4:2:0 that every player reads. A listed slideshow needs no page
request: its image links open without a session.

**Several links at once.** Paste, drop or "Paste" a list: each link becomes a
batch with the chosen format, quality and folder, after a review where any
can be left out; repeated links are counted out.

**Notifications outside the app.** A batch that ends while the app is in the
background notifies through the system (a click brings the app back); the
Dock / taskbar icon shows the progress of the batches at work and, on macOS,
how many items are left.

**First steps.** On the first launch a three-step guide shows how to download
(paste a link, choose what you get, download); Header → Guide replays it.

**For users of earlier versions.** Checked against a real data folder from
beta 4–6: settings, the 935-file history, the logs of earlier runs and a
pending queue in the old format all open as they were.

**Library.** `SyncManager` (subscriptions, `check` / `run` / `runDue` /
`startSchedule` / `whenDone`, a lock per subscription across processes),
`scanFolder()`, `folderFormat()`, `syncProfile()`; `mdc sync`
(list / add / run / remove, `--due`, `--deep`, `--dry-run`); batches can
download `flat` into their folder. `scheduler.retryFailed()` / `retryJob()`, `problems` on batch
snapshots, `archive.list({batchId})` and `archive.groups()`,
`verifyArchive(…, {keys | batchId})` in parallel, `SourceFile.bundle` (a
folder of finished files), `slideshowOptions()`. Ready for npm (a
`lib-v*` tag publishes it with provenance; the package is 282 kB without
source maps). winget manifests are generated and schema-checked for every
release.

## App 0.2.0-beta.6 · library 1.5.0

**Finished tab.** Every finished file of every session, newest first, from the
download archive (so it survives restarts and "clear finished"): search by
title or file name, ignoring case and accents; play a file, show it in its
folder, copy its path, open the downloads folder. Each file says whether it was
verified (the archive now records which integrity check it passed — a file
downloaded with the check off says "not checked", not "verified"), and whether
it is still on disk or changed since. The page shown follows new completions,
at most every 2 s. Batches get an Open folder button. Files open by archive
key: the renderer never hands the system a path.

**Run report.** A window that sums up the three tabs — the run ID (the id in
every log line of this run), pending / in progress / finished / failed, each
pipeline stage with what is in it right now, every batch with its progress and
time left, recent results and failures. It reads the app's state every 15 s
(or on demand), not on every event, and copies as plain text.

**TikTok: posts a profile counts but doesn't list.** TikTok's post count
includes posts its public listing never returns (private, deleted, visible
only to the author). A real 1,022-post profile listed its 1,018 public posts
back to its first one and TikTok said there were no more; the preview offered
"Load all" anyway, which brought nothing. Listings now say whether they
reached the end: the preview explains the gap instead, and a listing that
really stopped short (refused, stalled) says so and offers to continue.

**TikTok: veteran profiles.** The listing stopped at September 2016; videos
from musical.ly (2014–2016) keep their dates on TikTok, so a veteran
profile's oldest posts were silently left out. Tested with a 10-year,
1,300-post profile.

**Website.** A landing page (GitHub Pages, published from `docs/` by a
workflow) with every feature and how it works, in English and Spanish; it
reads the newest release and offers the installer that fits the visitor's
computer. The README demo now shows the Finished tab and the run report, and
its screenshots come from a real, verified download.

**Faster, lighter.** `DownloadArchive.list()` — pages of the history from
memory after one read of the log (10,000 records: first page 128 ms, then
0.06 ms; a search 3 ms). The app's job counts are kept per change instead of
scanned; the stats, the tab counts and the download form re-render only when
what they show changes, not on every progress event; the Completed count is
right past the 1,500 jobs the app keeps in memory.

## App 0.2.0-beta.5 · library 1.4.0

**Whole TikTok profiles.** The preview tells how many posts a profile has and
offers **Load all (N)**. The listing runs in chunks of 500, each kept as soon as
it is in: a refusal half-way returns what was listed, a cancel keeps it, and
loading again continues from there (measured against the local fake: 1,100
posts, the last 600 in 41 listing pages instead of re-reading the first 500).
Requests may ask for up to 50,000 items. A **Published** column shows each
post's date.

**Files dated by publication.** Every finished file gets its publication date
as modification time — TikTok's post time, yt-dlp's timestamp (or noon UTC of
its upload day) for other sites — so sorting a folder by date sorts by
publication.

**Player-page sites, configured locally.** Sites whose videos sit on player
pages listed by paged searches can be added by the user in a local
`sites.json` (none ship with the app). A search link lists every page (500 by
default, Load all), reading pages ahead in parallel; each pick is checked
over HTTP, its media link is read from the site's own player in a hidden,
sandboxed window, and the file comes straight from the media server with
resume. An MP4 is kept byte for byte as served (no conversion, no tag
rewrite): it is only validated, and dated by the server's Last-Modified.
The disk forecast sizes each pick at the resolution its player offers (a
1080p or 480p file, not an 8K-class "best" that would block a large batch). Measured on a 195-result, 9-page search: listed in 3.8 s (6.3 s
reading only the linked pages), all 195 checked in ~13 s (22.5 s at 6 at a
time), two ~200 MB videos downloaded and validated in ~14 s.

**Shared media fetch.** TikTok and player-page sites stream through one
`fetchMedia` (Range resume, stall watchdog, exact-size check).

## App 0.2.0-beta.4 · library 1.3.0

**TikTok behind its verification page.** When TikTok answers with its "please
wait" check (which yt-dlp could not get past either), the desktop app opens the
page in a hidden, sandboxed browser window where TikTok's own check passes by
itself, then continues over plain HTTP with that session. Nothing is solved by
our code; a captcha still hands TikTok to yt-dlp. Listing a profile shows its
progress and can be cancelled; listings are kept for 15 minutes (reopening is
instant, asking for more continues where it stopped) and a listing more than
5% short gets a second pass.
While a link is read the app shows how far it got ("150 of 500 items"), with
Cancel.

## App 0.2.0-beta.3 · library 1.2.0

**Updates inside the app.** The app looks for new releases (at start-up, every
6 hours, or from About); one button downloads the update in the background,
verifies its size and GitHub's SHA-256, installs it and restarts. macOS swaps
the app bundle after quitting (Squirrel needs a paid certificate, this doesn't),
Windows runs the installer silently, Linux replaces the AppImage or installs the
.deb / .rpm through the password prompt. Tested end to end on macOS: a packaged
app updated itself to a new build in under 4 seconds.

**TikTok, built in.** Paste a TikTok video, short link or profile (`tiktok.com/@user`): the
library reads TikTok itself (public pages and listing, no yt-dlp, no request
signatures) and backs up whole profiles — up to 500 posts by default — through
the same preview, pool, retries, conversion and integrity checks. MP4 prefers
H.264 (plays in cars and TVs); audio formats fetch the smallest encoding.
Requests are paced and back off together; a verification page hands TikTok to
yt-dlp for 10 minutes instead of being solved. Tested against a local fake
TikTok (19 tests) and the real site.

**Car & USB friendly names (default).** Files and playlist folders are named
with ASCII letters, digits and hyphens only — accents become plain letters
(Canción → Cancion), emoji and symbols are dropped — because car stereos, TVs
and FAT32 USB sticks often skip anything else:
`001-Coldplay-Paradise-Official-Video-1G4isv-Fylg.mp3`. Titles with no Latin
form fall back to the media id. Settings → "Car & USB friendly names" switches
back to the original titles; the library option is `fileNames`.

**Windows setup.** The installer survives files locked by an antivirus while it
installs.

**MP3 tags car stereos can read.** MP3s now carry ID3v2.3 tags plus an ID3v1
fallback instead of ID3v2.4, which many car stereos and older players ignore.

## App 0.2.0-beta.2 · library 1.1.0

**Linux.** The desktop app now ships for Linux, x64 and arm64:
`.deb` (Ubuntu / Debian), `.rpm` (Fedora / RHEL / openSUSE) and `.AppImage`
(most other distributions). The `.deb` installs an AppArmor profile so
Chromium's sandbox works on Ubuntu 24.04+.

CI runs the app's unit, UI and end-to-end tests on Ubuntu (on a virtual
display) next to macOS and Windows, and builds the Linux packages on every
pull request. Same features as 0.2.0-beta.1.

**Language.** The first launch follows the system's ordered list of preferred
languages: the first of Spanish / English in it wins, English when neither is
there. The EN / ES switch still overrides it and is remembered.

**macOS.** The app is now ad-hoc signed. Earlier betas were not signed at all,
which Apple Silicon Macs refuse to run (reported as "damaged"); Intel Macs
only showed the usual warning. Opening it the first time still needs
System Settings → Privacy & Security → Open Anyway, until it is signed and
notarized with an Apple Developer ID.

## App 0.2.0-beta.1 · library 1.1.0

**Preview before downloading.** A list (playlist, Mix, channel) now opens a
preview first: every item with its title, channel and length; filter, select
all / none / some, or take only the video the link points at. The batch
downloads exactly the picked items and does not list the link again.

**Estimated time left.** Each running batch shows the time left and when it
should finish, measured from this computer's real throughput over the last
30 s (downloads, conversions and checks on the ⌊CPUs/2⌋ pool). On a real
40-song batch the predicted finish was right from the first estimate.

**YouTube Mix.** A Mix (`list=RD…`) is an endless radio — yt-dlp paginated
one into 1,377 items in 30 s. Batches now cap a Mix at 50 items by default
(adjustable in the preview, listed by yt-dlp itself); the preview opens in ~5 s.

**Accurate disk forecast.** Sizes come from each stream's bitrate when the
site reports no file size, and from the encoder's bitrate for MP3 / FLAC / WAV.
Real downloads: a 1080p MP4 went from a 1.3 GB forecast to 16 MB (actual
12.2 MB); three MP3s were forecast at 24 MB (actual 24.6 MB).

**Performance review** (measured in the real app, before → after)

| | Before | After |
| --- | --- | --- |
| 300-item batch, Logs/Downloads visited — renderer JS | 36.7 s | 0.7 s |
| … renderer heap | 680 MB | 16 MB |
| … wall time | 38.4 s | 11.2 s |
| Single video, click → download starts | 6.1 s | 3.9 s |
| Start-up, launch → usable | 1.95 s | 1.52 s |
| 20 links / 1,713 items queued through the UI — long tasks | 75 | 42 |

Hidden drawers and tabs no longer render; log lines are memoized and paged;
batch cards re-render only when their batch changes; text ellipsis no longer
reads layout; number formatters are cached; a video analyzed for the preview
is reused by its batch; the tool check starts with the process.

**App**
- Start-up screen with phases and a progress bar; each phase retried 3× with
  backoff, a failure names the phase and Retry resumes from it. Fatal main-process
  errors are reported instead of leaving a blank window.
- The window opens at ~92% of the screen (capped) and remembers its size,
  position and maximized state, safely across monitor changes.
- "Clear finished batches" on the Batches tab.
- Live logs show every trace id (batch, job, attempt, step): click to trace, or copy.
- The setup / diagnostics dialog always opens in front of Settings.
- Separate Windows installers per architecture.

**Library**
- `BatchRequest.maxItems`, `.selection` and `.analysis`; `BatchSnapshot.progress`
  (weighted fraction + `etaSeconds`); `WorkMeter`; `isYouTubeMix()`,
  `MIX_DEFAULT_ITEMS`, `MAX_LISTED_ITEMS`.
- `planChoices(formats, duration)` estimates sizes from bitrates.
- Forecast log lines use the same SI units as the interfaces.

## App 0.1.0-beta.1 · library 1.0.0

First beta of the desktop app (Electron + Ant Design, EN/ES, light/dark) on
the `media-downloader-core` engine and the `mdc` CLI.
