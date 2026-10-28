# The local path

Why a public post of Instagram, TikTok or Facebook is read on the machine of whoever uses the program, with no server of ours in between, and how each retry is chosen. The decision holds for every host: the desktop app, the command line and the phone. Back to the [README](../README.md).

Measured on 2026-10-26 against the engine 1.20.1. This document changes no code.

## What was measured

A PC on a home network, the built-in extractors only: no yt-dlp, no proxy. First the read, then a real download of the MP4.

| Case | Result | Time |
| --- | --- | --- |
| Instagram reel (NASA) | Real title, duration, 1080p MP4, audio. Anonymous route: embed | read 2.4 s, file 0.5 s |
| TikTok video (`@complex`) | 1080p, 720p and 576p MP4, no signatures of our own | 1.8 s |
| Facebook reel | 576p and 360p | 4.3 s |
| Facebook `share/r/` link | Followed to the reel; 1080p and 360p | 3.3 s |
| Instagram stories (`@nasa`), signed out | `needs-sign-in`, at once, no loop | 0.9 s |
| Instagram profile, signed out | `needs-sign-in` | 0.9 s |

The file comes from the site's own CDN. Nothing of ours carries it.

A title such as `Facebook 1557…` is not a failed read: a post with no text is named by its id. When the post has text, as NASA's reel does, the real title comes through.

The same three public links were then checked on a Motorola razr 50 with the Android app, which runs the same engine without yt-dlp: see the phone's README for the run. A home network's IP, and a phone's, is the kind these sites treat best. A datacenter's is the kind they refuse first.

## Why a web backend is not the next step

A blueprint proposed: if the client fails, a private API on Vercel, a 15-minute cache, one retry through a datacenter proxy and another through a residential one, and a web portal with ads to pay for it.

That turns the cost upside down. Whoever uses the program already comes from a residential IP. Vercel comes from a datacenter IP, the one Instagram and Facebook block first. A residential proxy is paid per gigabyte, and the function is paid for the time the proxy takes. A link that reads here in two seconds would become a function, a retry and a cache write, every time.

It also turns a tool into an operated service: logs, abuse, rights claims and a monthly bill, where today there is none of that.

And the blueprint was not ready to be built: two names for the one endpoint, two names for the signature header, a Facebook answer shown for an Instagram request, a cache of CDN URLs that expire before 15 minutes are up, and an HMAC secret "protected" inside a native library that is extracted from any APK.

No API repository is created. No scraper is deployed. No proxy, cloud cache, signature, cookie pool, account creation or ads enter any host.

## Ads

Download sites carry aggressive ads because AdSense, and Google Play, refuse a page whose use is to save other people's videos. The networks that do accept them pay for cheap clicks: pop-ups, fake buttons, autoplaying video. That earns for a while and then closes the account or the listing.

Here the engine needs no ad to work. Every host stays free and without ads. Support is voluntary, one way, the same on every host: **Buy me a coffee**, at https://buymeacoffee.com/mediadownloadcore. The words next to it: the program is free and has no ads; it runs on your device; if it helped you, you can buy me a coffee; it is voluntary, and the program stays the same either way. It lives in About, never over the Download button nor inside a step of the guide, and tapping it says the link opens outside the app.

## Retries: three layers, not a loop

"Retry" covers three different things. Mixed up, a verification wall becomes a loop.

**The door.** Instagram has five anonymous routes: embed, web info, the page, the signed-out query, the app's API. `RouteHealth` orders which goes first and cools the one that just answered a wall, from 1 minute to 30. The others go on. That is not a retry: it is another door.

**The same attempt, when the network failed.** A 429, a 5xx or an empty answer is repeated up to 3 times (`READ_ATTEMPTS`) after the shared pause of the `Pacer`. A "please wait" page or a checkpoint never enters here: the code leaves the loop as soon as the problem is `challenge`.

**Another strategy, when the door and the network are not enough.** Here is the browser, and only here.

| What the site answered | Strategy | How many times |
| --- | --- | --- |
| 429, 5xx, empty answer | The same HTTP, after the `Pacer`'s pause | 3 |
| A page served only after its own JavaScript ("please wait") | `BrowserAssist`: one load; its cookies and user agent are adopted; the rest goes on over HTTP | 1, one at a time |
| The browser also gets a captcha or a login wall | The site steps aside for 10 minutes (`BLOCKED_MS`). With yt-dlp, it takes over. Without it (a phone), the error reaches the user | no more browsers |
| Stories or a profile, no cookies | `needs-sign-in`. No empty browser is opened: that page carries no video | 0 |
| The user's cookies, already kept | Those cookies, through the `cookies` option the sources already take | 1 session. When they stop working they are forgotten and asked for again |

The browser never solves "verify you are human". When the HTML is the real page, the source adopts the session and goes on over HTTP. When it is a captcha, it steps aside and does not try again.

