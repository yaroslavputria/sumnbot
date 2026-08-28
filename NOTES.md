# Known issues

Things found while reviewing the codebase that are deliberately not
fixed. Ordered roughly by how likely they are to bite.

## Render's free tier sleeps — reminders fire late

Free Render web services spin down after ~15 minutes without inbound
traffic. The reminder poller is an in-process `setInterval`
(`index.js:377`), so **it does not run while the instance is asleep**.
A reminder due at 03:00 in a quiet chat fires whenever the next message
wakes the service, not at 03:00.

`GET /health` exists for this: point a free external pinger
(cron-job.org, UptimeRobot) at it every 5 minutes and the instance stays
awake, so the poller keeps running. **The endpoint alone does nothing —
the pinger is the part that fixes it**, and it is not set up.

That costs roughly 730 of Render's 750 free instance-hours per month, so
there is no room for a second always-on service on the same account.

## Reminder delivery is at-most-once

The poller claims each member with `zrem` before sending
(`index.js:386`). If the send then fails, that reminder is gone — no
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

## Prompt injection

Stored messages are concatenated raw into the user role at
`index.js:186`, `index.js:203` and `index.js:349` with no delimiting or
escaping. A group member can post text that the summariser or roaster
reads as instructions. Low stakes for a private chat bot, but it is a
real channel.

## Smaller things

- `ALLOWED_CHATS` is parsed once at boot (`index.js:20`) — changing the
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
