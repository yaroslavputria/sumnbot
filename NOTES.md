# Known issues

Things found while reviewing the codebase that are deliberately not
fixed. Ordered roughly by how likely they are to bite.

## Render's free tier sleeps — keep-alive is required, not optional

Free Render web services spin down after ~15 minutes without inbound
traffic. All three pollers are in-process `setInterval`s, so **none of
them run while the instance is asleep**.

`GET /health` exists for this: point a free external pinger
(cron-job.org, UptimeRobot) at it every 5 minutes. **Without that pinger
the coin monitor is worthless** — a 10:00 drop in a quiet overnight chat
is exactly the case the instance will be asleep for, and reminders stay
late too.

This uses roughly 730 of Render's 750 free instance-hours per month, so
there is no room for a second always-on service on the same account.

## Reminder delivery is at-most-once

The poller claims each member with `zrem` before sending
(`index.js:438`). If the send then fails, that reminder is gone — no
retry. This is intentional: the alternative is a retry queue that loops
forever on a permanently blocked chat. Failures are logged.

The same design assumes **exactly one instance**. Two Render replicas
would both poll; the `zrem` claim stops double-delivery, but nothing
else about the app expects to be replicated.

## No rate limiting or spend cap

No per-user throttle, no cooldown, no OpenAI budget cap, no request
timeouts. The `ALLOWED_CHATS` whitelist is the only abuse control, and
`MAX_MESSAGES` / `CHUNK_SIZE` the only cost bounds. Anyone in an allowed
chat can loop `/summary 1000` — 21 model calls each — against the
OpenAI balance.

## The coin monitor is shelved — the shop blocks datacenter IPs

**`COINS_MONITOR` is off by default and the feature does not work in
production.** The shop refuses requests by where they come from, not by
what they send. The same code and headers, measured 2026-08-27:

| Origin | `coins.bank.gov.ua` | `bank.gov.ua` |
|---|---|---|
| Home connection (CDN reports country `UA`) | 200, 68KB | 200 |
| Render | 403 | — |
| GitHub Actions runner (Azure) | 403 | — |
| Other datacenter fetchers | 403 | 403 |

Only `/robots.txt` is exempt from the shield; every path carrying data
403s. So there is no unblocked endpoint to fall back to, and no free
always-on host that the shop accepts.

What was **not** determined: whether the rule is "non-Ukraine" or
"datacenter ASN". Both test vantages were non-UA datacenters, so they
cannot be told apart. A Ukrainian VPS would distinguish them and might
make the feature work outright — untested, and it costs money.

Not done deliberately: routing through a residential proxy to look like
a home connection. That is circumventing an access control the operator
put in place, rather than being a polite client.

The code, fixtures and tests are all kept. Set `COINS_MONITOR=on`
wherever the shop actually answers and the feature runs as built.

## Quiet failure is ambiguous by design

Fetch failures are logged, never pushed to the chat, so a shield change
degrades into silence rather than noise. The sweep does report once
after three consecutive failures and again when access returns, which
covers the common case — but between those, **silence still looks
identical to "no new coins"**. A periodic "monitor alive" heartbeat
would remove the ambiguity and is not implemented.

The fixtures under `fixtures/` pin the markup the shop served in August
2026. If the site is redesigned, `npm test` fails — that is the intended
early warning.

## The drop alert is a few seconds behind, by construction

`watchUntilInStock` polls every 2s and Telegram delivery adds its own
latency, so the "it is live" message lands roughly 2-3s after a coin
becomes buyable. Against a window measured in seconds that may be too
late to win on its own. The five-minute heads-up is the part that
actually helps; the live ping is confirmation.

Polling faster would shrink the gap slightly and be markedly more
aggressive against the shield. Not worth it.

## Prompt injection

Stored messages are concatenated raw into the user role at
`index.js:225`, `index.js:242` and `index.js:397` with no delimiting or
escaping. A group member can post text that the summariser or roaster
reads as instructions. Low stakes for a private chat bot, but it is a
real channel.

## Smaller things

- `ALLOWED_CHATS` is parsed once at boot (`index.js:31`) — changing the
  allowlist needs a restart.
- `/roast` takes a single whitespace-delimited token as the username,
  but users without an `@username` are stored as `"First Last"`, so they
  cannot be targeted.
- `isUseful` no longer filters short or low-signal messages — that moved
  into the prompt — so "ок" and "👍" consume slots in the 1000-message
  window and get sent to the model anyway.
- Redis Cloud free tier is 30MB. Current usage is roughly 100KB per chat
  at the 1000-message cap, with the chat count bounded by the whitelist,
  so there is plenty of headroom. Noted so a future change to the window
  is made knowingly.
- `node_modules/` was committed in the initial commit and removed later.
  The blobs are still in history, so clones are heavier than the file
  tree suggests.
- No CI. `npm run lint` and `npm test` are manual.
