# Contributing and development

How to build, test and work on the library and the desktop app. Back to the [README](README.md).

## Building the desktop app from source

```bash
cd app
npm install
npm run dev        # development, hot reload
npm test           # UI tests (Vitest + Testing Library)
npm run test:e2e   # the real Electron app end to end (Playwright, fake tools)
npm run dist:mac   # dist/*.dmg + *.zip (arm64, x64)
npm run dist:win   # dist/*.exe installer (x64, arm64)
npm run dist:linux # dist/*.AppImage + *.deb + *.rpm (this machine's architecture; .rpm needs rpmbuild)
```

The interface is built with [Ant Design](https://github.com/ant-design/ant-design)
(MIT) — thank you to the Ant Design team for an excellent, free component library.

## Development

```bash
npm install
npm test            # the fast suite (= npm run test:fast): no ffmpeg, no network
npm run test:heavy  # the suites that encode real media (need ffmpeg/ffprobe)
npm run typecheck   # strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess, …
npm run lint        # biome
npm run build       # dist/: ESM + CJS + .d.ts
npm run stress      # orchestrator benchmark with fake binaries
npm run perf        # every benchmark 3× in fresh processes, medians compared with .perf/baseline.json
npm run perf -- --save-baseline        # keep this run as the baseline (per machine, not committed)
npm run perf -- profile stress 1000    # CPU profile + the hottest functions in src/
npm run demo -- "https://www.youtube.com/watch?v=jNQXAC9IVRw"     # list choices
npm run demo -- "https://www.youtube.com/watch?v=jNQXAC9IVRw" 0   # download choice 0
```

### Testing: smoke in CI, the full regression before a pull request

Every CI job of a pull request finishes in **5 minutes or less** (`timeout-minutes: 5` cuts
it there). What is heavy runs on your machine, before the pull request. The library's tests
come in lists, named in `scripts/run-tests.mjs`:

| Script | What it runs | Where |
|---|---|---|
| `npm run test:fast` | every suite but the heavy ones: no ffmpeg, no network | CI on Linux, macOS and Windows |
| `npm run test:integrity-smoke` | one video and one audio check with the real ffmpeg | CI on Linux (a cached static ffmpeg) |
| `npm run test:heavy` | characterization, conformance (26 profiles), integrity, matrix, resilience | locally; CI's full run |
| `npm --prefix app run test:e2e:smoke` | the three end-to-end tests tagged `@smoke` | CI on Linux |
| `npm --prefix app run test:e2e` | every end-to-end test (`@smoke` and `@full`) | locally; CI's full run |

```bash
npm run test:full   # check, heavy suites, build, pack check, then the app: typecheck, unit, every end to end test
```

Rules that keep the budget: a new library suite lands in `fast` only with no network, no
ffmpeg and every test under 2 s; otherwise it is named in `HEAVY` in `scripts/run-tests.mjs`.
A new end-to-end test is tagged `@full`; it becomes `@smoke` only by replacing one of the
three. A pull request that only touches documentation runs lint and the website check, not
the tests. The Windows update workflow (two installers, three updates) runs by hand from the
Actions tab before an `app-v*` tag whenever the update code changed; Publish library only
checks the tag, builds and publishes.

**Live URL matrix (local only, never in CI).** The suites above run against local fakes.
Before a release, `npm run live:matrix` reads real public links on Facebook, Instagram and
TikTok (`scripts/live-matrix/compendium.json`, one or more per scenario: watch links, reels,
share links, photo posts with music, carousels, profiles…) with the whole engine, timing each
link, classifying every failure with `diagnoseFailure`, and pausing 1.5–4 s between links so
a long run isn't rate limited:

```bash
npm run live:matrix                        # analyze every link (yt-dlp available, as on desktop)
npm run live:matrix -- --native            # as the Android app runs it: no yt-dlp
npm run live:matrix -- --download          # and download each item, ffprobed (video + audio, or pictures + song)
npm run live:matrix -- --only FB-05,TT-02  # some scenarios; --platform tiktok, --jitter 500-1500
```

Share links carry the sharer's id, so they live in `.local/live-matrix/compendium.local.json`
(same shape, merged by scenario id, never committed). Links that need a signed-in session
take Netscape cookie files: `MDC_LIVE_COOKIES_FACEBOOK`, `MDC_LIVE_COOKIES_INSTAGRAM`,
`MDC_LIVE_COOKIES_TIKTOK`; without one they must fail cleanly as `LOGIN_WALL_DETECTED`
(counted apart). A JSON report lands in `.local/live-matrix/`.

…and, when a release needs every system, from GitHub: **Actions → CI → Run workflow**
(`full` checked) adds macOS and Windows end to end, Node 20 and 24, a real yt-dlp/ffmpeg
install and the Linux packages. The real-media format matrix stays manual too
(**Actions → Nightly matrix**). A release tag (`lib-v*`, `app-v*`) still runs its own
checks before it publishes.
