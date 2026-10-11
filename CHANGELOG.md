# Changelog

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
