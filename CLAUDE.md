# CLAUDE.md

Private Telegram bot for group chats — summaries, Q&A, reminders, roasts.
All user-facing output is Ukrainian. See [README.md](README.md) for the
command table; it is not repeated here.

Node ≥20.6, native ESM (`"type": "module"`, top-level `await` in
`index.js` — required, not stylistic). Three runtime deps: telegraf,
openai, ioredis. `helpers.js` holds the pure helpers, `index.js`
everything else.

## Deploy and testing — read this first

- Hosted on **Render, auto-deploying on push to `master`**. There is no
  staging bot. A push is a deploy.
- **Never push unless asked.** Flag anything touching the middleware
  chain, the whitelist, or the reminder poller before it ships.
- Local development is `npm run dev` (`BOT_MODE=polling`), which needs
  no public URL. **It must use a separate dev bot token** — Telegram
  allows one delivery method per token and `bot.launch()` calls
  `deleteWebhook`, so running locally with the production token takes
  the live bot offline until the next deploy.
- `npm run lint` and `npm test` before committing.
- `GET /health` returns 200 for an external keep-alive pinger, so the
  reminder poller does not sleep with the free tier. Everything else is
  handled by the webhook handler — see `withHealthCheck` in `helpers.js`.

## Middleware order is load-bearing

Registration order in `index.js` decides behaviour:

1. logging — `index.js:114`
2. chat whitelist — `index.js:120`
3. text persistence — `index.js:134`

Two subtleties that are easy to break:

- The whitelist replies to `/`-prefixed messages from unknown chats and
  returns **without** `next()` for anything else, so non-allowed chats
  are silently dropped and never stored.
- `bot.on('text')` calls `isUseful(text)`, which returns `false` for
  anything starting with `/`, hitting `return next()` at `index.js:138`.
  **That early return is the only reason the `bot.command(...)` handlers
  registered further down the file are ever reached.** Plain text is
  saved and deliberately does *not* call `next()`. Editing `isUseful` or
  that branch can silently disable every command — `helpers.test.js`
  guards it.

## Redis data model

Implicit — no schema, no migrations. Both shapes are written and read by
hand:

| Key | Type | Shape |
|---|---|---|
| `chat:<chatId>` | LIST | `"username: message text"`. No id, timestamp, or reply threading. Falls back to `"First Last"` when the user has no `@username`. `rpush` + `ltrim -1000..-1` at `index.js:143-144`; read at `index.js:158` (`/summary`, tail N) and `index.js:319` (`/roast`, whole list). |
| `reminders` | ZSET | member `JSON.stringify({chatId, text})`, score = UTC epoch ms. Written at `index.js:292`, polled at `index.js:380`. |

One global reminder set, not partitioned per chat. `MAX_MESSAGES = 1000`
per chat, no TTL, so idle chats keep their last 1000 messages forever.
Anything needing per-message time or identity requires changing this
shape — there is nowhere to put it today.

## Boot

Fail-fast env validation → `process.exit(1)` (`index.js:7-18`).
`WEBHOOK_DOMAIN` is required only in webhook mode. No dotenv: `--env-file`
locally, Render's dashboard in production.

Clients are constructed at import time (`index.js:23-39`), which is why
nothing in `index.js` is importable from a test. `REDIS_URL` is
hand-parsed into host/port/username/password with a `|| 'default'`
username — a Redis ACL fix, not an accident. Don't collapse it back into
passing the URL string.

## Commands

`/summary` `index.js:152` · `/ask` `index.js:220` · `/remind`
`index.js:252` · `/roast` `index.js:308` · `/help` `index.js:364` ·
reminder poller `index.js:377` · `setMyCommands` `index.js:404`.

`setMyCommands` **must be updated whenever a command is added or
renamed** — it drives Telegram's autocomplete menu.

`/summary` is map-reduce: chunk 50 → one call per chunk with
`SYSTEM_PROMPT` → merge with `FINAL_PROMPT` (`index.js:171-208`). The
per-chunk loop is sequential on purpose ("послідовно для стабільності").
`/summary 1000` is 21 sequential OpenAI calls.

## Conventions

- One model, via the `MODEL` constant (`index.js:44`); timezone via
  `TIMEZONE` (`index.js:45`). No temperature, max_tokens, streaming or
  retry config anywhere. `/remind` is the only call using
  `response_format`.
- Prompts are inline Ukrainian template literals (`index.js:48-111`)
  plus inline system strings in `/ask` and `/roast`. Ukrainian profanity
  is deliberately licensed in three of them — keep it.
- No `parse_mode` is ever set. That is what makes unescaped LLM output
  safe to send; adding Markdown would break on unbalanced characters.
- Long replies go through `replyLong`, never `ctx.reply` directly —
  Telegram rejects messages over 4096 chars.
- Ukrainian user-facing strings, English logs and comments, `console.*`
  only.
- Per-command shape: guard args → `try` Redis read with a Ukrainian
  fallback reply → status message → `try` OpenAI → `finally` delete the
  status message with `.catch(() => {})`.
- Style: no semicolons, 2-space indent, single quotes,
  `// --- SECTION ---` banners.

## Direction

Further modularisation is welcome when a change makes it natural.
TypeScript is deferred. Everything must stay on free tiers — Redis
Cloud and Render free, spend goes to OpenAI only.

Known unfixed issues are in [NOTES.md](NOTES.md); read it before
proposing work in those areas.
