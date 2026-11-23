import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clearSessionCookie,
  createSessionCookie,
  hasValidSession,
  matchesAccessPassword,
} from './auth.ts'

const password = 'boardroom-test-password-2026'

test('accepts the configured password without exposing it in a session cookie', () => {
  assert.equal(matchesAccessPassword(password, password), true)
  assert.equal(matchesAccessPassword('incorrect-password', password), false)

  const cookie = createSessionCookie(password, 1_800_000_000_000)
  assert.equal(cookie.includes(password), false)
  assert.equal(hasValidSession(cookie, password, 1_800_000_000_000), true)
  assert.equal(hasValidSession(cookie, 'different-password', 1_800_000_000_000), false)
})

test('expires old sessions and can clear the browser cookie', () => {
  const cookie = createSessionCookie(password, 1_800_000_000_000)

  assert.equal(hasValidSession(cookie, password, 1_800_700_000_000), false)
  assert.match(clearSessionCookie(), /Max-Age=0/)
})
