# Sites

How each site is read, and what to expect from it. Back to the [README](../README.md).

## YouTube: when it asks to confirm you're not a bot

Many requests in a short time — a 50-video Mix checked at once, its list
reloaded a few times — can make YouTube answer *"Sign in to confirm you're
not a bot"* to every request from your connection, for a while (minutes to
hours). It is not the videos: tried on a real case, every YouTube client
yt-dlp can use was refused just the same. The engine climbs a ladder, one rung
at a time and only as far as needed — nothing changes until YouTube refuses:

| Rung | What happens |
| --- | --- |
| Asking politely (always) | Checks of YouTube videos pause between requests (`--sleep-requests 0.75`, yt-dlp's own "sleep" pace); download attempts start a second apart; a check never mixes YouTube and other sites in one yt-dlp run. |
| 1. Refused once | The error is `blocked` with hint `bot-check` — not `unavailable`. With a host that can mint them (the app), YouTube requests carry **PO tokens** ([below](#youtube-attestation)) and try again after 15 s, 1.5 min and 5 min. Those retries don't count against a download's own retries. |
| 2. Still refused | With a host that can ask the user (`askUser`), YouTube requests **stop and wait** — not failed — and the `youtube` event says so: the app explains why and offers to sign in, to use a browser's session, or to wait 30 min. Once the user chooses, everything goes on from where it was. Without one, the pauses grow 5 → 10 → 20 min (up to 60). |
| 3. Signed in | `setYouTubeAccount(cookiesTxt)`: YouTube runs only use that session. In the app it lives in its own partition — never a browser's store, never the Keychain — and the engine gets a private cookies.txt of YouTube's and Google's cookies only. |

A browser's session (`setCookiesFromBrowser('chrome')`, `mdc --cookies <browser>`)
also goes on at once. Its cookies are **read once** into a private jar (again
after 6 h, or another browser) and every yt-dlp run gets its own copy: on macOS,
one Keychain prompt — not one per process, which a batch of 50 used to raise
one after another. Safari's cookies live in a protected folder: the app (or the
terminal running `mdc`) needs Full Disk Access. Unreadable cookies fail as
`cookies-unreadable`.

## YouTube: attestation

> **For learning.** This part exists to study how a site tells its own web
> page from a script — attestation, PO tokens — and how a download tool can take
> part in it. Running YouTube's attestation outside its page is against
> YouTube's terms of service. Use it for content you own or may download, and
> mind the account you sign in with: YouTube may limit one that downloads a lot.

**What it is.** YouTube's web page runs *BotGuard*, an obfuscated program that
examines the browser and signs what it saw. Google exchanges that answer for an
*integrity token* (valid ~12 h), which unlocks a *minter*: it turns a **content
binding** — the session's visitor data, or a video id — into a **PO (Proof of
Origin) token**. Streams fetched without a valid token answer 403 after a few
seconds. A token helps against 403s; it does not lift an IP-wide bot check —
which is why the ladder above ends with the user, not with more tokens.

**How the app does it** (all original code, no third-party generator):

| Part | Where | What |
| --- | --- | --- |
| Generator | `app/src/main/youtube/attestation.ts` | In a real youtube.com page loaded in an offscreen view attached to no window — nothing on screen, in the Dock or the taskbar, ever; sandboxed, muted, no pop-ups, no pictures. The page's own challenge (or InnerTube's `att/get`), the program, the integrity token, the minter. Two ways that share little: `youtube` (the kept page, youtube.com's endpoint) and `waa` (a fresh page, Google's WAA endpoint). |
| Service | `src/youtube/attestation.ts` (`PoTokenService`) | Picks the way that worked last; a failing one cools down (1 min doubling to 30) and the next is tried; the status says which broke. One session is opened at a time whatever the number of callers (single flight); it is replaced before it expires or after 90 % of the mints YouTube allows (it says 100). |
| Broker | `src/youtube/broker.ts` | Loopback only (`127.0.0.1`), one random key per run compared in constant time, one path, 16 KiB at most. |
| yt-dlp plugin | `src/youtube/plugin.ts` | A PO token provider (yt-dlp ≥ 2025.05.22, loaded with `--no-plugin-dirs --plugin-dirs`): yt-dlp hands it the exact binding it uses; where to ask comes from that process's environment, never its command line. Tokens on add `mweb`, the client they are made for, to yt-dlp's default clients. |

**Costs.** Opening a session: ~0.4 s of attestation on a page that takes ~2 s
to load, once per session (hours). A token: one hash-map lookup, or one mint
(**~0.5 ms**). Per video: **O(1)** amortized — 50 videos are one session and 50
mints. Tokens are kept in an LRU of 512 (O(1) per operation); the attestation
program is fetched once per version.

