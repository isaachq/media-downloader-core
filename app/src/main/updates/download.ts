import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {Readable, Transform} from 'node:stream'
import * as streams from 'node:stream/promises'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'
import {renameRetrying} from 'media-downloader-core'
import type {UpdateAsset} from './feed'

/** No byte for this long: the transfer is stuck. */
const STALL_MS = 60_000

export class UpdateError extends Error {
  override readonly name = 'UpdateError'
}

/**
 * Download an update into `dir`, hashing while it streams (one pass, no
 * re-read). Written to a `.part` file and renamed only once size and SHA-256
 * match what GitHub published — a file on disk under the final name is always
 * a verified one.
 */
export async function downloadUpdate(opts: {
  readonly asset: UpdateAsset
  readonly dir: string
  readonly signal?: AbortSignal | undefined
  readonly fetch?: typeof fetch | undefined
  readonly onProgress?: ((received: number, total: number) => void) | undefined
}): Promise<string> {
  const target = path.join(opts.dir, opts.asset.name)
  if (await isVerified(target, opts.asset.sha256)) return target
  await fs.mkdir(opts.dir, {recursive: true})
  const part = `${target}.part`
  const stall = new AbortController()
  let stallTimer = setTimeout(() => stall.abort(), STALL_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal
  try {
    const response = await (opts.fetch ?? fetch)(opts.asset.url, {redirect: 'follow', signal})
    if (!response.ok || !response.body) throw new UpdateError(`The update download answered HTTP ${response.status}.`)
    const total = Number(response.headers.get('content-length')) || opts.asset.size
    const hash = createHash('sha256')
    let received = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        hash.update(chunk)
        clearTimeout(stallTimer)
        stallTimer = setTimeout(() => stall.abort(), STALL_MS)
        opts.onProgress?.(received, total)
        callback(null, chunk)
      },
    })
    const sink = (await fs.open(part, 'w')).createWriteStream()
    await streams.pipeline(Readable.fromWeb(response.body as WebReadableStream<Uint8Array>), meter, sink, {signal})
    if (opts.asset.size && received !== opts.asset.size) {
      throw new UpdateError(`The update is incomplete: ${received} of ${opts.asset.size} bytes.`)
    }
    const actual = hash.digest('hex')
    if (actual !== opts.asset.sha256) {
      throw new UpdateError('The update does not match the checksum GitHub published — it was not installed.')
    }
    // Defender scans a freshly written installer: on Windows the rename may need a moment
    await renameRetrying(part, target)
    return target
  } catch (error) {
    await fs.rm(part, {force: true})
    if (stall.signal.aborted && !opts.signal?.aborted) throw new UpdateError('The update download stalled.')
    throw error
  } finally {
    clearTimeout(stallTimer)
  }
}

/** A previous download of the same file that still hashes right (no second download). */
async function isVerified(file: string, sha256: string): Promise<boolean> {
  try {
    const hash = createHash('sha256')
    for await (const chunk of (await fs.open(file)).createReadStream()) hash.update(chunk as Buffer)
    return hash.digest('hex') === sha256
  } catch {
    return false
  }
}
