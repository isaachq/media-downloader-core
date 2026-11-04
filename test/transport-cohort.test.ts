import assert from 'node:assert/strict'
import * as http from 'node:http'
import {after, describe, it} from 'node:test'
import {jobRetryWait} from '../src/downloader.js'
import {
  HttpSession,
  navigationFetch,
  releaseTransport,
  staleSocket,
  transportCensus,
  transportFault,
} from '../src/sources/http.js'

after(() => {
  releaseTransport()
})

function listen(onRequest: http.RequestListener): Promise<{server: http.Server; port: number; close: () => void}> {
  const server = http.createServer(onRequest)
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve({
        server,
        port: address.port,
        close: () => {
          server.closeAllConnections()
          server.close()
        },
      })
    })
  })
}

describe('transport cohort', () => {
  it('classifies a dead socket and leaves an abort alone', () => {
    const reset = Object.assign(new Error('socket hang up'), {code: 'ECONNRESET'})
    assert.equal(transportFault(reset), true)
    assert.equal(transportFault(Object.assign(new TypeError('fetch failed'), {cause: reset})), true)
    const abort = new Error('stop')
    abort.name = 'AbortError'
    assert.equal(transportFault(abort), false)
    assert.equal(transportFault(Object.assign(new Error('no'), {code: 'ECONNREFUSED'})), true)
  })

  it('a dead socket retries once at once; a network that is down waits the back-off', () => {
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), {code: 'ECONNRESET'}),
    })
    const hangUp = new Error('socket hang up')
    const down = ['ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN', 'ETIMEDOUT'].map(code =>
      Object.assign(new TypeError('fetch failed'), {cause: Object.assign(new Error(code), {code})}),
    )
    assert.equal(staleSocket(reset), true)
    assert.equal(staleSocket(hangUp), true)
    for (const error of down) {
      assert.equal(transportFault(error), true)
      assert.equal(staleSocket(error), false)
      assert.equal(jobRetryWait(error, 1, 15_000) >= 1_600, true)
    }
    assert.equal(jobRetryWait(reset, 1, 15_000), 0)
    assert.equal(jobRetryWait(hangUp, 1, 15_000), 0)
    // the second dead socket in a row is not a stale one any more: it waits
    assert.equal(jobRetryWait(reset, 2, 15_000) >= 3_200, true)
    assert.equal(jobRetryWait(new Error('HTTP 500'), 1, 15_000) >= 1_600, true)
  })

  it('a success is one request and does not retire the origin', {timeout: 5_000}, async () => {
    let hits = 0
    const site = await listen((_req, res) => {
      hits++
      res.end('ok')
    })
    try {
      const before = transportCensus().generation
      const response = await navigationFetch(`http://127.0.0.1:${site.port}/once`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'ok')
      assert.equal(hits, 1)
      assert.equal(transportCensus().generation, before)
    } finally {
      site.close()
    }
  })

  it('an auth answer is one request and does not retire the origin', {timeout: 5_000}, async () => {
    let hits = 0
    const site = await listen((_req, res) => {
      hits++
      res.writeHead(401).end('no')
    })
    try {
      const before = transportCensus().generation
      const response = await navigationFetch(`http://127.0.0.1:${site.port}/auth`)
      assert.equal(response.status, 401)
      assert.equal(hits, 1)
      assert.equal(transportCensus().generation, before)
    } finally {
      site.close()
    }
  })

  it('a peer that drops the idle socket does not wedge the next read', {timeout: 5_000}, async () => {
    let hits = 0
    const site = await listen((req, res) => {
      hits++
      res.writeHead(200, {Connection: 'keep-alive', 'Content-Length': 2})
      res.end('ok', () => req.socket.destroy())
    })
    try {
      const first = await navigationFetch(`http://127.0.0.1:${site.port}/a`)
      assert.equal(await first.text(), 'ok')
      const second = await navigationFetch(`http://127.0.0.1:${site.port}/b`)
      assert.equal(await second.text(), 'ok')
      assert.equal(hits <= 3, true, `hits ${hits}`)
      assert.equal(hits >= 2, true, `hits ${hits}`)
    } finally {
      site.close()
    }
  })

  it('a streak of resets retires the origin and the next read uses the new cohort', {timeout: 5_000}, async () => {
    releaseTransport()
    let open = false
    let hits = 0
    const site = await listen((req, res) => {
      hits++
      if (!open) {
        req.socket.destroy()
        return
      }
      res.end('up')
    })
    try {
      await assert.rejects(navigationFetch(`http://127.0.0.1:${site.port}/x`))
      await assert.rejects(navigationFetch(`http://127.0.0.1:${site.port}/y`))
      assert.equal(transportCensus().generation >= 1, true)
      const spent = hits
      open = true
      const response = await navigationFetch(`http://127.0.0.1:${site.port}/z`)
      assert.equal(await response.text(), 'up')
      assert.equal(hits - spent, 1)
    } finally {
      site.close()
    }
  })

  it('retiring an origin does not cut a request already on its way', {timeout: 5_000}, async () => {
    releaseTransport()
    const site = await listen((req, res) => {
      if (req.url === '/reset') {
        req.socket.destroy()
        return
      }
      setTimeout(() => res.end('slow ok'), 300)
    })
    try {
      const slow = navigationFetch(`http://127.0.0.1:${site.port}/slow`)
      await new Promise(resolve => setTimeout(resolve, 50))
      await assert.rejects(navigationFetch(`http://127.0.0.1:${site.port}/reset`))
      await assert.rejects(navigationFetch(`http://127.0.0.1:${site.port}/reset`))
      assert.equal(transportCensus().generation, 1)
      const response = await slow
      assert.equal(await response.text(), 'slow ok')
      // the slow answer came on the old pool: it neither retires the new one nor counts against it
      assert.equal(transportCensus().generation, 1)
    } finally {
      site.close()
    }
  })

  it('a failure on a pool already retired does not count against its successor', {timeout: 5_000}, async () => {
    releaseTransport()
    let cut = false
    const site = await listen((req, res) => {
      if (req.url === '/reset') {
        req.socket.destroy()
        return
      }
      // the three slow ones are cut together once the pool was retired under them
      setTimeout(() => (cut ? req.socket.destroy() : res.end('ok')), 300)
    })
    try {
      const slow = [1, 2, 3].map(i =>
        navigationFetch(`http://127.0.0.1:${site.port}/slow${i}`).then(
          () => 'ok',
          () => 'cut',
        ),
      )
      await new Promise(resolve => setTimeout(resolve, 50))
      cut = true
      await assert.rejects(navigationFetch(`http://127.0.0.1:${site.port}/reset`))
      await assert.rejects(navigationFetch(`http://127.0.0.1:${site.port}/reset`))
      assert.equal(transportCensus().generation, 1)
      assert.deepEqual(await Promise.all(slow), ['cut', 'cut', 'cut'])
      // three cuts on the old pool: the new pool was never used, so it is not replaced again
      assert.equal(transportCensus().generation, 1)
    } finally {
      site.close()
    }
  })

  it('the session uses the same cohort and a success stays one request', {timeout: 5_000}, async () => {
    let hits = 0
    const site = await listen((_req, res) => {
      hits++
      res.end('ok')
    })
    try {
      const session = new HttpSession({timeoutMs: 2_000})
      const response = await session.get(`http://127.0.0.1:${site.port}/s`)
      assert.equal(await response.text(), 'ok')
      assert.equal(hits, 1)
    } finally {
      site.close()
    }
  })

  it('origins stay inside a fixed table', {timeout: 8_000}, async () => {
    releaseTransport()
    const servers: Array<{close: () => void}> = []
    try {
      for (let i = 0; i < 70; i++) {
        const site = await listen((_req, res) => res.end('x'))
        servers.push(site)
        const response = await navigationFetch(`http://127.0.0.1:${site.port}/`)
        assert.equal(response.status, 200)
        await response.arrayBuffer()
      }
      assert.equal(transportCensus().origins, 64)
      assert.equal(transportCensus().generation, 0)
    } finally {
      for (const site of servers) site.close()
      releaseTransport()
    }
  })
})
