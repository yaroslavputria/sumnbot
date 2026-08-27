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

## Middleware order is load-bearing

Registration order in `index.js` decides behaviour:

1. logging — `index.js:153`
2. chat whitelist — `index.js:159`
3. text persistence — `index.js:173`

Two subtleties that are easy to break:

- The whitelist replies to `/`-prefixed messages from unknown chats and
  returns **without** `next()` for anything else, so non-allowed chats
  are silently dropped and never stored.
- `bot.on('text')` calls `isUseful(text)`, which returns `false` for
  anything starting with `/`, hitting `return next()` at `index.js:177`.
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
| `chat:<chatId>` | LIST | `"username: message text"`. No id, timestamp, or reply threading. Falls back to `"First Last"` when the user has no `@username`. `rpush` + `ltrim -1000..-1`; read by `/summary` (tail N) and `/roast` (whole list). |
| `reminders` | ZSET | member `JSON.stringify({chatId, text})`, score = UTC epoch ms. Polled at `index.js:429`. |
| `coins:onsale` | SET | product ids currently in the shop catalog. **Replaced** each sweep, so a coin that sells out and returns is reported again. |
| `coins:banners` | SET | banner links already announced. **Accumulates**, so a banner rotating back into the slider does not re-alert. |
| `coins:subs` | SET | chat ids opted into coin alerts via `/coins_on`. |
| `coins:watch` | ZSET | member `JSON.stringify({url, name, dropAt, chatId})`, score = when the burst window opens (`dropAt - 5min`). |

One global reminder set, not partitioned per chat. `MAX_MESSAGES = 1000`
per chat, no TTL, so idle chats keep their last 1000 messages forever.
Anything needing per-message time or identity requires changing this
shape — there is nowhere to put it today.

The `coins:*` keys are additive; the two message shapes above are
untouched. `diffNew` in `nbu.js` guards the seeding rule both coin sets
depend on: with nothing stored a sweep must report **no** arrivals,
otherwise a fresh deploy announces the whole catalog at once.

## Boot

Fail-fast env validation → `process.exit(1)` (`index.js:18-29`).
`WEBHOOK_DOMAIN` is required only in webhook mode. No dotenv: `--env-file`
locally, Render's dashboard in production.

Clients are constructed at import time (`index.js:34-50`), which is why
nothing in `index.js` is importable from a test. `REDIS_URL` is
hand-parsed into host/port/username/password with a `|| 'default'`
username — a Redis ACL fix, not an accident. Don't collapse it back into
passing the URL string.

## Commands

`/summary` `index.js:191` · `/ask` `index.js:259` · `/remind`
`index.js:320` · `/roast` `index.js:356` · `/help` `index.js:412` ·
`/coin_watch` `index.js:535` · `/coin_unwatch` `index.js:586` ·
`/coins_on` `index.js:605` · `/coins_off` `index.js:610` · `/coins`
`index.js:615`.

Three pollers, all `setInterval`: reminders `index.js:429`, the coin
sweep `index.js:634`, the coin watch `index.js:659`.

`setMyCommands` **must be updated whenever a command is added or
renamed** — it drives Telegram's autocomplete menu.

`/summary` is map-reduce: chunk 50 → one call per chunk with
`SYSTEM_PROMPT` → merge with `FINAL_PROMPT` (`index.js:211-247`). The
per-chunk loop is sequential on purpose ("послідовно для стабільності").
`/summary 1000` is 21 sequential OpenAI calls.

## Coin monitor

Watches [coins.bank.gov.ua](https://coins.bank.gov.ua/) for the moment a
coin actually becomes buyable. `nbu.js` holds the client and parsers;
everything stateful is in `index.js`.

Four things about the shop drive the design, and none are obvious from
the code alone:

- It sits behind **BunnyCDN Shield**, which 403s anything that does not
  look like a browser. There is no JS challenge — the header set in
  `nbu.js` is what makes requests work. Remove it and everything breaks.
- **`/catalog.html` lists exactly the buyable products** (7 at the time
  of writing) while the sitemap holds 359. A coin is listed but disabled
  until its sale opens, so appearing in the catalog *is* the
  availability signal. Per-product state comes from the JSON-LD
  `offers.availability`.
- Any slug resolves: `/x/p-1183.html` 301s to the canonical URL, which
  is why `/coin_watch` accepts a bare id.
- The issue-plan page is a **PDF/JPG image**, so the announced date
  cannot be scraped. `/coin_watch` takes the date from the user instead.

Two clocks, deliberately:

1. **Sweep, every 4 hours** (`index.js:634`) — diffs the catalog and the
   homepage banners. Enough to notice an announcement days ahead.
2. **Burst** (`index.js:659`) — a coin flips to buyable at **10:00** and
   sells out in seconds, so a sweep can never catch it. `/coin_watch`
   arms a window; five minutes before, the chat gets a heads-up, then
   `watchUntilInStock` polls that one product page every 2s.

The heads-up is the part that actually wins — poll interval plus
Telegram delivery puts the "it is live" ping a couple of seconds behind
the flip. Don't tune the burst interval expecting to close that gap.

`/coin_watch` uses `COIN_WATCH_PARSE_PROMPT`, not the reminder one: sales
open at 10:00 and `REMIND_PARSE_PROMPT` defaults a bare date to 09:00,
which would run the window out an hour early.

Keep-alive matters here. The pollers are in-process, so they sleep when
Render's free tier does — see [NOTES.md](NOTES.md).

## Conventions


- One model, via the `MODEL` constant (`index.js:55`); timezone via
  `TIMEZONE` (`index.js:56`). No temperature, max_tokens, streaming or
  retry config anywhere. `/remind` is the only call using
  `response_format`.
- Prompts are inline Ukrainian template literals (`index.js:74-150`)
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
