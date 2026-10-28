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
| A post | Five anonymous tries, one door each: the first of this try's order (embed, web info, the post page, the logged-out query, the app API, rotated by the try) not yet asked and not resting, with this try's Accept-Language on every door. The first door that returns the post ends the tries and the download starts. A door that refused is not asked again in that phase; a door with nothing to ask with yet is not a try. Then one visitor read of the web client, unless oEmbed says the post is limited to some audiences. **Then the session, and only then:** three app-API reads with the user's cookies. Without cookies the error is `needs-sign-in` after a wall, or `retry-later` with the wait (the pacer's own, or 60 s) after a refusal. A 401 to the session is `needs-sign-in` at once (sign in again). If the three session reads fail, `retry-later` in 5 minutes. None of these is started over by the analysis loop. A photo post's song asked with the session is quiet: a challenge there delivers the post without its song (logged), never a verification, and the site keeps its source. | The video page, read with the user's session when there is one: the data Facebook embeds for its player, spread over several Relay objects that share the video's id and are merged. Progressive HD / SD files; a DASH-only video goes to yt-dlp. Since October 2026 Facebook shows most video pages to signed-in visitors only: without a session the page is its "video not found" root and the error says `needs-sign-in`. |
| A profile | `web_profile_info` (the account, its post count, private or not), then the web client's timeline query by cursor; with a signed-in session, the feed API the app itself reads. Pages of 12. | The Videos tab (its first videos, the cursor of the rest and the page's `fb_dtsg` / `lsd` tokens), then the web client's pagination query by cursor. A listing names videos without their media: each page is read at the check and reused by the download. |
| Listing | Cursor pagination shared by both: de-duplicated by id (O(1) per item), a page that brings nothing new or a cursor that repeats counts as a stall (three end the walk), the cap falling mid-page re-reads that page later rather than losing its tail. Listed in chunks of 500, each kept as soon as it is in; a reopened preview answers from memory for 15 minutes and asking for more continues from its cursor. Incremental (`known`): stops after 20 known posts in a row. | Same walk. |
| Photos and carousels | A photo or a carousel of photos becomes what `slideshow` asks: an MP4 (default, N seconds per image) or a folder of the pictures (`'images'` — the faithful backup). A carousel with videos is always a folder of everything, in order, as the site serves it; an audio format takes its first video's soundtrack. `MediaSummary.slideshow` tells the UI. | Videos only (a page's Videos tab); stories can be pictures. |
| Stories and highlights | Both need the user's **signed-in session**: Instagram shows them to accounts only. Without one the batch fails at once with `needs-sign-in`, before asking the site. A story's url names the user, the item its id; `stories last 24 hours` is the reason when it is gone. | Same for a stories bucket (`/stories/<bucket>/`). |
| The session | The browser cookies the engine already reads for yt-dlp (`setCookiesFromBrowser`), else `cookiesFile`, filtered to the site's domain — read once, asked again every 6 hours. A host may pass `cookies` itself, as cookies or as `{cookies, userAgent}` (the agent that earned them, e.g. an in-app sign-in); TikTok takes the same option (`tiktok.cookies`). Nothing is stored beyond the engine's cookie jar. A session the site refuses (a 4xx to a request it serves a visitor) is dropped for 30 minutes and the post is read as a visitor, one extra request once per window; stories and listings then say to sign out and in again. | Same. |
| Pace | One shared **Pacer** per site, TikTok's defaults: 2 requests at a time, ~1.5–2.5 s apart; a refusal (403 / 429 / "please wait a few minutes") makes every request back off 30 s → 10 min. Media downloads aren't paced. | Same. |
| Walls | A login wall or a checkpoint (`/challenge/`, `/checkpoint/`) is never solved: with a browser at hand (`instagram.browser`) the page is loaded there once and its session adopted; without one, or when the browser gets the wall too, the source steps aside for 10 minutes and yt-dlp handles the site (with the user's cookies it may get further). A page whose layout changed, or a query Instagram rotated, falls back to yt-dlp for that url (`extractor-fallback`). When the five anonymous tries do not read a public post, the next step is the user's session (`needs-sign-in` when there is none; three tries when there is). After those, the error says to try again in about 5 minutes. A gated post (oEmbed `gating_type`) takes that session path without spending the remaining anonymous tries. A quiet read (a song) never steps the site aside. | Same. |
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

## Snapchat (built-in extractor)

Spotlights, public profiles, curated highlights and story snaps are read by
the library itself: one anonymous page read per link, no API, no session, no
browser, no yt-dlp. The media is a progressive MP4 or a JPEG on Snapchat's
CDN, streamed to disk with resume (Range) like every other native source:

```ts
scheduler.schedule({url: 'https://www.snapchat.com/spotlight/W7_EDlXW…', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.snapchat.com/@nasa', profile: {kind: 'video', container: 'mp4'}, outDir, slideshow: {mode: 'images', secondsPerImage: 3}})
```

| | How |
| --- | --- |
| Links | `/spotlight/<id>`, `/@<u>/spotlight/<id>`, `/add/<u>/spotlight/<id>` (one spotlight); `/@<u>`, `/add/<u>`, `story.snapchat.com/s/<u>` and `/@<u>` (a profile; `/@<u>/stories`, `/highlights`, `/spotlights` narrow it to one kind); `/@<u>/<snapId>` (one snap of the live story); `/@<u>/highlight/<id>` (a curated highlight); `snapchat.com/t/<code>` and `t.snapchat.com/<code>` (short links, followed with the shared redirect follower). `/@<u>/highlight/<id>/<n>` is this library's link for a highlight's n-th snap: the site has no page per snap, and the highlight's page is what is read. |
| How it is read | The page's own data: `<script id="__NEXT_DATA__">` located with `indexOf` (never a regular expression over a page of up to 1 MB), parsed once, kept as the items it names (not the HTML). A spotlight is picked by its id out of the page's feed (the other ~24 entries are recommendations of other creators, never listed). A page whose data moved, or one without `__NEXT_DATA__`, is `source:format-changed`: the engine hands the url to yt-dlp, which reads spotlights. |
| Media | **Downloaded exactly as the page serves it**: a spotlight's `contentUrl` (540 × 960, Snapchat's watermark and the creator's name burned in), a snap's `snapUrls.mediaUrl`. A watermark-free render of every spotlight exists (the `.1034` render, 480 × 852, 10 of 10 checked): it was deliberately not used (the owner's call). The CDN can answer 200 with bytes that are no media (a render a key lacks): each file's first bytes are checked (an MP4 `ftyp` box, a JPEG / PNG / WebP / GIF signature) and anything else fails as `source:format-changed`, with no file left behind. |
| Pictures | A picture snap is a one-image photo post, the Instagram / TikTok convention: an MP4 of it (`slideshow.mode` `'video'`, N seconds) or a folder with the picture (`'images'`, `'images-audio'`); an audio format has nothing to take (`format-unavailable`). `MediaSummary.slideshow` is `{images: 1, audio: false}`. |
| Listing | A profile is its live story, then every curated highlight's snaps, then its spotlights, **only what the page embeds** (~20 spotlights, ~10 highlights of up to 12 snaps): Snapchat pages further on its servers only (the cursors in the page are never sent by its web client, the data routes answer 404). A non-empty cursor makes the listing `complete: false`. Empty placeholder slots are skipped. `maxEntries` (default 500, `snapchat.maxListItems`) and `known` (an incremental sync leaves known ids out, `caughtUp`) cost O(1) per item. |
| Cache | Pages by path, an LRU of 200 kept 10 minutes; items by id, 5,000. Reads of one page at the same time share one request (`Coalescer`): an analysis, its check and its download, or a whole profile's listing and every entry's download, make one page request. `fresh` (a retry) reads again. |
| Errors | 404 → `unavailable` / `removed` (an unknown account, a removed spotlight or highlight); a story snap that is gone (the page's `showSnapExpiredToast`, or the snap no longer in the story) → `removed` ("stories last 24 hours"); a private account (`userProfile.$case === 'userInfo'`) → `unavailable` / `private`: Snapchat shows it to its friends in the app only, and no sign-in here changes that. 403 / 429 / 5xx back every request off together (Pacer) and are retried. |
| Session | None: everything above is public. Private profiles, friends' stories, Snap Map and chats need Snapchat's app API and its login; not doable over HTTP. |
| Pace | One Pacer for www.snapchat.com: 2 pages at a time, ~1–1.5 s apart (`snapchat.pacing`). Media downloads aren't paced. |
| Endpoints | The origin, the `__NEXT_DATA__` marker and the routes live in `src/sources/snapchat/endpoints.ts`, overridable without a release (`snapchat.endpoints`). |

**What was verified, and what wasn't.** Verified live on 2026-10-26
(anonymous, from Mexico, desktop Chrome user agent; `npm run live:matrix --
--platform snapchat`, with and without `--native`, 15 of 15 links): spotlights,
profiles (`/@u`, `/add/u`, `story.snapchat.com/s/u`, `/@u/spotlights`),
curated highlights, a story snap, picture snaps of a highlight, unknown
accounts (404); downloaded natively, each file checked: spotlights H.264
540 × 960 + AAC, a story snap 480 × 846, highlight JPEGs. No bot check and no
rate limit at the matrix's pace. **Not verified**: short
links (`snapchat.com/t/<code>`, `t.snapchat.com/<code>`; no live code was
found, the follow is tested against the fake only); a private profile page
(none found: the `userInfo` case is what Snapchat's own web code treats as
private, and the fake serves a guess of its shape); a picture inside a live
story (seen only in curated highlights); the phone's network (Android may get
another `lang` / region). `snapchat: false` sends Snapchat urls to yt-dlp.

## Threads (built-in extractor)

Posts and public profiles are read by the library itself: the web pages'
own data and the web client's listing query over plain HTTP, media straight
from Meta's CDN, streamed to disk with resume (Range). yt-dlp has no Threads
extractor, so there is nothing to fall back to: every failure says its own
reason.

```ts
scheduler.schedule({url: 'https://www.threads.com/@zuck/post/DJDhoQfxb43', profile: {kind: 'video', container: 'mp4'}, outDir, slideshow: {mode: 'images', secondsPerImage: 3}})
scheduler.schedule({url: 'https://www.threads.com/@mosseri', profile: {kind: 'video', container: 'mp4'}, outDir})
```

| | How |
| --- | --- |
| Links | `/@<u>/post/<code>`, `/@<u>/post/<code>/media` (the media viewer), `/t/<code>` (one post); `/@<u>`, `/@<u>/media`, `/@<u>/replies`, `/@<u>/reposts` (a profile, always listed as its threads tab). On `www.threads.com`, `threads.com` and the old `threads.net` (a 301 to threads.com). The share sheet's `?xmt=…&slof=1` is tracking (mix lists drop it). |
| How it is read | A post is **one page load** (`navigationFetch`: Threads serves a page its data only when the request says `Sec-Fetch-Mode: navigate`, which Node's fetch cannot; anything else gets a gating shell with no data). The page's JSON blocks are found with `indexOf` and walked once (explicit stack, bounded): the post is the `BarcelonaPostPageTargetQuery` preloader's `data.media`, matched by its code, a v1 item read by the same function Instagram's are. |
| Media | `media_type` 2: the progressive MP4 of `video_versions` (three entries, one file, no sizes: `original_width` / `original_height` give them; the length comes from the DASH manifest's `mediaPresentationDuration`). 1: the best of `image_versions2.candidates` (JPEG or WebP, every size kept as a mirror). 8: a carousel, a `slideshow` exactly as Instagram's (photos only: an MP4 or a folder; photos and videos: a folder of both, in order). 19: a text post (a GIF or a link card included): `unavailable` / `format-unavailable`, nothing to download. The DASH representations are not used (the progressive file was the original size in every post checked). |
| Listing | One profile page load (the account from `BarcelonaProfilePageDirectQuery`, private or not; the LSD token; the threads tab's `doc_id` and variables as its own client sent them), then `POST /api/graphql` 10 threads a page, from GraphQL's own cursor (the page's base64-wrapped one is ignored by the site). Every post of a thread the owner wrote and that has media is an entry (a self-thread's photo in its third post too); reposts, quotes and text posts are left out; pages of text posts only are read on (at most 10 in a row) so they never count as a stall. Map by id, a cursor seen twice or 3 pages with nothing new end the walk (`walkCursor`), `maxEntries` (default 500, `threads.maxProfileItems`), `known` (an incremental sync stops after 20 known posts in a row), chunks of 500 kept as they come (a refusal half-way loses nothing). Every listed post keeps its media: checks and downloads ask for no page. |
| Cache | Posts by id until their links' CDN `oe` (less 10 min), 5,000 kept; profile pages 30 min (500); listings 15 min (100). Reads of one post or one profile at the same time share one request (`Coalescer`). `fresh` (a retry) reads again. |
| Errors | A post Threads won't show (deleted, or a private account's) redirects home with `?error=invalid_post`; an unknown or hidden account redirects to the login page. A visitor can't tell which: `unavailable` / `needs-sign-in` saying both; with a session, `removed`. A private account (`text_post_app_is_private`) without a session: `needs-sign-in`. A page without its data: `unavailable` / `retry-later`, "Threads changed its pages; yt-dlp has no Threads extractor" — never `source:format-changed` (yt-dlp's generic extractor reads nothing there); a rotated listing query lists what the profile page embeds (`complete: false`). A verification page: "try again in a few minutes", not yt-dlp. 403 / 429 / 5xx back every request off together (Pacer) and are retried. |
| Session | Threads signs in with the Instagram account but keeps its own cookies on `.threads.com` (`sessionid`): the engine passes the browser cookies for `threads.com` (instagram.com's are never sent there). Loaded only when the host has some; without, everything public is read anonymously and no cookie but Threads' own `csrftoken` is sent. |
| Pace | MetaClient's Pacer for www.threads.com (`threads.pacing`). Media downloads aren't paced. |
| Endpoints | Query names, the threads tab's fallback `doc_id`, the app id, the page size and the fallback variables live in `src/sources/threads/endpoints.ts`; `threads.queries` overrides them without a release (a host's `threadsTabId` wins over the page's). |

**What was verified, and what wasn't.** Verified live on 2026-10-26
(anonymous, from Mexico, desktop Chrome user agent; `npm run live:matrix --
--platform threads`, with and without `--native`, 17 of 17 links): video
posts, photo posts, carousels of photos and of photos and videos, `/t/` and
`threads.net` links, the `/media` variants, profiles @zuck, @mosseri and
@instagram (GraphQL pages 2 and 3 all new and older); downloaded natively
(`--native --download`, 13 of 13): H.264 720 × 1280 / 1280 × 720 + AAC,
JPEG / WebP pictures, carousel folders. The CDN answers `Range` with 206,
with or without a Referer. No rate limit or bot check seen (about 80 site
requests in an evening, 1 to 3 s apart). **Not verified**: a private profile
and a signed-in session (no account used: the private paths are what the
site does to a visitor, and the fake serves a guess of the signed-in
answer); a deleted post as a signed-in visitor; GIFs (GIPHY), reposts and
quotes as links of their own; spoiler-blurred media; the phone's network.
`threads: false` hands Threads urls to yt-dlp, whose generic extractor
reads none of them.

## SoundCloud (built-in extractor)

Tracks, sets and public profiles are read by the library itself from
SoundCloud's anonymous `api-v2`, with the `client_id` the web app itself
uses. **Audio only, MP3 or M4A**: the analysis offers audio formats only. A
SoundCloud link scheduled as a video (a track, a set, a profile, a short
link) is refused by `BatchScheduler.schedule` before any request
(`invalid-request` / `format-unavailable`, `params.audioOnly`); in a mix
list a SoundCloud link downloads as M4A from its first attempt (or in its
own MP3 / M4A format), never as a video refused and retried.
`audioOnlyFormats(site)` (from `media-downloader-core/detect`, pure) is what
the apps' format pickers show for it (since 1.21.3). The media is the clear HLS fMP4 AAC, downloaded by
the core's HLS module and handed over as an M4A (the engine's M4A step
copies the AAC as it is; MP3, Opus, FLAC and WAV are encoded from it).

```ts
scheduler.schedule({url: 'https://soundcloud.com/forss/flickermood', profile: {kind: 'audio', container: 'm4a'}, outDir})
scheduler.schedule({url: 'https://soundcloud.com/lofi_chill/sets/lofi-study', profile: {kind: 'audio', container: 'mp3'}, outDir})
// a video format is refused at once (since 1.21.3); in a mix list of videos the track is M4A
```

| | How |
| --- | --- |
| Links | `soundcloud.com/<user>/<track>` (and its `/recommended`, `/likes`, `/sets`, `/reposts`, `/comments` pages): one track; `/<user>/<track>/s-<token>`: a private track by its secret link; `/<user>/sets/<set>[/s-<token>]`: a set (playlist or album); `/<user>`, `/<user>/tracks`, `/<user>/likes`, `/<user>/sets`, `/<user>/albums`: a profile's tab. On `soundcloud.com`, `www.` and `m.` (read back as `soundcloud.com`: the API answers 404 to `m.` pages), `w.soundcloud.com/player/?url=<a link above>[&secret_token=]`, and `on.soundcloud.com/<code>` short links (one 302 to the page today, followed with `followShortLink` for up to 3 hops; a 200 page is read for its `<meta refresh>` or a script's `location`; the sharer's `si`, `ref`, `p`, `c`, `utm_*` and a set's `?in=` never reach the resolve: a track shared from a set is the track). Verified live 2026-10-27 with the 4 links of the beta 24 report (SO-06 to SO-09). Reposts, followers, comments, stations, search and the API's own urls are not read here (yt-dlp takes what it can). |
| Client id | `soundcloud.clientId` when given (the escape hatch yt-dlp users ask for when the home page sits behind a WAF, #16742). Else the home page is read once per session: its hydration names one (`"hydratable":"apiClient","data":{"id":"…"}`, free, flagged `isExpiring`); when it has none, or the API refuses it, the page's `a-v2.sndcdn.com/assets/*.js` bundles are read **last first** (the id has been in the last one for years), each streamed and left at the first `client_id:"…"`, so the 2.9 MB bundle is never held whole. A 401 (empty body) refuses that id for an hour and reads another once; a second 401 on the new one is `source:format-changed` (yt-dlp). A home page that is a bot check (a non-200, a WAF script) is `source:blocked`. |
| How it is read | A track, a set or a user is **one request**: `GET /resolve?url=<the page>&client_id=`. 404 `{}` → `removed` (a private track without its token is a 404 too: the message says so). |
| Media | The transcodings, best first: `aac_160k` over HLS, `aac_96k` over HLS, then a legacy track's MP3 (progressive before HLS: 1 request instead of 1 + n) and Opus (an Opus profile takes an Opus stream first). Left out: `abr_*` (a master that answers 404), Go+'s `hq` (a subscriber session), snipped previews, and **DRM** (`cbc-` / `ctr-encrypted-hls`, Widevine + PlayReady). Each is minted by `GET <transcoding url>&client_id=&track_authorization=` → `{url}` (a 404 tries the next; so does a playlist that will not open). HLS: a CloudFront-signed playlist (about 5 minutes) is fetched at once, re-minted once if it already ran out; its fMP4 segments (about 2 hours) go through `downloadHls` with a refresh that mints again when the CDN refuses one (403), within the core's budget; init + segments in order are already a playable fragmented M4A (no ffmpeg). Legacy MP3 HLS is packed audio, joined with one `ffmpeg -c copy`. Progressive (`cf-media.sndcdn.com/<id>.128.mp3`, about 5 minutes) goes through `fetchMedia`, re-minted once and resumed with Range when its link runs out. CDN requests are not paced. |
| Refused, never handed to yt-dlp | A track whose only formats are DRM (about 40 % of the catalog: label releases): `unavailable` / `format-unavailable`, its message says DRM (yt-dlp refuses them too, #17335); a DRM key in a playlist that looked clear: the same. A Go+ preview (`policy: SNIP`, every format `snipped`, or a minted `/preview/` stream): `format-unavailable` ("only a 30-second preview"), unless the track also has a whole format, which is taken. `policy: BLOCK`: `geo-blocked`. |
| Listing | Tracks and likes: `/users/<id>/tracks` and `/likes`, `limit=50&linked_partitioning=1`, then `next_href` (a keyset cursor without `client_id` or `linked_partitioning`: both added) until it is `null`: **pages come back short** (17 of 20 seen), so the page size never ends a walk. Map by id, a cursor seen twice or 3 pages with nothing new end it (`walkCursor`), `maxEntries` (default 500, `soundcloud.maxListItems`), `known` (an incremental sync stops after 20 known tracks in a row: both are newest first). A liked set is left out of likes (its own link reads it). Sets and albums tabs: `/users/<id>/playlists` and `/albums`, each set's tracks in order, each track once. Every listed track is whole in its page (with its transcodings and authorization): **a listed track is never read again** (its check and its download make one mint request only). |
| Sets | The resolve gives a set's first 5 tracks whole and the rest as stubs `{id}`; the stubs within `maxEntries` go **50 a request** to `/tracks?ids=` (51 is a 400), whose answer comes in no particular order: put back in the set's order by id; an id it leaves out was removed (left out, logged). A private set adds `playlistId` and `playlistSecretToken`. |
| Errors | 429 / 5xx: every api request backs off together (Pacer) and is retried (3 tries). A 403 with `x-datadome` or a captcha body: `source:blocked`, and the source steps aside for 10 minutes (`available` false: yt-dlp, where there is one, takes SoundCloud urls). An answer in a shape this module doesn't read, a track without formats or with formats it doesn't know, or every format answering 404: `source:format-changed` (yt-dlp's SoundCloud extractor takes that url). |
| Cache | Tracks by id 30 min (5,000), `<user>/<slug>` → id (5,000), users 30 min (500), listings 15 min (100). Resolves of one page at the same time share one request; so does a client id read (`Coalescer`). |
| Pace | api-v2 and the web app: one Pacer, 2 in flight 0.7 to 1.1 s apart (`soundcloud.pacing`; yt-dlp's figure is about 600 requests per 10 minutes). |
| Endpoints | The API, the web app, the short-link host, the asset host and the page size live in `src/sources/soundcloud/endpoints.ts` with the client id patterns and the preset order; `soundcloud.endpoints` overrides them without a release. |

**What was verified, and what wasn't.** Verified live on 2026-10-27
(anonymous, from Mexico): see the CHANGELOG's Status line 5 for the live
matrix and the downloads (ffprobe codec and length against the track's, and
a full decode). The client id from the hydration and from the bundle, the
resolve of tracks, a private `s-` track, sets, users and their tabs, a 404,
`m.` pages, `?ids=` capped at 50 and unordered, short links (one 302), the
5-minute playlist link and the 2-hour segments were checked by hand first
(`.local/soundcloud/research.md`). **Not verified**: a private `s-` set, a
Go+ preview and `policy: BLOCK` from this region (none seen; the fake serves
the shapes yt-dlp and cobalt describe), DataDome's 403 (not reproduced; the
fake serves yt-dlp #15660's), the hydration id ever going stale while the
bundle's works, `encrypted-hls` (AES-128) live, the razr 50. `soundcloud:
false` hands SoundCloud urls to yt-dlp's SoundCloud extractor.

## Bluesky (built-in extractor)

Posts and public profiles are read by the library itself from Bluesky's
public AppView (no session), and every file is the author's **original
blob** from their own server (PDS), streamed to disk. yt-dlp's Bluesky
extractor reads the same API and the same blobs, for posts only (no
galleries, no profiles), so nothing is handed to it: every failure says its
own reason.

```ts
scheduler.schedule({url: 'https://bsky.app/profile/bsky.app/post/3mnslrkd6ok2g', profile: {kind: 'video', container: 'mp4'}, outDir, slideshow: {mode: 'images', secondsPerImage: 3}})
scheduler.schedule({url: 'https://bsky.app/profile/jay.bsky.team', profile: {kind: 'video', container: 'mp4'}, outDir})
```

| | How |
| --- | --- |
| Links | `/profile/<actor>/post/<rkey>` (and its `/quotes`, `/likes`, `/reposted-by` pages): one post; `/profile/<actor>`, `/media`, `/video`, `/posts`, `/replies`: a profile, always listed as its media posts. The actor is a handle (`jay.bsky.team`) or a DID (`did:plc:…`, `did:web:…`, also percent-encoded). On `bsky.app`, `www.bsky.app`, `main.bsky.dev`, `staging.bsky.app`, and `at://<actor>/app.bsky.feed.post/<rkey>`. Feeds, lists and starter packs are not read. |
| How it is read | A post is **one request**: `app.bsky.feed.getPostThread?uri=at://<actor>/app.bsky.feed.post/<rkey>&depth=0&parentHeight=0` on `public.api.bsky.app` (a handle works in the at-uri). Checks of posts not read yet go **25 at a time** through `app.bsky.feed.getPosts`, which takes DIDs only (a handle in an at-uri is a 500): each handle is resolved once (`com.atproto.identity.resolveHandle`, or learned from any post or profile read). |
| Media | Read from the post's own record by its embed's `$type`: `app.bsky.embed.images` (up to 4) and the new `app.bsky.embed.gallery` (2026-06, up to 10 in the app) are pictures, a `slideshow` exactly as Instagram's (one picture is a one-image photo post); `app.bsky.embed.video` is one video; `recordWithMedia` is its own media only (the quoted post is someone else's: its own link downloads it). A pure quote, a link card or a text post: `unavailable` / `format-unavailable`. Any other embed type: `unavailable` / `retry-later` naming the type. Each file: `com.atproto.sync.getBlob?did=&cid=` on the author's PDS, the bytes the author uploaded (a JPEG stays the JPEG; a video is the progressive H.264 MP4 Bluesky's video service made, up to 1080p, where its HLS stops at 720p). A picture falls back to the CDN's `feed_fullsize` (a WebP re-encode) when the PDS refuses or fails. HLS is not used (a later fallback for videos, once the core has an HLS module). |
| PDS | From the DID document: `plc.directory/<did>` or `https://<host>/.well-known/did.json` for `did:web`, its `#atproto_pds` service; once per account (2,000 kept), read again on a retry (`fresh`) in case the account moved. |
| Listing | One `app.bsky.actor.getProfile`, then `app.bsky.feed.getAuthorFeed?actor=<did>&filter=posts_with_media&includePins=true&limit=100` by its ISO cursor (no `cursor` on the last page). The pinned post comes first (`reasonPin`, whatever its date) and is listed once (de-duplicated where its date puts it again), never counted towards `known`; reposts (`reasonRepost`) and anyone else's posts are left out; the author's own replies with media are in (what the filter gives). Map by rkey, a cursor seen twice or 3 pages with nothing new end the walk (`walkCursor`), `maxEntries` (default 500, `bluesky.maxProfileItems`), `known` (an incremental sync stops after 20 known posts in a row), chunks of 500 kept as they come. Every listed post is whole in the page: checks and downloads ask the AppView for nothing more. |
| Cache | Posts by rkey for 1 h (blobs never change), 5,000 kept; handles → DIDs 1 h (2,000); profiles 30 min (500); listings 15 min (100). Reads of one post, one handle, one DID document or one profile at the same time share one request (`Coalescer`). |
| Errors | A deleted post (a 400 `NotFound`, or a thread entry `notFoundPost` / `blockedPost`), an unknown handle or account (`Profile not found`, `Unable to resolve handle`): `removed`. An account labelled `!no-unauthenticated` (it asks to be hidden from signed-out visitors, and the web app honours it): `needs-sign-in`, post and profile. 429 / 5xx from the AppView back every request off together (Pacer) and are retried. |
| Pace | The AppView: 3 in flight, 0.3 to 0.5 s apart (`bluesky.pacing`; it sends no rate limit headers). Each PDS host: its own pacer, 2 in flight 0.1 s apart (`bluesky.pdsPacing`), 10 a second at most, its documented 3,000 per 5 minutes per IP. Its `ratelimit-remaining` / `ratelimit-reset` are read on every blob: under 50 left, pictures come from the CDN first until the window resets; a 429 holds that host's blob requests until the reset. The CDN is not paced. |
| Resume | A PDS ignores `Range` (a 200 with the whole body): a blob download that breaks is started over once (`fetchMedia` writes a 200 from byte 0), then the engine's own retries. |
| Endpoints | The AppView, the PLC directory, the did:web document, the image CDN and the feed filter live in `src/sources/bluesky/endpoints.ts`; `bluesky.endpoints` overrides them without a release. |

**What was verified, and what wasn't.** Verified live on 2026-10-26
(anonymous, from Mexico; `npm run live:matrix -- --platform bluesky`, with
and without `--native`, 19 of 19 links): single-picture posts, a quote with
a picture, galleries of 2, 3, 5, 7 and 10 pictures (`images` and `gallery`
embeds), videos, links by handle and by DID, profiles by handle, by DID and
as `/media`; downloaded natively (`--native --download`, 15 of 15): every
picture the original JPEG or PNG byte for byte (the record's sizes, no
WebP), videos H.264 1080 × 1920 / 720 × 1280 + AAC (the blob, above HLS's
720p). getBlob ignores `Range`, sends `ratelimit-*`; the AppView sends
none; getPosts with a handle is a 500. Bluesky gives no video length: the
file says it. **Not verified**: a `!no-unauthenticated` account (none
found: the fake serves the label as the AppView documents it), a `did:web`
account and a third-party PDS (the fake serves both), a PDS that answers
429, a video still processing or a deleted blob, Tenor GIF link cards, the
razr 50. `bluesky: false` hands Bluesky urls to yt-dlp's Bluesky extractor
(posts only).

## Twitch (built-in extractor for clips, VODs and live channels)

Clips, VODs and both kinds of channel listing are read by the library itself:
plain GraphQL queries on `gql.twitch.tv`, anonymous unless the user is
signed in to twitch.tv in the browser the engine reads cookies from (then
subscriber-only VODs, clips and streams play: see Session). A clip is a signed
progressive MP4 on Twitch's CDN, streamed to disk with resume (Range); a VOD
(a past broadcast, a highlight, an upload) is HLS, downloaded by the core's
own HLS module (`core/hls`). A **channel on the air is recorded** from its
link (`twitch.tv/<channel>`) by the core's live recorder (`recordHls`):
from the oldest segment Twitch still lists, ads left out, until you stop it
(the recording is kept), the broadcast ends, or 12 hours. Nothing live is
ever handed to yt-dlp. A VOD whose broadcast is still going stays
`live-now`: the channel link is the way to record it.

```ts
scheduler.schedule({url: 'https://clips.twitch.tv/FaintLightGullWholeWheat', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.twitch.tv/shroud/clips?range=30d', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.twitch.tv/videos/2868182901', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.twitch.tv/riotgames/videos?filter=highlights', profile: {kind: 'video', container: 'mp4'}, outDir})

// a live channel: one job that records until stop (kept) or cancel (discarded)
const job = engine.add({url: 'https://www.twitch.tv/xqc', profile: {kind: 'video', container: 'mp4'}, outDir})
engine.on('job', j => j.progress.live && console.log(j.progress.elapsedSec, j.progress.bytes)) // no fraction, no ETA
engine.stop(job.id) // later: finalized, validated, checksummed and archived; engine.cancel(job.id) keeps nothing
engine.job(job.id)?.recording // once recorded: {ended: 'stopped' | 'endlist' | 'offline' | 'max-duration' | 'refused', seconds, gaps, skippedSeconds, …}

// watching without recording: the signed master url for the host's own player (built, not fetched)
const playback = await engine.livePlayback('https://www.twitch.tv/xqc') // undefined off the air
```

| | How |
| --- | --- |
| Links | `clips.twitch.tv/<slug>`, `clips.twitch.tv/embed?clip=<slug>`, `(www./m./go.)twitch.tv/<channel>/clip/<slug>`, `twitch.tv/clip/<slug>`: one clip (old CamelCase slugs and the new ones with a `-suffix`). `twitch.tv/<channel>/clips` with `?range=24hr`, `7d`, `30d` or `all` (also after `?filter=clips&`): a channel's clips in that period, the site's default (7 days) without one. `twitch.tv/videos/<id>`, `/<channel>/v/<id>`, `/<channel>/video/<id>`, `player.twitch.tv/?video=v<id>`, `/<channel>/schedule?vodID=<id>` (`?t=1h2m3s` is read, the whole VOD downloaded): one VOD. `twitch.tv/<channel>/videos` with `?filter=all`, `archives`, `highlights`, `uploads` or `past_premieres` and `&sort=time` or `views`: a channel's videos, all of them newest first without either. `/<channel>` and `player.twitch.tv/?channel=`: the channel's live stream, recorded while it is on the air (checked only, in a batch). The share sheet's `?tt_medium=&tt_content=` is tracking (mix lists drop it). |
| How it is read | A clip is **one request**: `POST https://gql.twitch.tv/gql` with a plain (raw) query, `clip(slug)` with its `videoQualities`, its assets and its `playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"})`. Raw queries on purpose: the persisted-query hashes yt-dlp sends rotated four times in 13 months; cobalt's raw clip query has not changed in two years. Checks of clips not read yet go **15 a request** (aliases `c0`…`c14` of `clip`: 15 root fields is Twitch's limit). |
| Media | The H.264 `videoQualities` (1080p60 down to 360p; one `/avc/1080` file on 2016 clips) and the landscape asset's, plus the HEVC file the token's `clip_uri` names (1440p on new clips), each signed `?sig=<signature>&token=<value>` with the clip's one token (unsigned: 401). Ranked by `rankRenditions`: MP4 takes H.264 (1080p), MKV / WebM the HEVC 1440p. The portrait asset is another framing of the clip, not another size: left out. |
| VODs | **One query** for the VOD and its playback token together (`video(id) { … status … }` and `videoPlaybackAccessToken(id, params)`), **one usher request** for the master playlist (`usher.ttvnw.net/vod/<id>.m3u8?allow_source&allow_audio_only&platform=web&player=twitchweb&supported_codecs=…&playlist_include_framerate&p&sig&token`), then the chosen variant's media playlist and its segments. `supported_codecs` is `h264` for an MP4 profile (no transcode) and `av1,h265,h264` for any other; usher answered H.264 only either way for every VOD tried (32 channels' latest past broadcasts, highlights and uploads back to 2014), so what it does with HEVC or AV1 VODs is not known yet. Variants without sound (a 2014 highlight's "high", `avc1.42C01F` alone) are left out; the rest go through `chooseVariant` / `rankRenditions` like every native source (the `chunked` source variant for the best, the height cap honoured, `audio_only` for an audio profile). Segments are fMP4 (one `EXT-X-MAP`) on newer VODs, MPEG-TS on older ones, 10 s, unsigned, fetched k at a time (`fragmentsPerDownload`) with resume, by `downloadHls`. Muted parts are listed by Twitch as `<n>-muted.ts` (200; the bare name and `-unmuted` answer 403): a `-unmuted` part is asked as `-muted`, as yt-dlp does. A segment refused with 401/403 re-signs through a fresh token and a new master, the same variant by path. Recorded as `v<id>` (yt-dlp's id), duration from `lengthSeconds`. |
| Listing | Clips: `user(login).clips(first: 100, after, criteria: {filter})` (`LAST_DAY`, `LAST_WEEK`, `LAST_MONTH`, `ALL_TIME` from the link's `range`), top by views, the site's order. Every node carries its signed encodings, so **a listed clip is never read again** (its check and its download ask for nothing). The cursor is the last edge's (a base64 offset, `MTAw` = 100); `hasNextPage` turns false at offset 1,000 whatever the period, so a listing holds 1,000 clips at most. Not newest first: `known` can't stop an incremental walk early. Videos: `user(login).videos(first: 100, after, type, sort)` (`ARCHIVE`, `HIGHLIGHT`, `UPLOAD`, `PAST_PREMIERE` from the link's `filter`, none for `all`; `TIME` or `VIEWS`), with `totalCount` (the playlist's `total`). The cursor is `"<videoId>\|<n>\|<publishedAt>\|<n>"`, the same on every edge of a page and null on the last (read past page 3 of a 2,667-video channel). Every listed VOD is kept, so its check reads nothing and its download asks only its token (one query) and usher. Newest first (`sort=time`), an incremental walk (`known`) stops at the end of the page where 20 known VODs in a row are met. A VOD still recording is listed with `isLive` (the engine skips it). Both: Map by id, a cursor seen twice or 3 pages with nothing new end the walk (`walkCursor`), `maxEntries` (default 500, `twitch.maxListItems`), a refusal half-way keeps the pages read (`complete: false`). |
| Live: reading | A channel link is **one query** for the stream and its token together (`user(login) { stream { id type title createdAt } }` and `streamPlaybackAccessToken(channelName, params)`) and **one usher request** for the channel's master playlist (`usher.ttvnw.net/api/channel/hls/<login>.m3u8?allow_source&allow_audio_only&fast_bread&platform=web&player=twitchweb&supported_codecs=…&playlist_include_framerate&p&sig&token`, `h264` for an MP4 profile, `av1,h265,h264` otherwise). An analysis gives one item with `isLive: true`, its qualities from the master, titled `<channel> <started-at> <title>`; what it read (stream, token, master) feeds the recording that follows within a minute, so the recording asks nothing again. Offline (`stream: null`, or usher's 404 `transcode_does_not_exist`) it is `unavailable` ("not live: nothing else to download", its `/videos` and `/clips` named). In a batch's checks a channel on the air stays `unavailable` / `live-now` (a batch never records; a recording is its own job). A VOD whose `status` is `RECORDING` stays `live-now` too, before usher is asked, its message naming the channel link that records it; one whose status says `RECORDED` but whose playlist has no end yet is `live-now` the same way. `TwitchSource.liveStream(login)` (one request) and the pure reader `readLiveStream` give the stream id, login, display name, title, start time and type. |
| Live: recording | `recordHls` on the chosen variant's media playlist (Twitch: 2 s MPEG-TS segments, a target duration of 6 s, a window of about 30 s): from the oldest segment listed (`twitch.live.from`, default `'window'`), re-read every target duration, each new segment fetched once, in order, by its media sequence. **Ads are left out** (`twitch.live.skipAds`, default true): a segment titled other than `live` (Twitch titles ads `Amazon|…`) or dated inside an `EXT-X-DATERANGE` of CLASS `twitch-stitched-ad` is not fetched, a new period starts where it was, and its seconds are counted (`SourceFile.recording.skippedSeconds`, in the engine's log). A refused playlist (401/403/410) re-signs: one query for a fresh token (the stream must still be the same broadcast id) and one usher request, the same quality by its name (`1080p60 (source)`), else by height, frame rate and codec. It ends when you stop it (`MediaDownloader.stop`: kept, then converted, validated, checksummed and archived like any download), on ENDLIST, after 10 reloads in a row with nothing new (offline), when a re-sign finds the channel offline or on another broadcast, or at `twitch.live.maxDuration` (default 12 h). `cancel` discards it. File name `<channel> <started-at> <title>` (the broadcast's start, local time); archived as `live-<stream id>-<recording start>`, so recording the same broadcast again is a new file. Never handed to yt-dlp, whatever fails: a native failure that would send a VOD to yt-dlp fails a live recording with the source's own reason. |
| Client id | `twitch.clientId`, default **`ue6666qo983tsx6so1t0vnawi233wa`** (yt-dlp's since 2023-06). The web player's own **`kimne78kx3ncx6brgo4mv6wki5h1ko`** (cobalt's and streamlink's) reads single clips and the first listing page, but every page after the first answers `IntegrityCheckFailed` (a Client-Integrity token the site's JavaScript makes in a browser, which this library does not run). The default is the one that read every page live; if Twitch gates it too, a host passes the other, or a newer one, without a release. |
| Cache | Clips by slug until their token's `expires` less 10 minutes (~20 h), 6 h at most, 2,000 kept; VODs by id 6 h (a minute while recording), 2,000 kept; VOD tokens with the masters they signed until the token runs out, 6 h at most, 100 kept (an analysis's master serves the download: no second usher request for an MP4 profile when it has H.264); listings by channel and period, or channel, filter and sort, 15 min (100 each). Reads of one clip, one VOD or one token at the same time share one request (`Coalescer`). `fresh` (a retry) signs again; a VOD download that fails drops its token. |
| Errors | `clip: null` / `video: null` (deleted, or never there) → `unavailable` / `removed`; `user: null` → `removed` ("no Twitch channel by that name"); usher 404 → `removed`. A token whose `authorization.forbidden` is true, or usher's 403 JSON with `error_code` `vod_manifest_restricted` / `unauthorized_entitlements` (what yt-dlp and streamlink read for subscriber-only VODs) → `unavailable` / `needs-sign-in` (`members-only` when the request was signed in), not handed to yt-dlp. A kept token usher no longer takes (403 `nauth_sig_invalid`) is replaced once. `IntegrityCheckFailed` → `source:blocked`: clips and clip listings go to yt-dlp for 10 minutes (VODs and channels are still read here). A GraphQL error naming a field, an argument or a type (Twitch renamed something), a 400 (a missing or refused Client-ID), a clip without its token or without encodings, usher answering anything but a master playlist, or another usher 403 → `source:format-changed`: the engine hands the url to yt-dlp, whose Twitch extractor reads clips and VODs too. 429 / 5xx back every GraphQL request off together (Pacer) and are retried; usher's are `retry-later`. |
| Live: a host's player | `MediaDownloader.livePlayback(url, {signal?, fresh?})` (and `TwitchSource.livePlayback`) gives a channel's master playlist url, signed, with `supported_codecs=h264` (what a browser's MSE plays), the token's expiry (`expiresAt`) and the broadcast as an analysis describes it (`media`, `isLive: true`), or `undefined` off the air and for any other link. The url is built, never fetched: the stream and its token come from the read an analysis or a recording made within a minute (one query serves the three), else one query; `fresh: true` reads again (a signature that ran out). Usher's channel master answers only twitch.tv origins and its weaver playlists refuse other origins with a 403 (research, 2026-10-27), so a renderer fetches it through a process with no `Origin` (the app's main process). |
| Session | `twitch.cookies` (a `SessionProvider`): the engine passes the `.twitch.tv` cookies of the jar it reads for yt-dlp (`cookiesFromBrowser`, else `cookiesFile`), as it does for Instagram, Facebook and Threads; a host's own `twitch.cookies` wins. Read once, then every 6 h. Only the `auth-token` cookie is used, and never as a cookie: it goes as `Authorization: OAuth <auth-token>` on the **single reads that mint a playback token** (a clip, a VOD and its token, a live stream), on the web player's client id (`twitch.authClientId`, default `kimne78kx3ncx6brgo4mv6wki5h1ko`: twitch.tv mints the token for it; streamlink sends the same pair). Listings and batched checks stay anonymous on yt-dlp's id (the web id gets `IntegrityCheckFailed` past page 1). A clip a listing found forbidden passes its check when the user is signed in and is read once more, signed, at download; a subscriber-only VOD read before signing in gets one signed token. Still forbidden with a session → `unavailable` / `members-only` ("the signed-in Twitch account has no access"); without one → `needs-sign-in`. A **refused session** (401: an invalid or revoked token answers 401 for the whole query, checked live; or an integrity check on a signed read): the read is retried once anonymously, the cookies are dropped, one warning is logged, and every read goes anonymous for 30 minutes (`SESSION_REFUSED_MS`, as Meta's) before the host's cookies are asked for again: one extra request per window, never per link. Cost: 0 extra requests without a session or with one that works; header building O(1). |
| Pace | One Pacer for gql.twitch.tv: 2 in flight, 0.5 to 1 s apart (`twitch.pacing`). Usher and the CDNs are not paced. |
| Endpoints | The GraphQL and usher urls and the clip and video fields read live in `src/sources/twitch/endpoints.ts`, with both client ids; `twitch.endpoints` overrides them without a release. |
| Cost | A pasted VOD: 1 GraphQL + 1 usher + 1 media playlist, then 1 GET per segment (about one per 10 s: 372 for an hour), O(1) each, memory O(segments) for the parsed list + O(k) streams; a listed VOD: 1 token query instead of the read. A video listing: ⌈n / 100⌉ requests, O(1) per VOD; its checks 0 requests, checks of VODs not read yet ⌈n / 15⌉. A live recording: 1 GraphQL + 1 usher before the first segment (none right after an analysis), then 1 playlist request per reload (about every 6 s) and 1 GET per segment (2 s each: 1,800 an hour), O(1) each, memory flat over 12 h (`scripts/hls-record-bench.ts`); 1 query + 1 usher per re-sign, only on a refusal. |

**What was verified, and what wasn't.** Verified live on 2026-10-26
(clips) and 2026-10-27 (VODs), anonymous, from Mexico: raw `clip` queries
on both client ids; the token signing every H.264 quality and the HEVC
1440p (`Range` answered 206, `Content-Length` 50,485,614 for a 51 s
1080p60 clip, H.264 + AAC per ffprobe); a 2016 clip's single AVC file;
batches of 3 clips with a deleted one (`null`); clip listings on the
default client id, pages 1 to 3 of shroud's all-time clips, and the web
player's id answering `IntegrityCheckFailed` on page 2; a missing channel
(`user: null`); a channel on the air and its VOD in progress (`status:
RECORDING`, usher's playlist open: EVENT without ENDLIST) failing as
`live-now`; an offline channel. VODs: the VOD and its token in one raw
query, a deleted one (`video: null`, no token); usher masters of past
broadcasts, highlights back to 2014, uploads and a past premiere (all H.264
+ AAC, the same with `supported_codecs=h264`, `av1,h265,h264` and `av1`);
a bad signature (403 `nauth_sig_invalid`); muted parts (`1872-muted.ts`
200, `-unmuted` and the bare name 403); video listings by type and sort,
riotgames' 2,667 videos past page 3 by the `<id>|<n>|<date>|<n>` cursor;
13 short VODs downloaded natively (TS and fMP4, 1080p60, 720p and portrait,
H.264 + AAC, full decode check clean) and the ~1 h one in TW-08 (see the
CHANGELOG). Four VODs (highlights 5938473, 6732619, 1484137772 and the muted
past broadcast 2795007999) fail the full decode check natively, and exactly
the same way through yt-dlp and through ffmpeg reading usher's playlist
alone: they are damaged at the source, and left out of the download check.
**Not verified**: a subscriber-only clip or VOD (none found anonymously:
the fake serves what yt-dlp and streamlink read for one), an HEVC or AV1
VOD (none found, so what usher does with `supported_codecs` for one is not
known), a CDN token running out mid-download on the real CDN (VOD segments
are unsigned today), a 429 from gql.twitch.tv or usher (none seen), the
razr 50. `twitch: false` hands every Twitch url to yt-dlp.

**Signed in: what was verified, and what wasn't.** Checked live (anonymous):
an invalid `Authorization: OAuth` token makes Twitch answer 401 for the
whole query, on both client ids. Everything else is tested on the fake only
(the fake takes what yt-dlp and streamlink describe): no Twitch account was
available. **Not verified**: that a twitch.tv `auth-token` with the web
player's id mints an allowed token for a subscriber-only VOD, clip or
stream; whether yt-dlp's id takes the same token (if it does, the default
`authClientId` could be the anonymous one); that a signed
`streamPlaybackAccessToken` / `videoPlaybackAccessToken` is not refused
for a missing Client-Integrity token; that Firefox and Edge on Windows
export `.twitch.tv auth-token` through the engine's jar (Chrome's cookies
are unreadable there).

**Live channels: what was verified, and what wasn't.** Verified live on
2026-10-27, anonymous, from Mexico, through the whole engine (native: no
yt-dlp, ffmpeg and ffprobe from the PATH, full validation): the stream and
its token in one query on the default client id; usher's channel master at
`/api/channel/hls/<login>.m3u8` (and `/api/v2/…`, the same master with its
info as `EXT-X-SESSION-DATA`), H.264 + AAC variants up to 1080p60; media
playlists of 2 s MPEG-TS segments titled `live`, a target duration of 6 s,
a window of 22 to 32 s, a program date-time on every segment. summit1g
recorded from the window and stopped after 180 s: 202 s kept (the 22 s
window + 180 s), 101 segments, no gap, 0 s of ads; the engine converted,
validated (full decode), checksummed and archived it; ffprobe H.264 Main
1920x1080 60 fps + AAC LC 48 kHz stereo, 202.003 s, and a full decode on
its own (`ffmpeg -xerror` into the null muxer) exits 0. cdawg cancelled
after 30 s: the job `cancelled`, no file, its work folder gone. A first
run (xqc, before segments got their 10 s stall watchdog) lost 17 segments
to one gap when a segment request hung for the download watchdog's minute;
it was kept, finalized and validated (170 s, H.264 1080p60 + AAC, decode
clean). **Not verified**: a live ad break (none came during these runs, so
no skipped seconds were measured on real ads: the ad rules follow Twitch's
stitched-ad date ranges and `Amazon|…` titles as streamlink reads them), a
token or playlist refused mid-recording (none in 3 to 4 minutes; the fake
covers it), a broadcast ending or going offline while recorded, an HEVC or
AV1 live variant, a recording near the 12 h cap, a subscriber-only or
geo-blocked stream, the razr 50 (app work: a foreground service).

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
