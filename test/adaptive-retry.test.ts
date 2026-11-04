import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {
  ANALYZE_ATTEMPTS,
  betweenAttemptsMs,
  describeAttempt,
  note,
  outcomeBucketCount,
  profileFor,
  profileMemorySize,
  sessionOnThisAttempt,
  variantFor,
} from '../src/sources/internal/adaptive-retry.js'

const URL = 'https://www.instagram.com/p/C0DE/'
const ROUTES = ['embed', 'web info', 'post page', 'logged-out query', 'app API']

describe('AdaptiveRetry', {concurrency: 1}, () => {
  it('attempts 1 to 4 keep variantFor and do not build a profile or ask for the host session', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const before = profileMemorySize()
    for (const attempt of [1, 2, 3, 4]) {
      const step = describeAttempt(URL, attempt, ROUTES, now)
      assert.equal(step.kind, 'variant')
      assert.equal(sessionOnThisAttempt(attempt), false)
      if (step.kind !== 'variant') continue
      assert.deepEqual(step.variant, variantFor(URL, attempt, ROUTES))
      assert.equal(step.variant.headers['Accept-Language'] !== undefined, true)
      assert.equal('presentation' in step.variant, false)
    }
    assert.equal(profileMemorySize(), before)
    assert.throws(() => profileFor(URL, 1, now))
    assert.throws(() => profileFor(URL, 4, now))
  })

  it('attempts 5, 6 and 7 each build a different profile and do not ask for the host session', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const ids: string[] = []
    const presentations: string[] = []
    for (const attempt of [5, 6, 7]) {
      const step = describeAttempt(URL, attempt, ROUTES, now)
      assert.equal(step.kind, 'profile')
      assert.equal(sessionOnThisAttempt(attempt), false)
      const profile = profileFor(URL, attempt, now)
      assert.equal(profile.attempt, attempt)
      assert.equal(typeof profile.presentation, 'string')
      assert.ok(profile.presentation.length > 0)
      const language = profile.locale.split('-')[0] ?? ''
      assert.equal(language.length, 2)
      assert.equal(profile.acceptLanguage.startsWith(`${profile.locale},`), true)
      assert.equal(profile.acceptLanguage.includes(language), true)
      ids.push(profile.id)
      presentations.push(profile.presentation)
    }
    assert.equal(new Set(ids).size, 3)
    assert.equal(new Set(presentations).size, 3)
  })

  it('the same url, attempt and clock return the same id and presentation', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const first = profileFor(URL, 5, now)
    const again = profileFor(URL, 5, now)
    assert.equal(again.id, first.id)
    assert.equal(again.presentation, first.presentation)
    assert.ok(first.presentation.length > 0)
    const second = profileFor(URL, 6, now)
    const third = profileFor(URL, 7, now)
    assert.notEqual(second.id, first.id)
    assert.notEqual(third.id, first.id)
    assert.notEqual(third.id, second.id)
    assert.notEqual(second.presentation, first.presentation)
    assert.notEqual(third.presentation, first.presentation)
    assert.notEqual(third.presentation, second.presentation)
  })

  it('attempt 8 is the only one that asks for the host session', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const before = profileMemorySize()
    const step = describeAttempt(URL, ANALYZE_ATTEMPTS, ROUTES, now)
    assert.equal(ANALYZE_ATTEMPTS, 8)
    assert.equal(step.kind, 'session')
    assert.equal(sessionOnThisAttempt(8), true)
    assert.equal(sessionOnThisAttempt(7), false)
    assert.equal(sessionOnThisAttempt(9), false)
    assert.equal(profileMemorySize(), before)
    assert.throws(() => profileFor(URL, 8, now))
  })

  it('does not read the clock when the test passes now', {timeout: 5_000}, () => {
    const real = Date.now
    Date.now = () => {
      throw new Error('clock')
    }
    try {
      const profile = profileFor(URL, 5, 1_700_000_000_000)
      assert.equal(profile.attempt, 5)
    } finally {
      Date.now = real
    }
  })

  it('300 profiles in a row stay inside the cap', {timeout: 5_000}, () => {
    const now = 1_800_000_000_000
    for (let i = 0; i < 300; i++) profileFor(`${URL}?n=${i}`, 5 + (i % 3), now + i)
    assert.ok(profileMemorySize() <= 300, `remembered ${profileMemorySize()}`)
  })

  it('repeated notes do not add buckets without a limit', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const outcomes = ['ok', 'wall', 'rate', 'timeout'] as const
    for (let i = 0; i < 1_000; i++) {
      const profile = profileFor(`${URL}?note=${i % 20}`, 5 + (i % 3), now)
      note(profile, outcomes[i % outcomes.length] ?? 'ok', now + i)
    }
    assert.ok(outcomeBucketCount() <= 6, `buckets ${outcomeBucketCount()}`)
  })

  it('variantFor still returns the source routes, attempt 1 unrotated', {timeout: 5_000}, () => {
    const first = variantFor(URL, 1, ROUTES)
    const second = variantFor(URL, 2, ROUTES)
    assert.deepEqual(variantFor(URL, 1, ROUTES), first)
    assert.deepEqual(first.routeOrder, ROUTES)
    assert.deepEqual(second.routeOrder, ['web info', 'post page', 'logged-out query', 'app API', 'embed'])
    assert.equal(first.headers['Accept-Language'], 'en-US,en;q=0.9')
    assert.equal(second.headers['Accept-Language'], 'en-GB,en;q=0.9')
    assert.notEqual(first.id, second.id)
  })

  it('the pause between refused doors stays inside 300 and 800 ms', {timeout: 5_000}, () => {
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
