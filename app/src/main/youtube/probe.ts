import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  defaultJsRuntime,
  installPlugin,
  invokeExecutable,
  MediaDownloader,
  PoTokenBroker,
  PoTokenService,
} from 'media-downloader-core'
import {createYouTubeAttestation} from './attestation'

/**
 * A health check of YouTube's attestation, for the watch workflow (and by
 * hand): `MDC_YOUTUBE_PROBE=<report.json>` runs it instead of the app. Three
 * questions, each answered on its own:
 *  1. Can each way still pass the attestation and mint a token? (YouTube
 *     changed its protocol when none can.)
 *  2. Does YouTube accept the token? yt-dlp with only the `mweb` client — which
 *     needs one for its streams — fetches a small format: a refused token is a 403.
 *  3. Does the engine, tokens on, download a video end to end?
 * A connection YouTube bot-checks makes 2–3 inconclusive, not broken.
 */
export const PROBE_VIDEO = 'jNQXAC9IVRw' // "Me at the zoo": public since 2005, 19 s

export type ProbeReport = {
  readonly at: string
  readonly strategies: ReadonlyArray<{
    readonly name: string
    readonly ok: boolean
    readonly ms: number
    readonly tokenLength?: number
    readonly error?: string
  }>
  readonly ytDlp?: {readonly ok: boolean; readonly ms: number; readonly tokenUsed: boolean; readonly detail: string}
  readonly engine?: {readonly ok: boolean; readonly ms: number; readonly detail: string}
  /** healthy · broken (tokens can't be made, or YouTube refuses them) · inconclusive (this connection is bot-checked). */
  readonly verdict: 'healthy' | 'broken' | 'inconclusive'
  readonly ytDlpVersion?: string
}

export async function runProbe(dataDir: string, report: string): Promise<ProbeReport> {
  const attestation = createYouTubeAttestation(() => 'youtube-probe')
  const strategies: Array<ProbeReport['strategies'][number]> = []
  // 1. each way on its own
  for (const strategy of attestation.strategies) {
    const started = Date.now()
    const service = new PoTokenService([strategy], {cooldownMs: 0})
    try {
      const {token} = await service.token(PROBE_VIDEO)
      strategies.push({name: strategy.name, ok: true, ms: Date.now() - started, tokenLength: token.length})
    } catch (error) {
      strategies.push({name: strategy.name, ok: false, ms: Date.now() - started, error: messageOf(error)})
    } finally {
      service.close()
    }
  }
  const engine = new MediaDownloader({
    dataDir,
    validation: 'quick',
    traceLog: false,
    youtube: {attestation: attestation.strategies, tokens: 'always'},
  })
  let ytDlp: ProbeReport['ytDlp']
  let engineResult: ProbeReport['engine']
  let ytDlpVersion: string | undefined
  try {
    const bins = await engine.resolveBinaries()
    ytDlpVersion = bins.ytDlp.version
    if (strategies.some(s => s.ok)) {
      // 2. the token, accepted? one client that needs it, a small format, really fetched
      const service = new PoTokenService(attestation.strategies)
      const broker = new PoTokenBroker(service)
      const started = Date.now()
      try {
        const plugins = await installPlugin(path.join(dataDir, 'yt-dlp-plugins'))
        const out = path.join(dataDir, 'probe-download')
        await fs.rm(out, {recursive: true, force: true})
        // the same JS runtime the engine gives yt-dlp (YouTube's n/sig challenges need one)
        const js = defaultJsRuntime()
        const result = await invokeExecutable(
          bins.ytDlp.exe,
          [
            '-v',
            '--ignore-config',
            '--no-js-runtimes',
            '--js-runtimes',
            `${js.runtime.name}:${js.runtime.path}`,
            '--no-plugin-dirs',
            '--plugin-dirs',
            plugins,
            '--extractor-args',
            'youtube:player_client=mweb',
            '-f',
            'worstaudio/worst',
            '--paths',
            out,
            '--',
            `https://www.youtube.com/watch?v=${PROBE_VIDEO}`,
          ],
          {env: {...process.env, ...js.env, ...(await broker.env())}, timeoutMs: 180_000},
        )
        const log = `${result.stdout}\n${result.stderr}`
        const files = await fs.readdir(out).catch(() => [] as string[])
        // asked for and accepted: a token yt-dlp refuses is logged, and it goes on without one
        const tokenUsed = /\[pot:mdc\]/.test(log) && !/Invalid PO Token/i.test(log)
        ytDlp = {
          ok: result.code === 0 && files.length > 0 && tokenUsed,
          ms: Date.now() - started,
          tokenUsed,
          detail: lastErrors(log) || `${files.length} file(s)`,
        }
      } finally {
        await broker.close()
        service.close()
      }
      // 3. the engine, tokens on, end to end
      const t0 = Date.now()
      const job = engine.add({
        url: `https://www.youtube.com/watch?v=${PROBE_VIDEO}`,
        profile: {kind: 'audio', container: 'm4a'},
        outDir: path.join(dataDir, 'probe-engine'),
      })
      await engine.whenIdle()
      const done = engine.job(job.id)
      engineResult = {
        ok: done?.status === 'completed',
        ms: Date.now() - t0,
        detail: done?.error
          ? `${done.error.code}${done.error.hint ? `/${done.error.hint}` : ''}: ${done.error.message}`
          : `${done?.status}`,
      }
    }
  } catch (error) {
    ytDlp ??= {ok: false, ms: 0, tokenUsed: false, detail: messageOf(error)}
  } finally {
    await engine.dispose()
    attestation.close()
  }
  const botChecked = /confirm you.?re not a bot|bot-check/i.test(`${ytDlp?.detail ?? ''} ${engineResult?.detail ?? ''}`)
  const verdict: ProbeReport['verdict'] = !strategies.some(s => s.ok)
    ? 'broken'
    : ytDlp?.ok && engineResult?.ok
      ? 'healthy'
      : botChecked
        ? 'inconclusive'
        : /HTTP Error 403/i.test(ytDlp?.detail ?? '')
          ? 'broken'
          : 'inconclusive'
  const result: ProbeReport = {
    at: new Date().toISOString(),
    strategies,
    ...(ytDlp && {ytDlp}),
    ...(engineResult && {engine: engineResult}),
    verdict,
    ...(ytDlpVersion && {ytDlpVersion}),
  }
  await fs.writeFile(report, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** The last ERROR / WARNING lines of a yt-dlp run: what the report needs, not the whole log. */
function lastErrors(log: string): string {
  return log
    .split(/\r?\n/)
    .filter(line => /^(ERROR|WARNING):/.test(line))
    .slice(-4)
    .join(' | ')
    .slice(0, 1200)
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))