The host supplies that browser. On the desktop it is a hidden window while the app is open; on the phone, a 1×1 WebView. It lasts one page load. Then the CDN file is downloaded over HTTP, and that part can run in the background: the URL is already known.

A browser left running with nobody in front of it is not a strategy. Android kills it, and a verification loaded on its own ends at the same wall. The load goes with the program in use: one URL, a few seconds. If it passes, what goes on in the background is the file. If the captcha shows, the queue stops and tells the user.

The analysis a person waits for retries a transient failure up to 3 times (`ANALYZE_ATTEMPTS`) on every site but an Instagram post. An Instagram post tries five anonymous variants and then, if it must, three reads with the session; if those fail it says to try again in about 5 minutes. It never retries an invalid, private, removed or cancelled link, nor a "needs sign-in" when there is no session.

## Stories and profiles: the user's session, once

Stories, highlights and the listing of a profile are not read as a visitor. They need the session of whoever uses the program, through the `cookies` option Instagram, TikTok and Facebook already take (`SessionProvider`, asked again every 6 hours, forgotten when it stops working). No new extractor is needed.

Creating accounts so that the site "does not ask to verify you are human" does the opposite. A new account, used by a process with nobody watching, is exactly the case these networks send to verification, and several accounts rotating trigger it more often. The engine does not solve that wall and must not: when it shows, the download waits for a person.

Each host obtains the session its own way. The desktop reads the browser the user is signed in to. The phone opens the site's sign-in page in its own WebView, once, and keeps that site's cookies on the device; it takes a session only once the site has set its account cookie, so visiting the sign-in page without signing in stores nothing. Nobody has to leave the device unlocked while files download.

## What the engine already has

Read after the measurement, on the code of 1.20.1, so as not to propose a version that rewrites what is there.

| Piece | Where | What it does |
| --- | --- | --- |
| Instagram extractor | `src/sources/instagram/` | Five anonymous routes, the cheapest first. Stories and profiles ask for a session before insisting |
| TikTok extractor | `src/sources/tiktok/` | Reads the public page, follows short links, downloads the MP4. Generates no signatures (`X-Bogus`, `msToken`) |
| Facebook extractor | `src/sources/facebook/` | Reads the progressive video (HD and SD). Watch, reels and share links |
| Pace | `Pacer` | At most 2 requests at once, 1.5–2.5 s apart. A refusal cools everyone, 30 s to 10 min |
| Route health | `RouteHealth` | The route that just failed cools down; the others go on. Forgetting is by time, not by a release |
| Browser assist | `BrowserAssist`, `src/sources/browser.ts` | Supplied by the host. One page; cookies and user agent adopted. The engine runs or solves nothing |
| Circuit breaker | `BLOCKED_MS` = 10 min | When the browser also sees the wall, the site goes to yt-dlp for that long. Without yt-dlp, the extractor's own error |
| The user's session | `cookies` option (`SessionProvider`) | Instagram, TikTok and Facebook take it. Asked again when old; forgotten when it stops working |
| Optional yt-dlp | `ytDlp: 'optional'` | A host without the binary (a phone) keeps the native extractors and gets a clear reason where they would hand over |
| Analysis retry | `ANALYZE_ATTEMPTS` = 3; an Instagram post is 5 anonymous + 3 with the session | Transient failures only; a spent session waits 5 minutes |
| Queue, resume, archive | the job engine | The large file never passes through a server. An interrupted job resumes. Every file is verified |

What the blueprint wanted to buy with proxies, reading a public post and downloading the MP4, the engine already does. **The engine stays at 1.20.1.** A new version would only make sense if a measurement showed a public network no longer answering through any of the routes that exist. That did not happen in this reading.

## What each host says

The engine does not change. What a host has to say on first use follows from this decision. The desktop already asks for the browser's session when it is needed. The phone's guide has four steps; the link field stays visible in the first, and Skip stays on every step but the last.

1. **Paste a link.** A public video or reel of TikTok, Instagram or Facebook, or a video of VK or X. It downloads on this device, with no account.
2. **Choose what you get.** MP4 to watch, MP3 to listen, and the quality.
3. **Download.** The file comes straight from the site, and goes on if you leave. It lands in Finished, checked and ready to play.
4. **Stories and profiles.** Sign in once, inside the app. That session stays on the device. If a site asks you to prove you are a person, the program stops and waits.

## Decision

| Piece | Decision |
| --- | --- |
| Engine 1.20.1 | Stays. No new version |
| API, cloud cache, proxies, HMAC | Not built |
| Ads | None, on any host |
| Background | The download of a file already resolved. Not a browser, not new accounts |
| Browser | One load, only when the page demands its own JavaScript. Then HTTP |
| Stories and profiles | The user's session, once |
| Hosts | Say the same. Support is https://buymeacoffee.com/mediadownloadcore, in About |
