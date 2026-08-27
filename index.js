import { Telegraf } from 'telegraf'
import OpenAI from 'openai'
import Redis from 'ioredis'
import http from 'http'
import { formatMessage, isUseful, chunkArray, commandArgs, replyLong, withHealthCheck } from './helpers.js'
import {
  fetchPage,
  parseCatalog,
  parseBanners,
  parseProduct,
  diffNew,
  productUrl,
  watchUntilInStock,
  isBlocked,
  CATALOG_URL,
  HOME_URL,
} from './nbu.js'

// --- ENV VALIDATION ---
const BOT_MODE = process.env.BOT_MODE === 'polling' ? 'polling' : 'webhook'

const requiredEnv = ['BOT_TOKEN', 'OPENAI_API_KEY', 'REDIS_URL', 'ALLOWED_CHATS']
if (BOT_MODE === 'webhook') requiredEnv.push('WEBHOOK_DOMAIN')

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
const MODEL = 'gpt-4o-mini'
const TIMEZONE = 'Europe/Kyiv'

// The shop announces a coin days ahead and only flips it to buyable at 10:00
// on the day, so a slow sweep is enough to spot changes
const COINS_POLL_INTERVAL = 4 * 60 * 60 * 1000
const COINS_ONSALE_KEY = 'coins:onsale'
const COINS_SUBS_KEY = 'coins:subs'
const COINS_BANNERS_KEY = 'coins:banners'
const COINS_WATCH_KEY = 'coins:watch'

// A coin sells out within seconds of going live, so once a drop is close we
// stop sweeping and poll that one product hard.
const COINS_WATCH_POLL_INTERVAL = 30_000
const COINS_BURST_INTERVAL = 2_000
const COINS_BURST_WINDOW = 15 * 60 * 1000
const COINS_PREWARN = 5 * 60 * 1000

// The shop blocks datacenter IPs, so a deployed sweep can fail forever while
// looking exactly like "no new coins". Say so once rather than going quiet.
const COINS_FAILURES_BEFORE_ALERT = 3
let coinSweepFailures = 0
let coinBlockReported = false

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

// Same contract as REMIND_PARSE_PROMPT, but NBU sales open at 10:00, so a
// bare date must not fall back to the reminder default of 09:00
const COIN_WATCH_PARSE_PROMPT = `Ти парсиш дату і час старту продажу монети з українського тексту. Поточна дата і час у Києві будуть вказані в запиті.

Розпізнавай відносні ("через 2 години"), конкретні дати ("15 вересня"), "завтра", "післязавтра", дні тижня.

Якщо час доби НЕ вказано явно — використовуй 10:00, бо продаж монет НБУ стартує о 10:00.
Конвертуй київський час у UTC (влітку UTC+3, взимку UTC+2).

Відповідай ТІЛЬКИ валідним JSON без коментарів:
{"datetime": "2026-09-15T07:00:00.000Z"}
Якщо час незрозумілий: {"error": "час не розпізнано"}`

const REMIND_PARSE_PROMPT = `Ти парсиш час з українського тексту. Поточна дата і час у Києві будуть вказані в запиті.

Розпізнавай будь-які вирази часу, зокрема:
- відносні: "через 10 хвилин", "через 2 години", "через 3 дні", "через тиждень"
- часові мітки сьогодні: "о 18:00", "о 9-й", "о 20ій", "опівночі", "опівдні"
- завтра: "завтра", "завтра о 9", "завтра вранці" (09:00), "завтра ввечері" (20:00)
- післязавтра: "післязавтра", "післязавтра о 15:00"
- дні тижня: "у п'ятницю", "в неділю о 12"
- конкретні дати: "15 травня", "1 червня о 10:00"

Якщо час доби не вказано явно — використовуй 09:00 за замовчуванням.
Конвертуй київський час у UTC (влітку UTC+3, взимку UTC+2).

Відповідай ТІЛЬКИ валідним JSON без коментарів:
{"datetime": "2025-05-09T15:00:00.000Z", "text": "текст нагадування без часової частини"}
Якщо час незрозумілий: {"error": "час не розпізнано"}`

// --- LOGGING ---
bot.use((ctx, next) => {
  console.log(`Update: ${ctx.updateType} from ${ctx.from?.id}`)
  return next()
})

