import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {Coalescer} from '../src/sources/coalesce.js'

/** A read that waits until released, counting how often it ran and whether its signal aborted. */
function gate<V>() {
  let release!: (value: V) => void
  let fail!: (error: unknown) => void
  const state = {runs: 0, aborted: false}
  const read = (signal: AbortSignal) => {
    state.runs++
    signal.addEventListener('abort', () => {
      state.aborted = true
    })
    return new Promise<V>((resolve, reject) => {
      release = resolve
      fail = reject
    })
  }
  return {read, state, release: (v: V) => release(v), fail: (e: unknown) => fail(e)}
}

describe('Coalescer: reads of one thing at the same time, made once', () => {
  it('k callers of one key share one read and all get its result', async () => {
    const reads = new Coalescer<string, number>()
    const g = gate<number>()
    const callers = Array.from({length: 50}, () => reads.run('post', undefined, g.read))
    assert.equal(reads.size, 1)
    g.release(7)
    assert.deepEqual(new Set(await Promise.all(callers)), new Set([7]))
    assert.equal(g.state.runs, 1)
    assert.equal(reads.size, 0, 'nothing kept once read')
  })

  it('different keys read separately; a later call reads again', async () => {
    const reads = new Coalescer<string, string>()
    const a = gate<string>()
    const b = gate<string>()
    const first = reads.run('a', undefined, a.read)
    const second = reads.run('b', undefined, b.read)
    a.release('A')
    b.release('B')
    assert.deepEqual(await Promise.all([first, second]), ['A', 'B'])
    const again = gate<string>()
    const third = reads.run('a', undefined, again.read)
    again.release('A2')
    assert.equal(await third, 'A2')
  })

  it('a caller that gives up leaves alone: the others still get the result', async () => {
    const reads = new Coalescer<string, number>()
    const g = gate<number>()
    const quitter = new AbortController()
    const leaving = reads.run('post', quitter.signal, g.read)
    const staying = reads.run('post', new AbortController().signal, g.read)
    quitter.abort(new Error('stopped'))
    await assert.rejects(leaving, /stopped/)
    assert.equal(g.state.aborted, false, 'the shared read goes on for the one still waiting')
    g.release(3)
    assert.equal(await staying, 3)
  })

  it('the shared read is aborted when every caller has left, and a new call starts afresh', async () => {
    const reads = new Coalescer<string, number>()
    const g = gate<number>()
    const one = new AbortController()
    const two = new AbortController()
    const first = reads.run('post', one.signal, g.read)
    const second = reads.run('post', two.signal, g.read)
    one.abort(new Error('one'))
    two.abort(new Error('two'))
    await assert.rejects(first, /one/)
    await assert.rejects(second, /two/)
    assert.equal(g.state.aborted, true)
    assert.equal(reads.size, 0)
    const fresh = gate<number>()
    const third = reads.run('post', undefined, fresh.read)
    fresh.release(9)
    assert.equal(await third, 9)
    g.release(1) // the abandoned read finishing late changes nothing
  })

  it('a failed read fails every caller once, with no unhandled rejection, and is not kept', async () => {
    const reads = new Coalescer<string, number>()
    const g = gate<number>()
    const callers = [reads.run('post', undefined, g.read), reads.run('post', new AbortController().signal, g.read)]
    g.fail(new Error('gone'))
    for (const caller of callers) await assert.rejects(caller, /gone/)
    assert.equal(reads.size, 0)
  })

  it('an already aborted signal throws before any read', () => {
    const reads = new Coalescer<string, number>()
    const g = gate<number>()
    assert.throws(() => reads.run('post', AbortSignal.abort(new Error('early')), g.read), /early/)
    assert.equal(g.state.runs, 0)
  })
})