**Maintenance, and the watch.** YouTube changes this protocol every few months
— usually as an experiment that reaches some sessions first — and a broken
token fails quietly (a 403 seconds into a download). The **YouTube watch**
workflow runs every day: the app's own probe (`MDC_YOUTUBE_PROBE=report.json
electron out/main/index.js`) tries each way, has the real yt-dlp fetch a video
with only the `mweb` client (which needs a token), and downloads one through the
engine. When YouTube changed something, it opens one pull request — in English
and Spanish — with the report and what to do; it closes itself once the probe
is healthy again. A runner YouTube bot-checks is inconclusive, not an alert.
(For the pull request, the repository must allow Actions to open them —
Settings → Actions → General; otherwise the same alert comes as an issue.)

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
| Whole profiles | The analysis carries the profile's post count (`total`); the app's preview offers **Load all (N)**. The listing runs in chunks of 500, each kept as soon as it is listed: a refusal half-way returns what was listed, a cancel keeps it, and loading again continues from there. Explicit requests go up to `MAX_REQUESTED_ITEMS` (50,000). |
| Dates | Every finished file — TikTok or any yt-dlp site — gets its **publication date as modification time** (TikTok's post time; yt-dlp's `timestamp`, else noon UTC of `upload_date`), so sorting a folder by date sorts by publication. The date tag inside the file carries it too. |

No request signatures are generated and no anti-bot challenge is solved.
Photo posts (slideshows) download as an MP4, as images with their sound, or
as images only (`slideshow` on the batch request).
TikTok's terms restrict automated access: use this to back up content you
are allowed to keep, at the default pace. `tiktok: false` sends TikTok to
yt-dlp like any other site.

## Instagram and Facebook (built-in extractors)

Instagram and Facebook are read by the library itself too, the same way as
TikTok and with the same plumbing — one `MetaClient` per site: an HTTP
session with the site's cookies, a shared Pacer, reads retried after the
shared cool-down, a real browser for pages that only open in one, a circuit
breaker while the site blocks the source, and yt-dlp as the fallback:

```ts
scheduler.schedule({url: 'https://www.instagram.com/p/C0DE…/', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.instagram.com/some.user/', profile: {kind: 'video', container: 'mp4'}, outDir, slideshow: {mode: 'images', secondsPerImage: 3}})
scheduler.schedule({url: 'https://www.instagram.com/stories/some.user/', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.facebook.com/watch/?v=10000…', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.facebook.com/somepage/videos/', profile: {kind: 'video', container: 'mp4'}, outDir})
```

| | Instagram | Facebook |
| --- | --- | --- |
| Links | `/p/<code>/`, `/reel/<code>/`, `/tv/<code>/`, `/<user>/`, `/<user>/reels/`, `/stories/<user>/[<id>/]`, `/stories/highlights/<id>/`, `/share/…` (a redirect) | `/watch/?v=<id>`, `/<page>/videos/<id>/`, `/reel/<id>`, `/video.php?v=`, `/<page>/posts/<id>`, `/<page>` and `/<page>/videos/`, `/profile.php?id=`, `/stories/<bucket>/[<card>/]`, `fb.watch/…` and `/share/…` (redirects) |
| A post | First the anonymous routes yt-dlp, cobalt and gallery-dl read, one request each: the embed page (`/p/<code>/embed/captioned/`) and the Android app's API (`i.instagram.com/api/v1/media/<pk>/info/`). Then the web client's own post query (JSON), else the post page — what Instagram embeds for its player (`xig_polaris_media.if_not_gated_logged_out` for a visitor, else the shortcode web info). | The video page, read with the user's session when there is one: the data Facebook embeds for its player, spread over several Relay objects that share the video's id and are merged. Progressive HD / SD files; a DASH-only video goes to yt-dlp. Since October 2026 Facebook shows most video pages to signed-in visitors only: without a session the page is its "video not found" root and the error says `needs-sign-in`. |
| A profile | `web_profile_info` (the account, its post count, private or not), then the web client's timeline query by cursor; with a signed-in session, the feed API the app itself reads. Pages of 12. | The Videos tab (its first videos, the cursor of the rest and the page's `fb_dtsg` / `lsd` tokens), then the web client's pagination query by cursor. A listing names videos without their media: each page is read at the check and reused by the download. |
| Listing | Cursor pagination shared by both: de-duplicated by id (O(1) per item), a page that brings nothing new or a cursor that repeats counts as a stall (three end the walk), the cap falling mid-page re-reads that page later rather than losing its tail. Listed in chunks of 500, each kept as soon as it is in; a reopened preview answers from memory for 15 minutes and asking for more continues from its cursor. Incremental (`known`): stops after 20 known posts in a row. | Same walk. |
| Photos and carousels | A photo or a carousel of photos becomes what `slideshow` asks: an MP4 (default, N seconds per image) or a folder of the pictures (`'images'` — the faithful backup). A carousel with videos is always a folder of everything, in order, as the site serves it; an audio format takes its first video's soundtrack. `MediaSummary.slideshow` tells the UI. | Videos only (a page's Videos tab); stories can be pictures. |
| Stories and highlights | Both need the user's **signed-in session**: Instagram shows them to accounts only. Without one the batch fails at once with `needs-sign-in`, before asking the site. A story's url names the user, the item its id; `stories last 24 hours` is the reason when it is gone. | Same for a stories bucket (`/stories/<bucket>/`). |
| The session | The browser cookies the engine already reads for yt-dlp (`setCookiesFromBrowser`), else `cookiesFile`, filtered to the site's domain — read once, asked again every 6 hours. A host may pass `cookies` itself, as cookies or as `{cookies, userAgent}` (the agent that earned them, e.g. an in-app sign-in); TikTok takes the same option (`tiktok.cookies`). Nothing is stored beyond the engine's cookie jar. | Same. |
| Pace | One shared **Pacer** per site, TikTok's defaults: 2 requests at a time, ~1.5–2.5 s apart; a refusal (403 / 429 / "please wait a few minutes") makes every request back off 30 s → 10 min. Media downloads aren't paced. | Same. |
| Walls | A login wall or a checkpoint (`/challenge/`, `/checkpoint/`) is never solved: with a browser at hand (`instagram.browser`) the page is loaded there once and its session adopted; without one, or when the browser gets the wall too, the source steps aside for 10 minutes and yt-dlp handles the site (with the user's cookies it may get further). A page whose layout changed, or a query Instagram rotated, falls back to yt-dlp for that url (`extractor-fallback`). When every route to a public post got the wall, the error says Instagram is limiting this network (`walled`, `retry-later`) — not "sign in". | Same. |
| Query ids | The web client's Relay `doc_id`s live in one file per site (`endpoints.ts`) and can be overridden without a release (`instagram.queries`, `facebook.queries`). A rotated listing query leaves a profile at the posts its info carried (`complete: false`) and a page's videos at what the tab showed, never a failed listing. | Same. |

**What was verified, and what wasn't.** Every behaviour above is covered by
the tests against local fakes (`test/helpers/fake-instagram.ts`,
`test/helpers/fake-facebook.ts`) that serve the shapes the real sites served
when this was written, taken from their web clients and yt-dlp's extractors.
The live endpoints and query ids were **not** re-verified from the build
environment of this release; both sites change them without notice. Anything
that stops answering falls back to yt-dlp, and `endpoints.ts` is the one
place to update.

Both sites' terms restrict automated access: use this to back up content you
are allowed to keep, at the default pace. `instagram: false` / `facebook: false`
send their urls to yt-dlp like any other site.

**Hosts without yt-dlp.** `ytDlp: 'optional'` (a phone, say) needs only
ffmpeg and ffprobe. The built-in extractors read their sites; where one would
hand a link to yt-dlp, its own reason comes back instead (`unavailable`, its
hint or `retry-later`), a source that would step aside is asked all the same,
and anything else that needs yt-dlp fails with `binary-missing`.

## TikTok sync (Sync Up)

A **subscription** keeps a TikTok account in step with a folder. A sync
compares what the folder holds with what the account lists and downloads
only what is missing, as one ordinary batch — so it shows in Batches,
Downloads, Finished and the run report like any other.

| | How |
| --- | --- |
| What the folder holds | The post id in each file name (`title-<id>.mp4`, `001-title-<id>.mp4`, `Title [<id>].mp4`), then the archive's records of files in the folder, then — only for renamed files — the post link the app writes into each file's tags. 835 files are read in ~50 ms. |
| One format per folder | A folder with files decides the format: MP4 files mean MP4, never MP3 next to them. Adding a subscription with another format, a folder mixing formats, or a file in another format dropped in later is refused with the reason, before anything downloads. An empty folder takes the format asked for. |
| First sync | Reads the **whole account**: a folder can have gaps anywhere, not only at the top (a real 839-post account: 4 missing, 3 of them years old, ~2 minutes). |
| Later syncs | Read from the newest post down and stop after 20 posts in a row the folder already has (pinned posts don't count): a few requests, seconds. `deep` reads the whole account again and also reports files whose post TikTok no longer lists (they are left alone). |
| New files | Straight into the folder (no subfolder, no position prefix), named `title-<id>.<ext>`, dated by publication. Photo posts become videos in a video folder. |
| Schedules | `manual`, daily at `HH:MM` (local), or every 1–168 hours. The app runs them while it is open (a missed one runs when it opens); without the app, `mdc sync run --due` from any scheduler. |
| Two processes | The app and `mdc` share `subscriptions.json` in the data folder; a lock per subscription, held until its downloads end, keeps them from syncing the same account at once (a lock left by a crashed process is taken over). |

**In the app**: Settings → *TikTok sync*, then **Sync Up** next to New
download. *Add account* suggests the folder a profile download uses
(`<downloads>/TikTok-<name>`), shows what it holds and locks the format to
it. Each account has *Sync now*, and under ⋮: *Check* (what is new, nothing
downloaded), *Full check*, *Change schedule*, *Open folder*, *Remove* (the
files stay).

**From the command line**:

```bash
mdc sync add @name --folder ~/Downloads/TikTok-name --daily 08:00   # or --every 6, --manual; -f for an empty folder
mdc sync                                  # accounts, folders, last and next sync
mdc sync run @name --dry-run              # what is new, nothing downloaded
mdc sync run @name                        # sync now (--deep: the whole account)
mdc sync run --due -Q                     # every account whose time has come
mdc sync remove @name                     # stop following (the folder stays)
```

**From a scheduler**, every 15 minutes (`--due` only runs what is due, so
the schedule itself stays in `mdc sync add`):

```bash
# cron (macOS, Linux) — crontab -e
*/15 * * * * /usr/local/bin/mdc sync run --due -Q
```

```xml
<!-- launchd (macOS) — ~/Library/LaunchAgents/com.example.mdc-sync.plist, then: launchctl load <file> -->
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.mdc-sync</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/mdc</string><string>sync</string><string>run</string><string>--due</string><string>-Q</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
</dict></plist>
```

```powershell
# Task Scheduler (Windows)
schtasks /Create /TN "mdc sync" /SC MINUTE /MO 15 /TR "mdc sync run --due -Q"
```

**From code**:

```ts
import {BatchScheduler, MediaDownloader, SyncManager} from 'media-downloader-core'

await using dl = new MediaDownloader({dataDir})
const scheduler = new BatchScheduler(dl)
const sync = new SyncManager(dl, scheduler)            // subscriptions.json in dataDir
const sub = await sync.add({url: 'https://www.tiktok.com/@name', folder: '/media/TikTok-name', schedule: {every: 'day', at: '08:00'}})
const plan = await sync.check(sub.id)                   // {listed, inFolder, entries, gone, caughtUp}
const run = await sync.run(sub.id)                      // schedules one batch with what is new
await sync.whenDone(sub.id, run.id)                     // {status, new, downloaded, failed, …}
sync.startSchedule()                                    // run due subscriptions every minute
```

`scanFolder()`, `folderFormat()` and `syncProfile()` are exported too: what
a folder holds, which format it is in, and the profile a sync into it uses.

## Player-page sites (configured locally)

Some sites give each video a page with a player, list them in paged
searches, and reveal the media link only to their player's script. None is
built in: a host describes the sites its user wants as `PlayerPageSite`s and
passes `new PlayerPageSource({site, resolveMedia})` in `sources`. The desktop
app reads them from `<userData>/sites.json` (or the file `MDC_SITES_FILE`
names), validated strictly — nothing about them ships with the app:

```json
{"sites": [{"name": "My site", "hosts": ["example.com"], "videoPath": "^/video/(\\d+)(?:/|$)"}]}
```

**Any other host, unconfigured.** With `unsupportedUrlSource`, an http(s) url
yt-dlp doesn't support ("Unsupported URL") is tried by a source made for its
host instead of failing — the app makes a `PlayerPageSource` with the default
`videoPath`, its browser kept on that host. Once it finds videos there, that
host is read natively from then on; a page that isn't a player page either
keeps yt-dlp's error. Checks and queued downloads take the same path.

```ts
new MediaDownloader({
  dataDir,
  unsupportedUrlSource: url =>
    new PlayerPageSource({site: {name: url.hostname, hosts: [url.hostname]}, resolveMedia}),
})
```

| | |
|---|---|
| Listing | Any page of a search lists **the whole search** from page 1, 500 videos by default (like a TikTok profile; **Load all** in the preview). Pages are read in parallel, ahead of what the pagination shows; the end is a page that comes back empty, missing or repeating an earlier one. The site's menu (featured videos on every page) is left out. |
| Checking | Each picked video's page over plain HTTP, 10 at a time: a page that redirects away or has no player is *unavailable*. |
| Media link | Read from the site's own player by a real browser (`resolveMedia`): the app opens the page in a hidden, sandboxed window that loads no images, video, fonts, styles or frames and nothing from other sites but scripts, and reads what the `<video>` element was given. Nothing is decoded by our code. One page load per download, two at a time. |
| Download | Straight from the media server with resume (Range) and a stall watchdog. A quality cap or an audio format takes the sibling rendition (`…_720p.mp4`) when the page offers it. An MP4 is **kept byte for byte** as the server sent it (no conversion, no tag rewrite) and only validated; it is dated by the server's `Last-Modified`. |