// --- WHITELIST ---
bot.use((ctx, next) => {
  const chatId = String(ctx.chat?.id)
  if (ALLOWED_CHATS.has(chatId)) return next()

  if (ctx.message?.text?.startsWith('/')) {
    return ctx.reply('Цей бот працює тільки для певного списку чатів. Щоб отримати доступ для свого чату — напиши @yputria.')
  }
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
  const chatId = ctx.chat.id
  const n = Math.min(Number(commandArgs(ctx)) || 50, MAX_MESSAGES)

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
        model: MODEL,
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
      model: MODEL,
      messages: [
        { role: 'system', content: FINAL_PROMPT },
        {
          role: 'user',
          content: `Об'єднай ці самарі:\n\n${finalInput}`,
        },
      ],
    })

    const finalSummary = finalRes.choices[0].message.content

    await replyLong(ctx, finalSummary)
  } catch (err) {
    console.error('Failed to generate summary:', err)
    await ctx.reply('Помилка при генерації самарі. Спробуй пізніше.')
  } finally {
    await ctx.telegram.deleteMessage(chatId, statusMsg.message_id).catch(() => {})
  }
})

// --- ASK ---
bot.command('ask', async (ctx) => {
  const question = commandArgs(ctx)
  if (!question) {
    return ctx.reply('Вкажи питання після команди. Наприклад: /ask що таке JWT?')
  }

  const statusMsg = await ctx.reply('Думаю...')

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Відповідай коротко і по суті. Лише найголовніше — без вступів, висновків і зайвих слів. ' +
            'Максимум 7 речень або маркований список до 5 пунктів.',
        },
        { role: 'user', content: question },
      ],
    })

    await replyLong(ctx, res.choices[0].message.content)
  } catch (err) {
    console.error('Failed to answer question:', err)
    await ctx.reply('Помилка при генерації відповіді. Спробуй пізніше.')
  } finally {
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {})
  }
})

// --- TIME PARSING ---
function localTime(at) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: TIMEZONE,
    timeStyle: 'short',
    dateStyle: 'short',
  }).format(at)
}

