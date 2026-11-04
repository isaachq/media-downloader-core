import {strict as assert} from 'node:assert'
import {describe, it} from 'node:test'
import {
  betweenAttemptsMs,
  note,
  outcomeBucketCount,
  profileFor,
  profileMemorySize,
  sessionOnThisAttempt,
} from '../src/sources/internal/adaptive-retry.js'

const URL = 'https://www.instagram.com/p/C0DE/'

describe('AdaptiveRetry', {concurrency: 1}, () => {
  it('the same url, attempt and clock return the same profile', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const first = profileFor(URL, 1, now)
    assert.deepEqual(profileFor(URL, 1, now), first)
    assert.equal(first.attempt, 1)
    assert.equal(first.routeBias, 0)
    assert.equal(first.locale, 'en-US')
    assert.equal(first.acceptLanguage, 'en-US,en;q=0.9')
    assert.ok(first.presentation.length > 0)
  })

  it('a different attempt is a different profile', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const first = profileFor(URL, 1, now)
    const second = profileFor(URL, 2, now)
    assert.notEqual(first.id, second.id)
    assert.equal(second.routeBias, 1)
    assert.notEqual(second.acceptLanguage, first.acceptLanguage)
    assert.equal(second.locale, 'en-GB')
  })

  it('the host session is only on the fifth try', {timeout: 5_000}, () => {
    assert.equal(sessionOnThisAttempt(4), false)
    assert.equal(sessionOnThisAttempt(5), true)
    assert.equal(sessionOnThisAttempt(1), false)
  })

  it('does not read the clock when the test passes now', {timeout: 5_000}, () => {
    const real = Date.now
    Date.now = () => {
      throw new Error('clock')
    }
    try {
      const profile = profileFor(URL, 3, 1_700_000_000_000)
      assert.equal(profile.attempt, 3)
      assert.equal(profile.routeBias, 2)
    } finally {
      Date.now = real
    }
  })

  it('300 profiles in a row stay inside the cap', {timeout: 5_000}, () => {
    const now = 1_800_000_000_000
    for (let i = 0; i < 300; i++) profileFor(`${URL}?n=${i}`, (i % 5) + 1, now + i)
    assert.ok(profileMemorySize() <= 300, `remembered ${profileMemorySize()}`)
  })

  it('repeated notes do not add buckets without a limit', {timeout: 5_000}, () => {
    const now = 1_700_000_000_000
    const outcomes = ['ok', 'wall', 'rate', 'timeout'] as const
    for (let i = 0; i < 1_000; i++) {
      const profile = profileFor(`${URL}?note=${i % 20}`, (i % 5) + 1, now)
      note(profile, outcomes[i % outcomes.length] ?? 'ok', now + i)
    }
    assert.ok(outcomeBucketCount() <= 6, `buckets ${outcomeBucketCount()}`)
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
