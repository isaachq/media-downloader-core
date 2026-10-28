import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {
  ANONYMOUS_ATTEMPTS,
  betweenAttemptsMs,
  SESSION_ATTEMPTS,
  SESSION_EXHAUSTED_SECONDS,
  variantFor,
} from '../src/sources/internal/adaptive-retry.js'

const ROUTES = ['embed', 'web info', 'post page', 'logged-out query', 'app API']
const URL = 'https://www.instagram.com/p/C0DE/'

describe('AdaptiveRetry', () => {
  it('the same url and attempt always return the same variant', {timeout: 5_000}, () => {
    const first = variantFor(URL, 1, ROUTES)
    assert.deepEqual(variantFor(URL, 1, ROUTES), first)
    assert.equal(first.attempt, 1)
    assert.equal(first.headers['Accept-Language'], 'en-US,en;q=0.9')
    assert.deepEqual(first.routeOrder, ROUTES)
  })

  it('a different attempt is a different door order and language', {timeout: 5_000}, () => {
    const second = variantFor(URL, 2, ROUTES)
    const fifth = variantFor(URL, ANONYMOUS_ATTEMPTS, ROUTES)
    assert.notEqual(variantFor(URL, 1, ROUTES).id, second.id)
    assert.equal(second.routeOrder[0], 'web info')
    assert.equal(second.routeOrder[4], 'embed')
    assert.notEqual(second.headers['Accept-Language'], 'en-US,en;q=0.9')
    assert.equal(fifth.attempt, 5)
    assert.equal(fifth.routeOrder[0], 'app API')
    assert.equal(SESSION_ATTEMPTS, 3)
    assert.equal(SESSION_EXHAUSTED_SECONDS, 300)
  })

  it('a thousand calls do not change the variant of the first url', {timeout: 5_000}, () => {
    const first = variantFor(URL, 1, ROUTES)
    for (let i = 0; i < 1_000; i++) variantFor(`${URL}?n=${i}`, (i % ANONYMOUS_ATTEMPTS) + 1, ROUTES)
    assert.deepEqual(variantFor(URL, 1, ROUTES), first)
  })

  it('the pause between tries stays inside 300 and 800 ms', {timeout: 5_000}, () => {
    assert.equal(
      betweenAttemptsMs(() => 0),
      300,
    )
    assert.equal(
      betweenAttemptsMs(() => 0.999999),
      800,
    )
    assert.equal(
      betweenAttemptsMs(() => 0.5),
      550,
    )
  })
})