// Shared by /remind and /coin_watch — same call shape, different defaults
async function parseWhen(input, prompt) {
  const kyivNow = new Intl.DateTimeFormat('uk-UA', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date())

  const res = await openai.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Поточний час у Києві: ${kyivNow}\nПовідомлення: ${input}` },
    ],
  })

  return JSON.parse(res.choices[0].message.content)
}

// --- REMIND ---
bot.command('remind', async (ctx) => {
  const input = commandArgs(ctx)

  if (!input) {
    return ctx.reply('Вкажи час і текст. Наприклад: /remind через 30 хвилин випити таблетку')
  }

  let parsed
  try {
    parsed = await parseWhen(input, REMIND_PARSE_PROMPT)
  } catch (err) {
    console.error('Failed to parse reminder time:', err)
    return ctx.reply('Не вдалося розпізнати час. Спробуй ще раз.')
  }

  if (parsed.error) {
    return ctx.reply('Не зрозумів коли нагадати. Спробуй написати точніше, наприклад: "через 20 хвилин" або "о 18:00".')
  }

  const fireAt = new Date(parsed.datetime).getTime()
  if (isNaN(fireAt) || fireAt <= Date.now()) {
    return ctx.reply('Час нагадування вже минув або невалідний. Вкажи майбутній час.')
  }

  const member = JSON.stringify({ chatId: ctx.chat.id, text: parsed.text })
  try {
    await redis.zadd('reminders', fireAt, member)
  } catch (err) {
    console.error('Failed to save reminder:', err)
    return ctx.reply('Помилка при збереженні нагадування. Спробуй пізніше.')
  }

  await ctx.reply(`Нагадаю о ${localTime(new Date(fireAt))}: ${parsed.text}`)
})

// --- ROAST ---
bot.command('roast', async (ctx) => {
  const args = commandArgs(ctx).split(/\s+/)
  const rawUsername = args[0]?.replace(/^@/, '')
  const n = Math.min(Number(args[1]) || 50, MAX_MESSAGES)

  if (!rawUsername) {
    return ctx.reply('Вкажи юзернейм. Наприклад: /roast @username або /roast username 100')
  }

  let allMessages
  try {
    allMessages = await redis.lrange(`chat:${ctx.chat.id}`, 0, -1)
  } catch (err) {
    console.error('Failed to fetch messages for roast:', err)
    return ctx.reply('Помилка при отриманні повідомлень. Спробуй пізніше.')
  }

  const userMessages = allMessages
    .filter(m => m.toLowerCase().startsWith(`${rawUsername.toLowerCase()}: `))
    .slice(-n)

  if (userMessages.length === 0) {
    return ctx.reply(`Не знайшов повідомлень від @${rawUsername} в історії чату.`)
  }

  const statusMsg = await ctx.reply('Готую роаст... 🔥')

  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content:
            'Ти безжальний майстер роасту. На основі повідомлень людини зроби найжорсткіший персональний роаст. ' +
            'Жодної пощади, жодних загальних фраз — тільки конкретика з переписки. ' +
            'Знайди патерни, суперечності, дивні звички, безглузді думки — і рознеси їх вщент. ' +
            'Можна вживати лайку. Роаст має бути смішним і безжальним одночасно.',
        },
        {
          role: 'user',
          content: `Ось ${userMessages.length} повідомлень від ${rawUsername}:\n\n${userMessages.join('\n')}`,
        },
      ],
    })

    await replyLong(ctx, res.choices[0].message.content)
  } catch (err) {
    console.error('Failed to generate roast:', err)
    await ctx.reply('Помилка при генерації роасту. Спробуй пізніше.')
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
    '/remind <час + текст> — нагадування в зазначений час\n' +
    '/roast <username> [n] — безжальний роаст на основі повідомлень юзера\n' +
    '/coins — які монети зараз у продажу на coins.bank.gov.ua\n' +
    '/coins_on, /coins_off — сповіщення коли монета зʼявляється у продажу\n' +
    '/coin_watch <id|посилання> [коли] — стежити за стартом продажу монети\n' +
    '/coin_unwatch — прибрати стеження\n' +
    '/help — показати цей список\n\n' +
    'Цей бот працює тільки для певного списку чатів. Щоб отримати доступ для свого чату — напиши @yputria.'
  )
})

// --- REMINDER POLLER ---
setInterval(async () => {
  try {
    const now = Date.now()
    const due = await redis.zrangebyscore('reminders', 0, now)
    if (!due.length) return

    for (const member of due) {
      // zrem is the atomic claim — only one poller tick can win a member,
      // and members added after the read above are never touched
      const claimed = await redis.zrem('reminders', member)
      if (!claimed) continue

      try {
        const { chatId, text } = JSON.parse(member)
        await bot.telegram.sendMessage(chatId, `🔔 Нагадування: ${text}`)
      } catch (err) {
        console.error('Failed to deliver reminder:', err)
      }
    }
  } catch (err) {
    console.error('Reminder poller error:', err)
  }
}, 30_000)

// --- COIN MONITOR ---

// Returns the coins that appeared since the last sweep. The first run seeds
// the set and reports nothing, otherwise it would announce the whole catalog.
async function refreshCoinsOnSale() {
  const items = parseCatalog(await fetchPage(CATALOG_URL))

  if (!items.length) {
    console.warn('Coin catalog looks empty, skipping this sweep')
    return []
  }

  const known = await redis.smembers(COINS_ONSALE_KEY)
  const { keys, seeding, fresh } = diffNew(known, items)

  // replace rather than accumulate, so a coin selling out and returning
  // later is reported again
  const pipeline = redis.pipeline()
  pipeline.del(COINS_ONSALE_KEY)
  pipeline.sadd(COINS_ONSALE_KEY, keys)
  await pipeline.exec()

  if (seeding) console.log(`Seeded coin catalog with ${keys.length} products`)

  return fresh
}

function formatCoin(coin) {
  return `${coin.name}${coin.price ? ` — ${coin.price}` : ''}\n${coin.url}`
}

// A failing chat must not stop the rest, same reasoning as the reminder poller
async function broadcastToSubscribers(text) {
  const chatIds = await redis.smembers(COINS_SUBS_KEY)

  for (const chatId of chatIds) {
    try {
      await bot.telegram.sendMessage(chatId, text)
    } catch (err) {
      console.error(`Failed to notify chat ${chatId}:`, err)
    }
  }
}

// New homepage banners are how a sale gets announced, days before the coin
// actually becomes buyable
async function findNewBanners() {
  const banners = parseBanners(await fetchPage(HOME_URL))
  if (!banners.length) return []

  const known = await redis.smembers(COINS_BANNERS_KEY)
  const { keys, seeding, fresh } = diffNew(known, banners, b => b.link)

  // accumulate here: a banner rotating out of the slider and back in later
  // is the same announcement and should not alert twice
  await redis.sadd(COINS_BANNERS_KEY, keys)

  if (seeding) console.log(`Seeded banners with ${keys.length} entries`)

  return fresh
}

// Alerts go to everyone subscribed, plus whoever armed the watch even if
// that chat never ran /coins_on
async function notifyWatchers(chatId, text) {
  const targets = new Set(await redis.smembers(COINS_SUBS_KEY))
  if (chatId) targets.add(String(chatId))

  for (const target of targets) {
    try {
      await bot.telegram.sendMessage(target, text)
    } catch (err) {
      console.error(`Failed to notify chat ${target}:`, err)
    }
  }
}

async function armWatch({ url, name, dropAt, chatId }) {
  const member = JSON.stringify({ url, name, dropAt, chatId })
  await redis.zadd(COINS_WATCH_KEY, Math.max(dropAt - COINS_PREWARN, Date.now()), member)
}

bot.command('coin_watch', async (ctx) => {
  const args = commandArgs(ctx)
  const [ref, ...rest] = args.split(/\s+/)
  const url = productUrl(ref)

  if (!url) {
    return ctx.reply('Вкажи монету — посилання або id. Наприклад: /coin_watch 1183 завтра о 10:00')
  }

  const when = rest.join(' ').trim()
  let dropAt = Date.now()

  if (when) {
    let parsed
    try {
      parsed = await parseWhen(when, COIN_WATCH_PARSE_PROMPT)
    } catch (err) {
      console.error('Failed to parse drop time:', err)
      return ctx.reply('Не вдалося розпізнати час. Спробуй ще раз.')
    }

    if (parsed.error) {
      return ctx.reply('Не зрозумів коли стартує продаж. Напиши, наприклад: "15 вересня" або "завтра о 10:00".')
    }

    dropAt = new Date(parsed.datetime).getTime()
    if (isNaN(dropAt)) {
      return ctx.reply('Невалідна дата. Спробуй ще раз.')
    }
  }

  let name = ref
  try {
    name = parseProduct(await fetchPage(url))?.name || ref
  } catch (err) {
    console.error('Failed to look up watched coin:', err)
  }

  try {
    await armWatch({ url, name, dropAt, chatId: ctx.chat.id })
  } catch (err) {
    console.error('Failed to save coin watch:', err)
    return ctx.reply('Помилка при збереженні. Спробуй пізніше.')
  }

  await ctx.reply(
    `Стежу за «${name}».\nСтарт: ${localTime(new Date(dropAt))}\n${url}\n\n` +
    'Попереджу за 5 хвилин і напишу щойно кнопка купівлі стане активною.',
  )
})

bot.command('coin_unwatch', async (ctx) => {
  const chatId = ctx.chat.id
  const members = await redis.zrange(COINS_WATCH_KEY, 0, -1)
  const mine = members.filter(m => {
    try {
      return JSON.parse(m).chatId === chatId
    } catch {
      return false
    }
  })

  if (!mine.length) {
    return ctx.reply('Немає активних стеження за монетами.')
  }

  await redis.zrem(COINS_WATCH_KEY, ...mine)
  await ctx.reply(`Прибрав ${mine.length} стеження.`)
})

bot.command('coins_on', async (ctx) => {
  await redis.sadd(COINS_SUBS_KEY, String(ctx.chat.id))
  await ctx.reply('Підписав цей чат на сповіщення про монети. Вимкнути — /coins_off')
})

bot.command('coins_off', async (ctx) => {
  await redis.srem(COINS_SUBS_KEY, String(ctx.chat.id))
  await ctx.reply('Більше не надсилатиму сповіщення про монети.')
})

bot.command('coins', async (ctx) => {
  const statusMsg = await ctx.reply('Дивлюсь що в продажу...')

  try {
    const items = parseCatalog(await fetchPage(CATALOG_URL))

    if (!items.length) {
      return await ctx.reply('Зараз у продажу нічого немає.')
    }

    await replyLong(ctx, `Зараз у продажу (${items.length}):\n\n${items.map(formatCoin).join('\n\n')}`)
  } catch (err) {
    console.error('Failed to fetch coin catalog:', err)

    await ctx.reply(isBlocked(err)
      ? 'Магазин НБУ блокує запити з сервера (403). Каталог зараз недоступний для бота.'
      : 'Не вдалося отримати каталог. Спробуй пізніше.')
  } finally {
    await ctx.telegram.deleteMessage(ctx.chat.id, statusMsg.message_id).catch(() => {})
  }
})

setInterval(async () => {
  try {
    const fresh = await refreshCoinsOnSale()

    coinSweepFailures = 0
    if (coinBlockReported) {
      coinBlockReported = false
      await broadcastToSubscribers('✅ Доступ до магазину НБУ відновився, стежу далі.')
    }

    for (const coin of fresh) {
      console.log(`Coin went on sale: ${coin.id} ${coin.name}`)
      await broadcastToSubscribers(`🪙 Вже у продажу!\n\n${formatCoin(coin)}`)
    }
  } catch (err) {
    coinSweepFailures++
    console.error(`Coin sweep failed (${coinSweepFailures} in a row):`, err)

    // report once, so a dead monitor cannot masquerade as a quiet one
    if (coinSweepFailures >= COINS_FAILURES_BEFORE_ALERT && !coinBlockReported) {
      coinBlockReported = true
      await broadcastToSubscribers(
        isBlocked(err)
          ? '⚠️ Магазин НБУ блокує запити з сервера (403). Моніторинг монет не працює.'
          : '⚠️ Не вдається отримати каталог монет. Моніторинг монет не працює.',
      )
    }
  }

  try {
    for (const banner of await findNewBanners()) {
      console.log(`New banner: ${banner.link}`)
      await broadcastToSubscribers(`📣 Новий анонс на сайті НБУ:\n${banner.link}`)
    }
  } catch (err) {
    console.error('Banner sweep failed:', err)
  }
}, COINS_POLL_INTERVAL)

// Claim-then-act, same shape as the reminder poller
setInterval(async () => {
  try {
    const due = await redis.zrangebyscore(COINS_WATCH_KEY, 0, Date.now())

    for (const member of due) {
      const claimed = await redis.zrem(COINS_WATCH_KEY, member)
      if (!claimed) continue

      const watch = JSON.parse(member)

      // deliberately not awaited: a burst runs for minutes and must not
      // block the next tick or another coin's window
      runWatch(watch).catch(err => console.error('Coin watch failed:', err))
    }
  } catch (err) {
    console.error('Coin watch poller error:', err)
  }
}, COINS_WATCH_POLL_INTERVAL)

async function runWatch(watch) {
  const { url, name, dropAt, chatId } = watch

  await notifyWatchers(
    chatId,
    `⏰ «${name}» стартує о ${localTime(new Date(dropAt))}.\n${url}\n\n` +
    'Відкрий сторінку зараз — на старті є лише кілька секунд.',
  )

  // arming late still gets a full window rather than an instant give-up
  const deadline = Math.max(dropAt, Date.now()) + COINS_BURST_WINDOW
  const { product, polls, failures } = await watchUntilInStock(url, {
    deadline,
    intervalMs: COINS_BURST_INTERVAL,
  })

  console.log(`Burst watch on ${url}: ${polls} polls, ${failures} failures, ${product ? 'hit' : 'timed out'}`)

  if (product) {
    return notifyWatchers(
      chatId,
      `🔥 «${name}» У ПРОДАЖУ!\n${product.price ? `${product.price} ${product.currency}\n` : ''}${url}`,
    )
  }

  await notifyWatchers(chatId, `Не дочекався старту «${name}». Перевір вручну: ${url}`)
}

// --- START ---
const PORT = Number(process.env.PORT) || 3000

await bot.telegram.setMyCommands([
  { command: 'summary', description: 'Самарі останніх N повідомлень (напр. /summary 100)' },
  { command: 'ask', description: 'Коротка відповідь на питання (напр. /ask що таке JWT?)' },
  { command: 'remind', description: 'Нагадування (напр. /remind о 18:00 стендап)' },
  { command: 'roast', description: 'Роаст юзера за його повідомленнями (напр. /roast @username)' },
  { command: 'coins', description: 'Які монети зараз у продажу на coins.bank.gov.ua' },
  { command: 'coins_on', description: 'Підписати чат на сповіщення про монети' },
  { command: 'coins_off', description: 'Відписати чат від сповіщень про монети' },
  { command: 'coin_watch', description: 'Стежити за монетою (напр. /coin_watch 1183 завтра о 10:00)' },
  { command: 'coin_unwatch', description: 'Прибрати стеження за монетами' },
  { command: 'help', description: 'Список доступних команд' },
])

if (BOT_MODE === 'polling') {
  // launch() resolves only when the bot stops, so it must not be awaited.
  // It also calls deleteWebhook — never run this with the production token.
  bot.launch(() => console.log('Bot is running in polling mode'))
} else {
  const webhookHandler = await bot.createWebhook({ domain: process.env.WEBHOOK_DOMAIN })

  http.createServer(withHealthCheck(webhookHandler)).listen(PORT, () => {
    console.log(`Bot is running in webhook mode on port ${PORT}`)
  })
}

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
