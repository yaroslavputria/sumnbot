import { Telegraf } from 'telegraf'
import OpenAI from 'openai'

const bot = new Telegraf(process.env.BOT_TOKEN)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const messages = []

bot.on('text', (ctx) => {
  const text = ctx.message.text
  const user = ctx.from.username || ctx.from.first_name

  messages.push(`${user}: ${text}`)
  if (messages.length > 200) messages.shift()
})

bot.command('summary', async (ctx) => {
  const n = Number(ctx.message.text.split(' ')[1]) || 20
  const last = messages.slice(-n).join('\n')

  if (!last) return ctx.reply('No messages yet')

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Summarize briefly' },
      { role: 'user', content: last }
    ]
  })

  await ctx.reply(res.choices[0].message.content)
})

bot.launch()

console.log('Bot started')