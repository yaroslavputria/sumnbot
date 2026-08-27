// Client for the NBU numismatic shop (coins.bank.gov.ua).
//
// Two facts drive this module:
//   1. The shop sits behind BunnyCDN Shield, which 403s anything that does not
//      look like a browser. There is no JS challenge — a realistic header set
//      is enough. Drop the headers and every request fails.
//   2. /catalog.html lists exactly the products that can be bought right now,
//      while the sitemap holds hundreds. A coin is listed but disabled until
//      its sale starts, so "appears in the catalog" is the availability signal.
//
// Parsing is regex and JSON.parse over the JSON-LD block rather than a DOM
// library, to keep the dependency count at three.

export const BASE_URL = 'https://coins.bank.gov.ua'
export const CATALOG_URL = `${BASE_URL}/catalog.html`
export const HOME_URL = `${BASE_URL}/`

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'uk-UA,uk;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
}

const ENTITIES = {
  '&quot;': '"',
  '&apos;': "'",
  '&#039;': "'",
  '&laquo;': '«',
  '&raquo;': '»',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
}

function decodeEntities(text) {
  return text.replace(/&(?:quot|apos|#039|laquo|raquo|nbsp|amp|lt|gt);/g, m => ENTITIES[m])
}

function clean(text) {
  return decodeEntities(text.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

export function absoluteUrl(href) {
  if (!href) return null
  if (href.startsWith('http')) return href
  return `${BASE_URL}${href.startsWith('/') ? '' : '/'}${href}`
}

// Any slug resolves — /x/p-1183.html 301s to the canonical URL — so a bare
// product id is enough to build a working link
export function productUrl(ref) {
  const raw = String(ref).trim()
  if (raw.startsWith('http')) return raw

  const id = raw.match(/(?:^|\/|p-)(\d+)(?:\.html)?$/)?.[1]
  return id ? `${BASE_URL}/c/p-${id}.html` : null
}

export function productId(ref) {
  return String(ref).match(/p-(\d+)\.html/)?.[1] ?? String(ref).match(/^(\d+)$/)?.[1] ?? null
}

export async function fetchPage(url, { timeoutMs = 15000, retries = 2, backoffMs = 1000, fetchImpl = fetch, sleep } = {}) {
  const wait = sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  let lastError

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await wait(backoffMs * attempt)

    try {
      const res = await fetchImpl(url, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })

      // 403 means the shield rejected us; retrying rarely helps but is cheap
      if (!res.ok) {
        lastError = new Error(`${url} -> HTTP ${res.status}`)
        continue
      }

      return await res.text()
    } catch (err) {
      lastError = err
    }
  }

  throw lastError
}

// Each catalog card is a product__name block holding the link, the display
// name and the price
const CARD_RE =
  /<div class="product__name">\s*<a href="([^"]*p-(\d+)\.html)"[^>]*>([\s\S]*?)<\/a>\s*(?:<span class="new_price">([\s\S]*?)<\/span>)?/g

export function parseCatalog(html) {
  const items = []
  const seen = new Set()

  for (const [, href, id, name, price] of html.matchAll(CARD_RE)) {
    if (seen.has(id)) continue
    seen.add(id)

    items.push({
      id,
      name: clean(name),
      price: price ? clean(price) : null,
      url: absoluteUrl(href),
    })
  }

  return items
}

const LD_RE = /<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g

export function parseProduct(html) {
  for (const [, block] of html.matchAll(LD_RE)) {
    let data
    try {
      data = JSON.parse(block)
    } catch {
      continue
    }

    if (data?.['@type'] !== 'Product') continue

    const availability = data.offers?.availability?.match(/(InStock|OutOfStock)/)?.[1] ?? null

    return {
      name: decodeEntities(data.name ?? ''),
      sku: data.sku ?? null,
      price: data.offers?.price ?? null,
      currency: data.offers?.priceCurrency ?? null,
      url: data.offers?.url ?? null,
      availability,
    }
  }

  return null
}

export function parseAvailability(html) {
  return parseProduct(html)?.availability ?? null
}

// Announcements arrive as homepage banners: clickable blocks carrying a
// location.href, plus the slides of the front slider
const CLICKABLE_RE = /<(?:div|a|section)\b([^>]*location\.href='([^']+)'[^>]*)>/g
const IMG_IN_ATTRS_RE = /url\('([^']+)'\)/

export function parseBanners(html) {
  const banners = []
  const seen = new Set()

  for (const [, attrs, link] of html.matchAll(CLICKABLE_RE)) {
    if (!/class="[^"]*(?:banner|slider|slide)[^"]*"/.test(attrs)) continue

    const url = absoluteUrl(link)
    if (!url || seen.has(url)) continue
    seen.add(url)

    banners.push({ link: url, image: absoluteUrl(attrs.match(IMG_IN_ATTRS_RE)?.[1]) })
  }

  return banners
}
