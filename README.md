# sumnbot — [@sum_n_bot](https://t.me/sum_n_bot)

A private Telegram bot for group chats. Summarizes conversations, answers questions, sets reminders, and roasts members — all in Ukrainian.

## Commands

| Command | Description |
|---|---|
| `/summary [n]` | Summarize the last N messages (default 50, max 1000) |
| `/ask <question>` | Get a brief, essential answer to any question |
| `/remind <time + text>` | Set a reminder — natural language, e.g. `через 30 хвилин` or `о 18:00` |
| `/roast <username> [n]` | Hardcore roast of a user based on their last N messages (default 50) |
| `/help` | Show available commands |

## Stack

- [Telegraf](https://telegraf.js.org/) — Telegram bot framework
- [OpenAI](https://platform.openai.com/) — GPT-4o-mini for summaries, Q&A, roasts, and time parsing
- [Redis](https://redis.io/) — stores message history and reminders (sorted set)
- Webhook-based, no polling

## Environment variables

| Variable | Description |
|---|---|
| `BOT_MODE` | `polling` for local dev, `webhook` (default) for production |
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
