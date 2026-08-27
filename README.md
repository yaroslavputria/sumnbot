# sumnbot — [@sum_n_bot](https://t.me/sum_n_bot)

A private Telegram bot for group chats. Summarizes conversations, answers questions, sets reminders, and roasts members — all in Ukrainian.

## Commands

| Command | Description |
|---|---|
| `/summary [n]` | Summarize the last N messages (default 50, max 1000) |
| `/ask <question>` | Get a brief, essential answer to any question |
| `/remind <time + text>` | Set a reminder — natural language, e.g. `через 30 хвилин` or `о 18:00` |
| `/roast <username> [n]` | Hardcore roast of a user based on their last N messages (default 50) |
| `/coins` | What is currently on sale at [coins.bank.gov.ua](https://coins.bank.gov.ua/) |
| `/coins_on`, `/coins_off` | Subscribe this chat to coin alerts |
| `/coin_watch <id\|url> [when]` | Watch a coin and alert the moment it becomes buyable, e.g. `/coin_watch 1183 завтра о 10:00` |
| `/coin_unwatch` | Drop this chat's watches |
| `/help` | Show available commands |

## Stack

- [Telegraf](https://telegraf.js.org/) — Telegram bot framework
- [OpenAI](https://platform.openai.com/) — GPT-4o-mini for summaries, Q&A, roasts, and time parsing
- [Redis](https://redis.io/) — stores message history, reminders and coin-monitor state
- Webhook-based in production, long polling for local development

## Coin monitor

Watches the NBU numismatic shop and alerts when a coin actually becomes
buyable — not when it is announced. A coin is usually listed in the catalog
but disabled until its sale opens at 10:00, so `/coin_watch` polls that
product hard around the drop and warns five minutes ahead.

**Disabled by default.** The shop blocks datacenter IPs, so it returns 403 on
Render and on GitHub Actions while working fine from a home connection. Set
`COINS_MONITOR=on` to enable it wherever the shop responds; the coin commands
are hidden from the menu while it is off.

When enabled it also wants an external pinger on `/health` (cron-job.org,
UptimeRobot) to stop Render's free tier sleeping through a drop.

## Environment variables

| Variable | Description |
|---|---|
| `BOT_MODE` | `polling` for local dev, `webhook` (default) for production |
| `COINS_MONITOR` | `on` enables the coin monitor (off by default — see below) |
| `BOT_TOKEN` | Telegram bot token |
| `OPENAI_API_KEY` | OpenAI API key |
| `REDIS_URL` | Redis connection URL |
| `ALLOWED_CHATS` | Comma-separated list of allowed chat IDs |
| `WEBHOOK_DOMAIN` | Public domain for the webhook (webhook mode only) |
| `PORT` | HTTP server port (default 3000, webhook mode only) |

## Running

```bash
npm start
```

Runs in webhook mode and needs a publicly reachable `WEBHOOK_DOMAIN`.

## Local development

Polling mode needs no public URL, so the bot runs entirely on your machine.

**Use a separate bot token.** Telegram allows only one delivery method per token,
and polling deletes the webhook — starting a local instance with the production
token takes the live bot offline until the next deploy. Create a second bot with
[@BotFather](https://t.me/BotFather) for development.

```bash
docker run -d --name sumnbot-redis -p 6379:6379 redis:alpine
cp .env.example .env      # BOT_MODE=polling, dev bot token, test chat ID
npm install
npm run dev
```

`ALLOWED_CHATS` should hold the ID of a private test group that the dev bot is a
member of. Requires Node 20.6+ for `--env-file`.

## Access

This bot is private. To add your chat, contact [@yputria](https://t.me/yputria).
