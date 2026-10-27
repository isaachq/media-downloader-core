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
| The session | The browser cookies the engine already reads for yt-dlp (`setCookiesFromBrowser`), else `cookiesFile`, filtered to the site's domain — read once, asked again every 6 hours. A host may pass `cookies` itself, as cookies or as `{cookies, userAgent}` (the agent that earned them, e.g. an in-app sign-in); TikTok takes the same option (`tiktok.cookies`). Nothing is stored beyond the engine's cookie jar. A session the site refuses (a 4xx to a request it serves a visitor) is dropped for 30 minutes and the post is read as a visitor, one extra request once per window; stories and listings then say to sign out and in again. | Same. |
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

## Twitch (built-in extractor for clips)

Clips and a channel's clips are read by the library itself: plain GraphQL
queries on `gql.twitch.tv`, anonymous, and each clip a signed progressive
MP4 on Twitch's CDN, streamed to disk with resume (Range). Finished VODs
and video listings are HLS: they are recognized but handed to yt-dlp's
Twitch extractor until the core reads HLS (`TODO(core-hls)`). **Live
streams are never downloaded**, only what is already available: a channel
on the air and a VOD whose broadcast is still going fail natively as
`live-now` and are never handed to yt-dlp (which would record them).

```ts
scheduler.schedule({url: 'https://clips.twitch.tv/FaintLightGullWholeWheat', profile: {kind: 'video', container: 'mp4'}, outDir})
scheduler.schedule({url: 'https://www.twitch.tv/shroud/clips?range=30d', profile: {kind: 'video', container: 'mp4'}, outDir})
```

