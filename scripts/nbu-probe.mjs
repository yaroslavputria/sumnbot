/**
 * Where does the NBU 403 actually come from?
 *
 * Run from every vantage point — this machine, Render, a GitHub Actions step,
 * a UA VPS — and compare. No dependencies:  node scripts/nbu-probe.mjs
 *
 * Separates the hypotheses that look identical from the outside:
 *   country     -> CDN-RequestCountryCode comes back as something other than UA
 *   datacenter  -> browser-shaped headers still 403 (the same ones pass from home)
 *   fingerprint -> bare client 403s but browser-shaped headers 200, same IP
 *   challenge   -> the 403 carries CDN-Challenge, i.e. it is solvable, not a deny
 *
 * Bunny echoes its country decision even on a 403, so one request settles the
 * first question outright.
 *
 * Based on a probe written for the zbirka importer.
 */

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const HONEST = 'sumnbot/0.1 (+https://github.com/yaroslavputria/sumnbot; coin availability monitor)'
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
const LANG = 'uk-UA,uk;q=0.9,en;q=0.8'

// The shop rate-limits: hammering the matrix earns a 429 and muddies the
// results. Space every request out.
const THROTTLE_MS = 3000
const pause = () => new Promise(resolve => setTimeout(resolve, THROTTLE_MS))

const SHOP = 'https://coins.bank.gov.ua/'
const SHOP_CATALOG = 'https://coins.bank.gov.ua/catalog.html'
const SHOP_ROBOTS = 'https://coins.bank.gov.ua/robots.txt'
const NBU_CATALOGUE = 'https://bank.gov.ua/ua/uah/numismatic-products/souvenier-coins'
const NBU_SEARCH = 'https://bank.gov.ua/ua/component/source/searchSouvenierCoinResult'

// What nbu.js actually sends today
const FULL_BROWSER = {
  'User-Agent': CHROME,
  Accept: ACCEPT,
  'Accept-Language': LANG,
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
}

const variants = [
  ['bare (no headers)', {}],
  ['honest bot UA', { 'User-Agent': HONEST }],
  ['honest bot UA + Accept + Lang', { 'User-Agent': HONEST, Accept: ACCEPT, 'Accept-Language': LANG }],
  ['chrome UA only', { 'User-Agent': CHROME }],
  ['chrome UA + Accept + Lang', { 'User-Agent': CHROME, Accept: ACCEPT, 'Accept-Language': LANG }],
  ['full browser set (what nbu.js sends)', FULL_BROWSER],
  ['full browser set + Referer', { ...FULL_BROWSER, Referer: SHOP, 'Sec-Fetch-Site': 'same-origin' }],
]

const targets = [
  ['shop /', SHOP],
  ['shop /catalog.html', SHOP_CATALOG],
  ['shop /robots.txt', SHOP_ROBOTS],
  ['bank.gov.ua catalogue', NBU_CATALOGUE],
]

function describe(res) {
  const h = n => res.headers.get(n)
  return {
    status: res.status,
    country: h('cdn-requestcountrycode') ?? '—',
    server: (h('server') ?? '—').slice(0, 24),
    challenge: h('cdn-challenge') ? 'yes' : '—',
    errorCode: h('errorcode') ?? '—',
    cookie: (h('set-cookie') ?? '').includes('bunny_shield') ? 'shield' : '—',
  }
}

function row(label, r) {
  console.log(
    `${label.padEnd(52)} ${String(r.status).padEnd(4)} country=${String(r.country).padEnd(4)} ` +
    `challenge=${r.challenge.padEnd(4)} err=${String(r.errorCode).padEnd(4)} cookie=${r.cookie.padEnd(7)} via=${r.server}`,
  )
}

console.log('--- where am I ---')
try {
  const info = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(15000) })).json()
  console.log(`ip=${info.ip} country=${info.country} org=${info.org} city=${info.city}`)
} catch (err) {
  console.log(`ipinfo unavailable: ${err.message}`)
}

for (const [targetLabel, url] of targets) {
  console.log(`\n--- ${targetLabel} ---`)

  for (const [variantLabel, headers] of variants) {
    try {
      const res = await fetch(url, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      })
      row(variantLabel, describe(res))
    } catch (err) {
      console.log(`${variantLabel.padEnd(52)} ERR  ${err.message}`)
    }

    await pause()
  }
}

// Honouring the shield's own Set-Cookie and retrying is ordinary client
// behaviour — worth knowing whether it is all the challenge wants
console.log('\n--- cookie jar: request, keep bunny_shield cookie, retry ---')
try {
  const first = await fetch(SHOP_CATALOG, { headers: FULL_BROWSER, redirect: 'manual', signal: AbortSignal.timeout(20000) })
  const setCookie = first.headers.getSetCookie?.() ?? []
  const jar = setCookie.map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ')
  console.log(`first=${first.status} cookies=${jar || 'none'}`)

  if (jar) {
    const second = await fetch(SHOP_CATALOG, {
      headers: { ...FULL_BROWSER, Cookie: jar },
      redirect: 'manual',
      signal: AbortSignal.timeout(20000),
    })
    row('retry with shield cookie', describe(second))
  }
} catch (err) {
  console.log(`cookie jar ERR ${err.message}`)
}

// The AJAX endpoint behind the bank.gov.ua catalogue — different host, different
// front (Cloudflare), and it returns data rather than a page
console.log('\n--- bank.gov.ua POST search endpoint ---')
for (const [label, ua] of [['honest bot UA', HONEST], ['chrome UA', CHROME]]) {
  const body = new URLSearchParams({ search: '', page: '1', perPage: '2', from: '', to: '', code: '' })
  body.append('category[]', 'Coin')

  try {
    const res = await fetch(NBU_SEARCH, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: NBU_CATALOGUE,
      },
      body,
      signal: AbortSignal.timeout(20000),
    })
    const text = await res.text()
    const total = /знайдено\s*<b>\s*(\d+)/.exec(text)
    console.log(`${label.padEnd(52)} ${String(res.status).padEnd(4)} bytes=${text.length} reported=${total ? total[1] : 'n/a'}`)
  } catch (err) {
    console.log(`${label.padEnd(52)} ERR  ${err.message}`)
  }

  await pause()
}
