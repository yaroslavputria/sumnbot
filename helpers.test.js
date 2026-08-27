import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MESSAGE_LENGTH,
  formatMessage,
  isUseful,
  chunkArray,
  splitForTelegram,
  commandArgs,
  replyLong,
  withHealthCheck,
} from './helpers.js'

// Telegram sets the command entity's length to the whole "/cmd" or
// "/cmd@botname" token, which is what these fixtures reproduce
const cmd = text => ({
  message: { text, entities: [{ length: text.split(' ')[0].length }] },
})

test('isUseful rejects commands so they reach their handlers', () => {
  assert.equal(isUseful('/summary 100'), false)
  assert.equal(isUseful('/help'), false)
  assert.equal(isUseful('привіт'), true)
})

test('isUseful rejects empty and missing text', () => {
  assert.equal(isUseful(''), false)
  assert.equal(isUseful(undefined), false)
})

test('formatMessage prefers the username', () => {
  const ctx = { from: { username: 'yputria', first_name: 'Yaroslav' }, message: { text: 'привіт' } }
  assert.equal(formatMessage(ctx), 'yputria: привіт')
})

test('formatMessage falls back to the display name', () => {
  const ctx = { from: { first_name: 'Yaroslav', last_name: 'Putria' }, message: { text: 'ок' } }
  assert.equal(formatMessage(ctx), 'Yaroslav Putria: ок')
})

test('formatMessage tolerates a missing last name', () => {
  const ctx = { from: { first_name: 'Yaroslav' }, message: { text: 'ок' } }
  assert.equal(formatMessage(ctx), 'Yaroslav: ок')
})

test('chunkArray splits on exact and partial boundaries', () => {
  assert.deepEqual(chunkArray([1, 2, 3, 4], 2), [[1, 2], [3, 4]])
  assert.deepEqual(chunkArray([1, 2, 3], 2), [[1, 2], [3]])
  assert.deepEqual(chunkArray([], 50), [])
  assert.deepEqual(chunkArray([1], 50), [[1]])
})

test('commandArgs strips the command, including the @botname form', () => {
  assert.equal(commandArgs(cmd('/ask що таке JWT?')), 'що таке JWT?')
  assert.equal(commandArgs(cmd('/ask@sum_n_bot що таке JWT?')), 'що таке JWT?')
  assert.equal(commandArgs(cmd('/remind')), '')
})

test('commandArgs keeps /summary numeric parsing intact', () => {
  const n = ctx => Math.min(Number(commandArgs(ctx)) || 50, 1000)
  assert.equal(n(cmd('/summary')), 50)
  assert.equal(n(cmd('/summary 100')), 100)
  assert.equal(n(cmd('/summary@sum_n_bot 100')), 100)
  assert.equal(n(cmd('/summary 9999')), 1000)
  assert.equal(n(cmd('/summary abc')), 50)
})

test('splitForTelegram leaves short text alone', () => {
  assert.deepEqual(splitForTelegram('hello'), ['hello'])
  assert.deepEqual(splitForTelegram(''), [])
  assert.equal(splitForTelegram('x'.repeat(MAX_MESSAGE_LENGTH)).length, 1)
})

test('splitForTelegram breaks long bulleted output on line breaks', () => {
  const text = Array.from({ length: 400 }, (_, i) => `- пункт ${i} з якимось текстом`).join('\n')
  const parts = splitForTelegram(text)

  assert.ok(parts.length > 1)
  assert.ok(parts.every(p => p.length <= MAX_MESSAGE_LENGTH))
  assert.equal(parts.join('\n'), text)
})

test('splitForTelegram hard-cuts a single overlong line without losing text', () => {
  const parts = splitForTelegram('y'.repeat(10000))
  assert.equal(parts.length, 3)
  assert.ok(parts.every(p => p.length <= MAX_MESSAGE_LENGTH))
  assert.equal(parts.join(''), 'y'.repeat(10000))
})

test('splitForTelegram terminates on whitespace-only input', () => {
  assert.deepEqual(splitForTelegram('\n'.repeat(9000) + 'tail'), ['tail'])
})

test('replyLong sends one message per part', async () => {
  const sent = []
  const ctx = { reply: async text => sent.push(text) }

  await replyLong(ctx, 'short')
  assert.deepEqual(sent, ['short'])

  await replyLong(ctx, 'z'.repeat(9000))
  assert.equal(sent.length, 4)
  assert.ok(sent.slice(1).every(p => p.length <= MAX_MESSAGE_LENGTH))
})

test('withHealthCheck answers /health without touching the webhook handler', () => {
  let delegated = false
  const handler = withHealthCheck(() => { delegated = true })

  const written = []
  const res = {
    writeHead: (code, headers) => written.push([code, headers]),
    end: body => written.push(body),
  }
  handler({ url: '/health' }, res)

  assert.deepEqual(written, [[200, { 'Content-Type': 'text/plain' }], 'ok'])
  assert.equal(delegated, false)
})

test('withHealthCheck delegates every other path to the webhook handler', () => {
  const seen = []
  const handler = withHealthCheck((req, res) => seen.push([req.url, res]))

  handler({ url: '/telegraf/secret-path' }, 'RES')
  handler({ url: '/' }, 'RES')

  assert.deepEqual(seen, [['/telegraf/secret-path', 'RES'], ['/', 'RES']])
})
