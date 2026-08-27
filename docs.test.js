import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// CLAUDE.md and NOTES.md cite index.js line numbers. Those rot silently every
// time the file grows — twice already — leaving anchors pointing into prompt
// text. These tests turn that into a test failure instead of stale docs.
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
    [168, 'bot.use('],           // logging middleware
    [174, 'bot.use('],           // whitelist
    [188, "bot.on('text'"],      // persistence
    [192, 'isUseful'],           // the next() that lets commands run
    [446, 'setInterval'],        // reminder poller
    [759, 'setMyCommands'],
  ],
  'NOTES.md': [
    [455, 'zrem'],               // the atomic reminder claim
    [37, 'ALLOWED_CHATS'],       // parsed once at boot
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
