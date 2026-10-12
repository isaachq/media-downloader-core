import {randomBytes, timingSafeEqual} from 'node:crypto'
import * as http from 'node:http'
import type {AddressInfo} from 'node:net'
import type {PoTokenService} from './attestation.js'

/** Largest request body the plugin sends (a few hundred bytes). */
const MAX_BODY = 16 * 1024
const PATH = '/mdc/pot/v1'

/**
 * The PO token endpoint the yt-dlp plugin asks (`PLUGIN_SOURCE`): loopback
 * only, one random key per broker, answered from a `PoTokenService`. A
 * provider that listened on every interface without a key was a remote code
 * execution hole elsewhere (bgutil, 2026); this one listens on 127.0.0.1,
 * refuses anything without its key (compared in constant time), reads at most
 * 16 KiB and only POSTs to its one path.
 */
export class PoTokenBroker {
  readonly #service: PoTokenService
  readonly #key = randomBytes(32).toString('base64url')
  readonly #server: http.Server
  #url: string | undefined
  #starting: Promise<string> | undefined

  constructor(service: PoTokenService) {
    this.#service = service
    this.#server = http.createServer((req, res) => void this.#handle(req, res))
    this.#server.requestTimeout = 90_000
  }

  /** The environment a yt-dlp process needs to reach this broker (starts it on first use). */
  async env(): Promise<Record<string, string>> {
    this.#starting ??= new Promise<string>((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(0, '127.0.0.1', () => {
        this.#server.off('error', reject)
        this.#url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}${PATH}`
        resolve(this.#url)
      })
    })
    return {MDC_POT_URL: await this.#starting, MDC_POT_KEY: this.#key}
  }

  async close(): Promise<void> {
    if (!this.#starting) return
    this.#server.closeAllConnections()
    await new Promise<void>(resolve => this.#server.close(() => resolve()))
  }

  async #handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: object) => {
      res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'})
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST' || req.url !== PATH) return reply(404, {error: 'not found'})
    if (!this.#authorized(req.headers.authorization)) return reply(401, {error: 'not authorized'})
    let body: unknown
    try {
      body = JSON.parse(await readBody(req))
    } catch {
      return reply(400, {error: 'not a JSON request'})
    }
    const binding = (body as {binding?: unknown})?.binding
    if (typeof binding !== 'string' || binding.length === 0) return reply(400, {error: 'no content binding'})
    const gone = new AbortController()
    res.once('close', () => gone.abort())
    try {
      const {token, expiresAt} = await this.#service.token(binding, gone.signal)
      reply(200, {po_token: padded(token), expires_at: Math.floor(expiresAt / 1000)})
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        reply(503, {error: error instanceof Error ? error.message : String(error)})
    }
  }

  #authorized(header: string | undefined): boolean {
    const given = Buffer.from(header?.startsWith('Bearer ') ? header.slice(7) : '')
    const expected = Buffer.from(this.#key)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

/** Websafe base64 with its padding: yt-dlp decodes a token strictly and refuses one without it. */
export const padded = (token: string): string =>
  token.length % 4 === 0 ? token : token + '='.repeat(4 - (token.length % 4))

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('request too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
