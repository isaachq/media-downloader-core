# Changelog

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