| | How |
| --- | --- |
| Links | `clips.twitch.tv/<slug>`, `clips.twitch.tv/embed?clip=<slug>`, `(www./m./go.)twitch.tv/<channel>/clip/<slug>`, `twitch.tv/clip/<slug>`: one clip (old CamelCase slugs and the new ones with a `-suffix`). `twitch.tv/<channel>/clips` with `?range=24hr`, `7d`, `30d` or `all` (also after `?filter=clips&`): a channel's clips in that period, the site's default (7 days) without one. Checked here, then sent to yt-dlp when finished: `twitch.tv/videos/<id>`, `/<channel>/v/<id>`, `/<channel>/video/<id>`, `player.twitch.tv/?video=v<id>`, `/<channel>/schedule?vodID=<id>` (`?t=1h2m3s` kept as a start). Checked here only: `/<channel>` and `player.twitch.tv/?channel=` (the live stream). Sent to yt-dlp as they are: `/<channel>/videos` (`?filter=…&sort=…` kept by the parser); each VOD of such a listing comes back here when it is downloaded. The share sheet's `?tt_medium=&tt_content=` is tracking (mix lists drop it). |
| How it is read | A clip is **one request**: `POST https://gql.twitch.tv/gql` with a plain (raw) query, `clip(slug)` with its `videoQualities`, its assets and its `playbackAccessToken(params: {platform: "web", playerBackend: "mediaplayer", playerType: "site"})`. Raw queries on purpose: the persisted-query hashes yt-dlp sends rotated four times in 13 months; cobalt's raw clip query has not changed in two years. Checks of clips not read yet go **15 a request** (aliases `c0`…`c14` of `clip`: 15 root fields is Twitch's limit). |
| Media | The H.264 `videoQualities` (1080p60 down to 360p; one `/avc/1080` file on 2016 clips) and the landscape asset's, plus the HEVC file the token's `clip_uri` names (1440p on new clips), each signed `?sig=<signature>&token=<value>` with the clip's one token (unsigned: 401). Ranked by `rankRenditions`: MP4 takes H.264 (1080p), MKV / WebM the HEVC 1440p. The portrait asset is another framing of the clip, not another size: left out. |
| Listing | `user(login).clips(first: 100, after, criteria: {filter})` (`LAST_DAY`, `LAST_WEEK`, `LAST_MONTH`, `ALL_TIME` from the link's `range`), top by views, the site's order. Every node carries its signed encodings, so **a listed clip is never read again** (its check and its download ask for nothing). The cursor is the last edge's (a base64 offset, `MTAw` = 100); `hasNextPage` turns false at offset 1,000 whatever the period, so a listing holds 1,000 clips at most. Map by id, a cursor seen twice or 3 pages with nothing new end the walk (`walkCursor`), `maxEntries` (default 500, `twitch.maxListItems`). Not newest first: `known` can't stop an incremental walk early. A refusal half-way keeps the pages read (`complete: false`). |
| Live | A channel link is one `user(login) { stream { id type title createdAt } }` query: on the air (`stream` set, `type` `live` or `rerun`) it is `unavailable` / `live-now`, with no `source:*` details, so the engine never hands it to yt-dlp; offline it is `unavailable` ("not live: nothing else to download", its `/videos` and `/clips` named). A VOD link is one `video(id) { status }` query: `RECORDING` (its broadcast still on the air) is `live-now` the same way; `RECORDED` goes to yt-dlp (`source:format-changed`, hint `unsupported-url`: on a host without yt-dlp, "not supported"); `null` is `removed`. The live check is its own function for the live recorder that will come with the core's HLS module: `TwitchSource.liveStream(login)` (one request) and the pure reader `readLiveStream`, giving the stream id, login, title, start time and type. During an integrity block the source stays `available` (live checks still run here); only clip reads go to yt-dlp meanwhile. |
| Client id | `twitch.clientId`, default **`ue6666qo983tsx6so1t0vnawi233wa`** (yt-dlp's since 2023-06). The web player's own **`kimne78kx3ncx6brgo4mv6wki5h1ko`** (cobalt's and streamlink's) reads single clips and the first listing page, but every page after the first answers `IntegrityCheckFailed` (a Client-Integrity token the site's JavaScript makes in a browser, which this library does not run). The default is the one that read every page live; if Twitch gates it too, a host passes the other, or a newer one, without a release. |
| Cache | Clips by slug until their token's `expires` less 10 minutes (~20 h), 6 h at most, 2,000 kept; listings by channel and period 15 min (100). Reads of one clip at the same time share one request (`Coalescer`). `fresh` (a retry) reads again; a download that fails is read again once (a token that ran out). |
| Errors | `clip: null` (deleted, or never there) → `unavailable` / `removed`; `user: null` → `removed` ("no Twitch channel by that name"). A token whose `authorization.forbidden` is true (subscriber-only, restricted) → `unavailable` / `needs-sign-in`. `IntegrityCheckFailed` → `source:blocked`: clips and clip listings go to yt-dlp for 10 minutes (VODs and channels are still checked here). A GraphQL error naming a field, an argument or a type (Twitch renamed something), a 400 (a missing or refused Client-ID), a clip without its token or without encodings → `source:format-changed`: the engine hands the url to yt-dlp, whose Twitch extractor reads clips too. 429 / 5xx back every request off together (Pacer) and are retried. |
| Session | None: everything above is public. Signing in (the browser's `auth-token` as `Authorization: OAuth`) is left for the app's sign-in commit, with the subscriber-only VODs it is for. |
| Pace | One Pacer for gql.twitch.tv: 2 in flight, 0.5 to 1 s apart (`twitch.pacing`). The CDN is not paced. |
| Endpoints | The GraphQL url and the clip fields read live in `src/sources/twitch/endpoints.ts`, with both client ids; `twitch.endpoints` overrides them without a release. |

**What was verified, and what wasn't.** Verified live on 2026-10-26
(anonymous, from Mexico): raw `clip` queries on both client ids; the token
signing every H.264 quality and the HEVC 1440p (`Range` answered 206,
`Content-Length` 50,485,614 for a 51 s 1080p60 clip, H.264 + AAC per
ffprobe); a 2016 clip's single AVC file; batches of 3 clips with a deleted
one (`null`); listings on the default client id, pages 1 to 3 of shroud's
all-time clips, and the web player's id answering `IntegrityCheckFailed` on
page 2; a missing channel (`user: null`); a channel on the air and its VOD
in progress (`status: RECORDING`) failing as `live-now`, a finished VOD
handed to yt-dlp, an offline channel. See the live matrix results in the
CHANGELOG. **Not verified**: a subscriber-only or restricted clip (none
found: `authorization.forbidden` is what the token carries for one, the fake
serves a guess of it), a token that runs out mid-download, a 429 from
gql.twitch.tv (none seen), the razr 50. `twitch: false` hands every Twitch
url to yt-dlp.

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
