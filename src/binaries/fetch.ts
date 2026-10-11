import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import {Readable, Transform} from 'node:stream'
import * as streams from 'node:stream/promises'
import type {ReadableStream as WebReadableStream} from 'node:stream/web'
import {type Asset, BinaryError, type Fetcher} from './sources.js'

export type TransferProgress = {readonly received: number; readonly total?: number | undefined}

/**
 * Download an asset to `dest`, hashing while writing (one pass, constant
 * memory), and refuse it unless the SHA-256 matches the published one. A
 * rejected or interrupted download never leaves a file behind.
 */
export async function downloadVerified(
  asset: Asset,
  dest: string,
  opts: {
    fetcher?: Fetcher | undefined
    signal?: AbortSignal | undefined
    onProgress?: ((progress: TransferProgress) => void) | undefined
  } = {},
): Promise<void> {
  const fetcher = opts.fetcher ?? fetch
  const response = await fetcher(asset.url, {
    headers: {'User-Agent': 'media-download-core'},
    ...(opts.signal && {signal: opts.signal}),
  })
  if (!response.ok || !response.body)
    throw new BinaryError(`Download of ${asset.name} failed (HTTP ${response.status}).`)

  const total = Number(response.headers.get('content-length')) || undefined
  const hash = createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      opts.onProgress?.({received, total})
      callback(null, chunk)
    },
  })

  // the write stream owns the handle: it is closed when the pipeline ends or fails
  const sink = (await fs.open(dest, 'w')).createWriteStream()
  try {
    await streams.pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      meter,
      sink,
      opts.signal ? {signal: opts.signal} : {},
    )
    const actual = hash.digest('hex')
    if (actual !== asset.sha256) {
      throw new BinaryError(`Checksum mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}.`)
    }
  } catch (error) {
    sink.destroy()
    await fs.rm(dest, {force: true})
    throw error
  }
}
