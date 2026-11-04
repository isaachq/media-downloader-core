import assert from 'node:assert/strict'
import * as http from 'node:http'
import {after, describe, it} from 'node:test'
import {HttpSession, navigationFetch, releaseTransport, transportCensus, transportFault} from '../src/sources/http.js'

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
