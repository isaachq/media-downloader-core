import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {MetaClient} from '../src/sources/meta/client.js'

const ORIGIN = 'https://www.facebook.test'

/** A fetch that answers a share link by how it is asked: as a page load, or as the site's session. */
function shareSite(answers: {readonly asPage: string | undefined; readonly withSession: string | undefined}) {
  const calls: Array<'page' | 'session'> = []
  const fetch = async (_input: string, init?: RequestInit) => {
    const page = new Headers(init?.headers).get('sec-fetch-mode') === 'navigate'
    calls.push(page ? 'page' : 'session')
    const location = page ? answers.asPage : answers.withSession
    return new Response('', {status: location ? 302 : 200, headers: location ? {location} : {}})
  }
  const client = new MetaClient({
    site: 'Facebook',
    origin: ORIGIN,
    sessionCookie: 'c_user',
    fetch,
    pacing: {spacingMs: 0, jitterMs: 0},
  })
  return {client, calls}
}

describe('MetaClient.redirectOf: one hop of a share link', () => {
  it('a page load that redirects is the answer: one request', async () => {
    const {client, calls} = shareSite({asPage: '/reel/1158775390014135/?rdid=x', withSession: undefined})
    assert.equal(await client.redirectOf(`${ORIGIN}/share/r/abc/`), `${ORIGIN}/reel/1158775390014135/?rdid=x`)
    assert.deepEqual(calls, ['page'])
  })

  it('no redirect to a page load: the session is asked', async () => {
    const {client, calls} = shareSite({asPage: undefined, withSession: '/reel/2/'})
    assert.equal(await client.redirectOf(`${ORIGIN}/share/r/abc/`), `${ORIGIN}/reel/2/`)
    assert.deepEqual(calls, ['page', 'session'])
  })

  it('a page load sent to the login wall: the session is asked, and its answer wins', async () => {
    const wall = `/login/?next=${encodeURIComponent(`${ORIGIN}/share/r/abc/`)}`
    const {client, calls} = shareSite({asPage: wall, withSession: '/reel/3/'})
    assert.equal(await client.redirectOf(`${ORIGIN}/share/r/abc/`), `${ORIGIN}/reel/3/`)
    assert.deepEqual(calls, ['page', 'session'])
  })

  it('the wall again with the session: the wall is still the answer (its ?next= is read by the caller)', async () => {
    const wall = `/checkpoint/?next=${encodeURIComponent(`${ORIGIN}/reel/4/`)}`
    const {client} = shareSite({asPage: wall, withSession: undefined})
    assert.equal(await client.redirectOf(`${ORIGIN}/share/r/abc/`), `${ORIGIN}${wall}`)
  })
})
