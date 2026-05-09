import { Telegraf } from 'telegraf'
import OpenAI from 'openai'
import Redis from 'ioredis'
import http from 'http'

// --- ENV VALIDATION ---
const requiredEnv = ['BOT_TOKEN', 'OPENAI_API_KEY', 'REDIS_URL', 'WEBHOOK_DOMAIN', 'ALLOWED_CHATS']
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`)
    process.exit(1)
  }
}

const ALLOWED_CHATS = new Set(process.env.ALLOWED_CHATS.split(',').map(id => id.trim()))

// --- INIT ---
const bot = new Telegraf(process.env.BOT_TOKEN)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

const redisUrl = new URL(process.env.REDIS_URL)
const redis = new Redis({
  host: redisUrl.hostname,
  port: Number(redisUrl.port),
  username: redisUrl.username || 'default',
  password: redisUrl.password,
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
})

// --- CONFIG ---
const MAX_MESSAGES = 1000
const CHUNK_SIZE = 50

// --- PROMPTS (з гумором) ---
const SYSTEM_PROMPT = `
Ти аналізуєш переписку в Telegram і створюєш структуроване самарі з легким гумором.

Зосередься на:
1. Основних темах
2. Рішеннях
3. Питаннях без відповіді
4. Домовленостях / діях

Ігноруй:
- привітання
- жарти без змісту
- короткі реакції (ок, ага, 👍), якщо це не головний меседж

Правила:
- коротко і по суті
- без повторів
- не вигадуй факти
- гумор має бути якісним, іронічним, доречним, дозволений сарказм
- НЕ змінюй зміст заради жарту
- можна вживати українську лайку, без жостких матів

Формат:
- маркований список
- 5-10 пунктів максимум
- кожен пункт: суть + короткий іронічний коментар (за потреби)
`

const FINAL_PROMPT = `
Ти отримуєш кілька часткових самарі переписки.

Завдання:
- об'єднати їх в одне фінальне самарі
- прибрати дублікати
- згрупувати теми

Стиль:
- стислий, структурований
- з якісним гумором, іронією та сарказмом
- але гумор не повинен спотворювати зміст
- можна вживати українську лайку, без жостких матів

Формат:
- маркований список
- 5-10 пунктів
- кожен пункт: суть + короткий дотепний коментар (за потреби)
`

// --- HELPERS ---
function formatMessage(ctx) {
  const user =
    ctx.from.username ||
    `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim()

  return `${user}: ${ctx.message.text}`
}

function isUseful(text) {
  if (!text) return false
  if (text.startsWith('/')) return false
  return true
}

function chunkArray(arr, size) {
  const chunks = []
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size))
  }
  return chunks
}

// --- LOGGING ---
bot.use((ctx, next) => {
  console.log(`Update: ${ctx.updateType} from ${ctx.from?.id}`)
  return next()
})

// --- WHITELIST ---
bot.use((ctx, next) => {
  const chatId = String(ctx.chat?.id)
  if (!ALLOWED_CHATS.has(chatId)) return
  return next()
})

bot.catch((err, ctx) => {
  console.error(`Handler error for ${ctx.updateType}:`, err)
})

// --- SAVE MESSAGES ---
bot.on('text', async (ctx, next) => {
  const chatId = ctx.chat.id
  const text = ctx.message.text

  if (!isUseful(text)) return next()

  try {
    const msg = formatMessage(ctx)
    const pipeline = redis.pipeline()
    pipeline.rpush(`chat:${chatId}`, msg)
    pipeline.ltrim(`chat:${chatId}`, -MAX_MESSAGES, -1)
    await pipeline.exec()
  } catch (err) {
    console.error('Failed to save message:', err)
  }
})

// --- SUMMARY WITH CHUNKING + AGGREGATION ---
bot.command('summary', async (ctx) => {
  console.log('summary command triggered')
  const chatId = ctx.chat.id
  const n = Math.min(Number(ctx.message.text.split(' ')[1]) || 50, MAX_MESSAGES)

  let messages
  try {
    messages = await redis.lrange(`chat:${chatId}`, -n, -1)
  } catch (err) {
    console.error('Failed to fetch messages from Redis:', err)
    return ctx.reply('Помилка при отриманні повідомлень. Спробуй пізніше.')
  }

  if (!messages || messages.length === 0) {
    return ctx.reply('Немає даних для самарі')
  }

  const statusMsg = await ctx.reply('Обробляю...')

  try {
    // 1. Chunking
    const chunks = chunkArray(messages, CHUNK_SIZE)

    // 2. Partial summaries (послідовно для стабільності)
    const partialSummaries = []

    for (const chunk of chunks) {
      const text = chunk.join('\n')

      const res = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Зроби самарі цього фрагменту:\n\n${text}`,
          },
        ],
      })

      partialSummaries.push(res.choices[0].message.content)
    }

    // 3. Final aggregation
    const finalInput = partialSummaries.join('\n\n')

    const finalRes = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: FINAL_PROMPT },
        {
          role: 'user',
          content: `Об'єднай ці самарі:\n\n${finalInput}`,
        },
      ],
    })

    const finalSummary = finalRes.choices[0].message.content

    await ctx.reply(finalSummary)
  } catch (err) {
    console.error('Failed to generate summary:', err)
    await ctx.reply('Помилка при генерації самарі. Спробуй пізніше.')
  } finally {
    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
  }
})

// --- ASK ---
bot.command('ask', async (ctx) => {
  const question = ctx.message.text.replace(/^\/ask\s*/i, '').trim()

  if (!question) {
    return ctx.reply('Вкажи питання після команди. Наприклад: /ask що таке JWT?')
  }

  const statusMsg = await ctx.reply('Думаю...')

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Відповідай коротко і по суті. Лише найголовніше — без вступів, висновків і зайвих слів. ' +
            'Максимум 3-5 речень або маркований список з 3-5 пунктів.',
        },
        { role: 'user', content: question },
      ],
    })

    await ctx.reply(res.choices[0].message.content)
  } catch (err) {
    console.error('Failed to answer question:', err)
    await ctx.reply('Помилка при генерації відповіді. Спробуй пізніше.')
  } finally {
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {})
  }
})

// --- HELP ---
bot.command('help', (ctx) => {
  ctx.reply(
    'Доступні команди:\n' +
    '/summary [n] — самарі останніх N повідомлень (за замовчуванням 50, максимум 1000)\n' +
    '/ask <питання> — коротка відповідь по суті\n' +
    '/help — показати цей список'
  )
})

// --- START ---
const PORT = Number(process.env.PORT) || 3000

await bot.telegram.setMyCommands([
  { command: 'summary', description: 'Самарі останніх N повідомлень (напр. /summary 100)' },
  { command: 'ask', description: 'Коротка відповідь на питання (напр. /ask що таке AWD?)' },
  { command: 'help', description: 'Список доступних команд' },
])

const webhookHandler = await bot.createWebhook({ domain: process.env.WEBHOOK_DOMAIN })

http.createServer(webhookHandler).listen(PORT, () => {
  console.log(`Bot is running on port ${PORT}`)
})

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
