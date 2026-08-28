// Pure helpers, kept separate from index.js so they can be tested without
// booting the bot — index.js constructs its clients at import time.

export const MAX_MESSAGE_LENGTH = 4000

export function formatMessage(ctx) {
  const user =
    ctx.from.username ||
    `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()

  return `${user}: ${ctx.message.text}`
}

// Returning false for commands is what lets them fall through to their
// handlers — see the next() call in the text middleware in index.js
export function isUseful(text) {
  if (!text) return false
  if (text.startsWith('/')) return false
  return true
}

export function chunkArray(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

// Telegram rejects messages over 4096 characters, so long LLM output is
// split on line breaks (falling back to a hard cut for a single long line)
export function splitForTelegram(text, limit = MAX_MESSAGE_LENGTH) {
  const parts = []
  let rest = text

  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const cut = window.lastIndexOf('\n')
    const at = cut > 0 ? cut : limit

    // a run of blank lines can trim down to nothing, and Telegram
    // rejects empty messages — skip those chunks rather than send them
    const part = rest.slice(0, at).trimEnd()
    if (part.length) parts.push(part)

    rest = rest.slice(at).trimStart()
  }

  if (rest.length) parts.push(rest)
  return parts
}

// The command entity carries its own length, which is what makes the
// /cmd@botname form parse correctly in groups
export function commandArgs(ctx) {
  const cmdLength = ctx.message.entities?.[0]?.length ?? 0
  return ctx.message.text.slice(cmdLength).trim()
}

// Render's free tier sleeps after ~15 minutes without traffic, and the
// in-process reminder poller sleeps with it. An external pinger hits /health
// to keep the instance awake so reminders fire on time.
export function withHealthCheck(handler) {
  return (req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      return res.end('ok')
    }

    return handler(req, res)
  }
}

export async function replyLong(ctx, text) {
  for (const part of splitForTelegram(text)) {
    await ctx.reply(part)
  }
}
