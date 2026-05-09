# sumnbot

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
| `BOT_TOKEN` | Telegram bot token |
| `OPENAI_API_KEY` | OpenAI API key |
| `REDIS_URL` | Redis connection URL |
| `WEBHOOK_DOMAIN` | Public domain for the webhook |
| `ALLOWED_CHATS` | Comma-separated list of allowed chat IDs |
| `PORT` | HTTP server port (default 3000) |

## Running

```bash
npm start
```

## Access

This bot is private. To add your chat, contact [@yputria](https://t.me/yputria).
