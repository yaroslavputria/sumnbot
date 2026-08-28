import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// CLAUDE.md and NOTES.md cite index.js line numbers. They went stale twice
// while the coin monitor was being built — at one point pointing into
// Ukrainian prompt text rather than the code they described. Silently wrong
// docs are worse than none, so drift is a test failure now.
const src = readFileSync(new URL('./index.js', import.meta.url), 'utf8').split(/\r?\n/)
const docs = ['CLAUDE.md', 'NOTES.md'].map(name => [
  name,
  readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'),
])

const refs = docs.flatMap(([name, text]) =>
  [...text.matchAll(/`index\.js:(\d+)(?:-(\d+))?`/g)].map(m => ({
    name,
    ref: m[0],
    start: Number(m[1]),
    end: Number(m[2] ?? m[1]),
  })))

test('the docs actually cite line numbers', () => {
  assert.ok(refs.length > 20, `expected many anchors, found ${refs.length}`)
})

test('every cited line exists and is not blank', () => {
  for (const { name, ref, start, end } of refs) {
    assert.ok(end <= src.length, `${name} ${ref} is past the end of index.js`)
    assert.ok(
      src.slice(start - 1, end).join('').trim(),
      `${name} ${ref} points at blank lines`,
    )
  }
})

// The anchors that carry real meaning — if these drift, the docs mislead
const pinned = {
  'CLAUDE.md': [
    [114, 'bot.use('],          // logging middleware
    [120, 'bot.use('],          // chat whitelist
    [134, "bot.on('text'"],     // text persistence
    [138, 'isUseful'],          // the next() that lets commands run at all
    [377, 'setInterval'],       // reminder poller
    [404, 'setMyCommands'],
  ],
  'NOTES.md': [
    [386, 'zrem'],              // the atomic reminder claim
    [20, 'ALLOWED_CHATS'],      // parsed once at boot
  ],
}

test('anchors that carry meaning point at the right code', () => {
  for (const [name, entries] of Object.entries(pinned)) {
    for (const [line, needle] of entries) {
      const cited = refs.some(r => r.name === name && r.start === line)
      assert.ok(cited, `${name} no longer cites index.js:${line} — update the pin`)
      assert.ok(src[line - 1].includes(needle),
        `${name} cites index.js:${line} for "${needle}" but that line now reads: ${src[line - 1].trim()}`)
    }
  }
})
