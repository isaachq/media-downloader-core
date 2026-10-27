# Desktop app

The desktop app (macOS, Windows, Linux) lives in [`app/`](../app): Electron, React and [Ant Design](https://ant.design). Back to the [README](../README.md).

## Installing

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

**No "Open Anyway" button?** (it doesn't always show up, and right click → Open
no longer skips the warning on macOS 15 and later) Run this once in **Terminal**
— it removes the "downloaded from the internet" mark from the app, nothing else:

```bash
xattr -dr com.apple.quarantine "/Applications/Media Download Core.app"
```

**Windows** (x64 and ARM) — `.exe`

1. Open the `.exe`. If a blue window says *"Windows protected your PC"*
   (SmartScreen), click **More info**.
2. Click **Run anyway**. The installer opens, finishes by itself and starts the app.

> **Why the warning?** This is a free project made at home, and the installer
> isn't signed with a paid Microsoft certificate yet. SmartScreen warns about
> that missing signature, not about the file: the code is public here, and
> Windows stops asking as more people install it.

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

## Signing in: your browser's session

Some content needs your own account: private or members-only videos,
age-restricted ones, Instagram profiles, stories and highlights, a Facebook
page's list of videos, private Threads profiles you follow, Twitch's
subscriber-only videos, clips and streams — and YouTube when it asks to
confirm you're not a bot. The README's [supported sites](../README.md#supported-sites)
table says it site by site (*How to sign in* lists it in the app). Twitch's
session is only sent on the reads that get a video's playback token: never
to chat, follow or subscribe.
The app never asks for a password: it uses the session of the browser you
already sign in with.

1. Open your usual browser (Chrome, Edge, Firefox, Safari, Brave…) and **sign
   in there as always** — to Google / YouTube, Instagram, Facebook, Threads or
   Twitch.
2. In the app: **Settings → Cookies from browser → choose that browser**
   (Settings → Cookies → *How to sign in* shows these steps in the app).
3. **Allow the permission your system asks for**, once:
   - **macOS** — a Keychain window asks to let the app read "Chrome Safe
     Storage" (or your browser's): type your Mac password and click **Always
     Allow**. Safari: System Settings → Privacy & Security → **Full Disk
     Access** → turn on Media Download Core.
   - **Windows** — close the browser before downloading (Chrome and Edge lock
     their cookies while open). If Chrome still can't be read (it protects its
     cookies on Windows), sign in with **Firefox** and choose Firefox.
   - **Linux** (Fedora, Ubuntu…) — your keyring (GNOME Keyring / KWallet) may
     ask to allow access to the browser's saved data: allow it. Firefox asks
     nothing.
4. Paste the link again. If the site signs you out, sign in again in the
   browser — the app picks the new session up by itself.

The cookies stay on your computer: they are read once into a private copy
the app uses only for downloading, filtered to the site at hand, and never
sent anywhere else. Without a session, single public posts and videos still
download; what a site keeps for signed-in accounts says so ("Sign-in
required") instead of failing silently.

## Updates

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

## Features

- **Preview**: a playlist, YouTube Mix or channel opens a list of everything it holds first — filter, select all / some, or just the linked video — and only the picked items are downloaded. A Mix (an endless, auto-generated radio) loads its first 50 by default; load more from the preview.
- **Mix list**: links of any sites gathered into one batch — add them one by one or paste a whole list, each a numbered card with its site; choose the format for all of them, and after the check give any single link a format of its own (one song as MP3 among videos). Repeats, lists and links that can't be downloaded are left out with their reason before anything downloads.
- **Sync Up** (turn it on in Settings): TikTok accounts kept in step with folders — check what is new without downloading, sync now or on a schedule, a history of every run; each sync is a batch in Batches / Downloads / Finished.
- **Batches**: preflight (available / unavailable with the reason), disk forecast from real bitrates, progress weighted by size and the **estimated time left** — measured from this computer's real throughput, so you can start a big batch and walk away — plus paged item list, cancel, clear finished. New links queue behind the running batch.
- **Downloads**: one row per job with progress, speed, ETA, the D·C·V·F sub-tasks (failed / in-progress / success), retries and their reason.
- **Integrity**: the verdict of every file, with codecs, decoded vs expected duration and SHA-256 one click away.
- **Settings**: download folder, simultaneous downloads (capped at ⌊CPUs/2⌋), integrity level, long-video threshold, browser cookies, tags and cover art, notifications.
- **Logs**: live, every line with its batch / job / attempt / step ids (click one to trace it), plus tracing of any session / batch / job / attempt / step id.
- **Car & USB friendly names** (default): only letters, numbers and hyphens — `001-Cancion-Nandu-k1gsZ.mp3` — and MP3 tags in ID3v2.3, the version car stereos read. Switch it off in Settings to keep titles as they are.
- **Setup**: first launch installs yt-dlp and FFmpeg from their official sources, checksum-verified; the tools are shared with `mdc`.
- Fourteen languages (Arabic right to left), light / dark / system theme, window size and position — all remembered.
- A start-up screen shows each phase; a failing phase is retried and, if it still fails, says why and resumes from there.
