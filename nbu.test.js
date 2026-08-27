import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  BASE_URL,
  absoluteUrl,
  productUrl,
  productId,
  fetchPage,
  parseCatalog,
  parseProduct,
  parseAvailability,
  parseBanners,
  diffNew,
} from './nbu.js'

// Fixtures are unmodified pages captured from the live shop. They exist so a
// redesign of the site fails loudly here instead of silently in production.
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

const catalog = fixture('catalog.html')
const inStock = fixture('product-instock.html')
const outOfStock = fixture('product-outofstock.html')
const home = fixture('home.html')

test('parseCatalog reads every product on the catalog page', () => {
  const items = parseCatalog(catalog)

  assert.equal(items.length, 7)
  assert.deepEqual(
    items.map(i => i.id).sort(),
    ['1016', '1086', '1126', '1183', '1199', '838', '885'].sort(),
  )
})

test('parseCatalog decodes names and normalises prices', () => {
  const hersones = parseCatalog(catalog).find(i => i.id === '1016')

  assert.equal(hersones.name, '"Херсонес Таврійський" у футлярі')
  assert.equal(hersones.price, '237 061 грн')
  assert.equal(hersones.url, `${BASE_URL}/-hersones-tavrijskij-u-phutljari/p-1016.html`)
})

test('parseCatalog returns absolute urls and no duplicates', () => {
  const items = parseCatalog(catalog)

  assert.ok(items.every(i => i.url.startsWith(`${BASE_URL}/`)))
  assert.equal(new Set(items.map(i => i.id)).size, items.length)
})

test('parseCatalog copes with an empty page', () => {
  assert.deepEqual(parseCatalog(''), [])
  assert.deepEqual(parseCatalog('<html><body>nothing here</body></html>'), [])
})

test('parseAvailability distinguishes a buyable coin from a disabled one', () => {
  assert.equal(parseAvailability(inStock), 'InStock')
  assert.equal(parseAvailability(outOfStock), 'OutOfStock')
})

test('parseAvailability returns null when there is no product data', () => {
  assert.equal(parseAvailability(home), null)
  assert.equal(parseAvailability('<html></html>'), null)
})

test('parseProduct pulls the details needed for an alert', () => {
  const p = parseProduct(inStock)

  assert.equal(p.availability, 'InStock')
  assert.equal(p.sku, 'C84')
  assert.equal(p.price, '72473.00')
  assert.equal(p.currency, 'UAH')
  assert.match(p.name, /Архістратиг Михаїл/)
  assert.equal(p.url, `${BASE_URL}/-arhistratig-mihajil-z-/p-1183.html`)
})

test('parseProduct survives malformed JSON-LD', () => {
  const broken = '<script type="application/ld+json">{not json</script>'
  assert.equal(parseProduct(broken), null)
})

test('parseProduct skips non-Product JSON-LD blocks', () => {
  // the real pages put a BreadcrumbList before the Product block
  assert.ok(inStock.indexOf('BreadcrumbList') < inStock.indexOf('"@type":"Product"'))
  assert.equal(parseProduct(inStock).sku, 'C84')
})

test('parseBanners finds the homepage announcement blocks', () => {
  const banners = parseBanners(home)

  assert.ok(banners.length >= 1)
  assert.ok(banners.some(b => b.link.includes('plan-vipusku-monet')))
  assert.ok(banners.every(b => b.link.startsWith('http')))
})

test('parseBanners ignores clickable elements that are not banners', () => {
  const html = `<div class="product-card" onclick="location.href='/x/p-1.html'"></div>`
  assert.deepEqual(parseBanners(html), [])
})

test('parseBanners captures the background image when present', () => {
  const html =
    `<div class="bank-banner" data-lazy-img="url('https://cdn/x.png')" ` +
    `onclick="location.href='/nova-moneta/p-1200.html'"></div>`

  assert.deepEqual(parseBanners(html), [
    { link: `${BASE_URL}/nova-moneta/p-1200.html`, image: 'https://cdn/x.png' },
  ])
})

test('productUrl accepts a bare id, a p- form and a full url', () => {
  // any slug 301s to the canonical page, so /c/ is a safe placeholder
  assert.equal(productUrl('1183'), `${BASE_URL}/c/p-1183.html`)
  assert.equal(productUrl('p-1183'), `${BASE_URL}/c/p-1183.html`)
  assert.equal(productUrl(`${BASE_URL}/-arhistratig-mihajil-z-/p-1183.html`),
    `${BASE_URL}/-arhistratig-mihajil-z-/p-1183.html`)
  assert.equal(productUrl('not-a-coin'), null)
})

test('productId extracts the id from either form', () => {
  assert.equal(productId(`${BASE_URL}/slug/p-885.html`), '885')
  assert.equal(productId('885'), '885')
  assert.equal(productId('nonsense'), null)
})

test('absoluteUrl leaves absolute links alone and fixes relative ones', () => {
  assert.equal(absoluteUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(absoluteUrl('/a.html'), `${BASE_URL}/a.html`)
  assert.equal(absoluteUrl(null), null)
})

test('fetchPage sends browser headers, or the shield 403s us', async () => {
  let seen
  const fetchImpl = async (url, opts) => {
    seen = opts.headers
    return { ok: true, status: 200, text: async () => 'body' }
  }

  assert.equal(await fetchPage('https://x/', { fetchImpl }), 'body')
  assert.match(seen['User-Agent'], /Mozilla/)
  assert.equal(seen['Sec-Fetch-Mode'], 'navigate')
  assert.match(seen['Accept-Language'], /uk-UA/)
})

test('fetchPage retries then gives up on a persistent 403', async () => {
  let calls = 0
  const fetchImpl = async () => (calls++, { ok: false, status: 403 })

  await assert.rejects(
    fetchPage('https://x/', { fetchImpl, retries: 2, sleep: async () => {} }),
    /HTTP 403/,
  )
  assert.equal(calls, 3)
})

test('fetchPage recovers when a retry succeeds', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls++
    if (calls === 1) throw new Error('socket hang up')
    return { ok: true, status: 200, text: async () => 'ok' }
  }

  assert.equal(await fetchPage('https://x/', { fetchImpl, sleep: async () => {} }), 'ok')
  assert.equal(calls, 2)
})

test('diffNew reports nothing on the very first run', () => {
  const items = parseCatalog(catalog)
  const { seeding, fresh, keys } = diffNew([], items)

  // deploying the feature must not announce all seven existing products
  assert.equal(seeding, true)
  assert.deepEqual(fresh, [])
  assert.equal(keys.length, 7)
})

test('diffNew reports only genuinely new coins', () => {
  const items = parseCatalog(catalog)
  const known = items.map(i => i.id).filter(id => id !== '1199')

  const { seeding, fresh } = diffNew(known, items)

  assert.equal(seeding, false)
  assert.deepEqual(fresh.map(i => i.id), ['1199'])
  assert.match(fresh[0].name, /Господарська юстиція/)
})

test('diffNew is quiet when nothing changed', () => {
  const items = parseCatalog(catalog)
  const { fresh } = diffNew(items.map(i => i.id), items)

  assert.deepEqual(fresh, [])
})

test('diffNew ignores coins that left the catalog', () => {
  const items = parseCatalog(catalog)
  const known = [...items.map(i => i.id), '999999']

  const { fresh, keys } = diffNew(known, items)

  assert.deepEqual(fresh, [])
  assert.ok(!keys.includes('999999'))
})

test('diffNew works on banners keyed by link', () => {
  const banners = parseBanners(home)
  const first = diffNew([], banners, b => b.link)

  // the same seeding guarantee must hold for announcements
  assert.equal(first.seeding, true)
  assert.deepEqual(first.fresh, [])

  const later = diffNew(first.keys, [...banners, { link: 'https://x/new-coin', image: null }], b => b.link)
  assert.deepEqual(later.fresh.map(b => b.link), ['https://x/new-coin'])
})
