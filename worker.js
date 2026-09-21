// Book Scout price server (Cloudflare Worker, free plan)
// Given an ISBN, returns eBay UK prices for that book.
//
// Sold prices (recommended): add a secret called SOLDCOMPS_KEY (from sold-comps.com).
// Live listing prices (fallback, free): add secrets EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.

const ALLOWED_ORIGIN = 'https://kolatanya.github.io'; // only your site can use this server
const CACHE_HOURS = 24; // the same book scanned again within a day costs no extra lookup

// listings for several books at once are left out, as they would skew the price
const BUNDLE = /\b(bundle|job ?lot|collection|box ?set|set of|x\s?\d+\s?books|\d+\s?books|books?\s?\d+\s?-\s?\d+)\b/i;

const round = n => Math.round(n * 100) / 100;

function summarise(prices, extra) {
  prices.sort((a, b) => a - b);
  if (!prices.length) return { count: 0, ...extra };
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return { count: prices.length, median: round(median), lowest: round(prices[0]), highest: round(prices[prices.length - 1]), ...extra };
}

/* ---------- sold prices via SoldComps ---------- */
// charity shop books are second-hand, so price them on used sales only
const isUsed = i => Number(i.conditionId) >= 2500 || /used|pre-owned|like new|very good|good|acceptable/i.test(i.condition || '');

async function soldPrices(isbn, env) {
  const url = `https://api.sold-comps.com/v1/scrape?keyword=${isbn}&ebaySite=ebay.co.uk&count=40`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + env.SOLDCOMPS_KEY } });
  if (!r.ok) throw new Error('SoldComps error ' + r.status);
  const j = await r.json();
  const price = i => Number(i.totalPrice ?? i.soldPrice);
  const all = (j.items || []).filter(i => i.soldCurrency === 'GBP' && !BUNDLE.test(i.title || '') && isFinite(price(i)) && price(i) > 0);
  const used = all.filter(isUsed);
  const base = used.length >= 3 ? used : all; // too few used sales: fall back to all of them
  const first = all[0] || {};
  return summarise(base.map(price), {
    source: 'sold',
    usedOnly: base === used && used.length > 0,
    sold: all.length,          // every sale of this book, for the "sells fast/slowly" label
    more: !!j.hasNextPage,
    title: first.title || '',
    image: first.thumbnailUrl || '',
  });
}

/* ---------- live listing prices via eBay Browse API ---------- */
let tokenCache = { value: null, expires: 0 };
async function ebayToken(env) {
  if (tokenCache.value && Date.now() < tokenCache.expires) return tokenCache.value;
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + btoa(`${env.EBAY_CLIENT_ID}:${env.EBAY_CLIENT_SECRET}`),
    },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope'),
  });
  if (!r.ok) throw new Error('eBay login failed ' + r.status);
  const j = await r.json();
  tokenCache = { value: j.access_token, expires: Date.now() + (j.expires_in - 300) * 1000 };
  return j.access_token;
}
async function livePrices(isbn, env) {
  const token = await ebayToken(env);
  const filter = encodeURIComponent('buyingOptions:{FIXED_PRICE},deliveryCountry:GB');
  const get = async params => {
    const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}&limit=50&filter=${filter}`, {
      headers: { Authorization: 'Bearer ' + token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
    });
    if (!r.ok) throw new Error('eBay search error ' + r.status);
    return (await r.json()).itemSummaries || [];
  };
  let items = await get('gtin=' + isbn);
  if (!items.length) items = await get('q=' + isbn);
  items = items.filter(i => i.price && i.price.currency === 'GBP' && !BUNDLE.test(i.title || ''));
  const prices = items.map(i => {
    const ship = i.shippingOptions && i.shippingOptions[0] && i.shippingOptions[0].shippingCost;
    return Number(i.price.value) + (ship && ship.currency === 'GBP' ? Number(ship.value) : 0);
  });
  const first = items[0] || {};
  return summarise(prices, { source: 'live', title: first.title || '', image: (first.image && first.image.imageUrl) || '' });
}

/* ---------- request handler ---------- */
export default {
  async fetch(request, env, ctx) {
    const cors = { 'Access-Control-Allow-Origin': ALLOWED_ORIGIN, 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': `max-age=${CACHE_HOURS * 3600}` } });
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const isbn = new URL(request.url).searchParams.get('isbn') || '';
    if (!/^\d{13}$/.test(isbn)) return json({ error: 'Send ?isbn= with a 13-digit ISBN' }, 400);

    const cache = caches.default;
    const cacheKey = new Request(`https://book-scout.cache/v2/${isbn}`);
    const cached = await cache.match(cacheKey);
    if (cached) return json(await cached.json());

    try {
      let result;
      if (env.SOLDCOMPS_KEY) result = await soldPrices(isbn, env);
      else if (env.EBAY_CLIENT_ID && env.EBAY_CLIENT_SECRET) result = await livePrices(isbn, env);
      else return json({ error: 'No price source set up. Add the SOLDCOMPS_KEY secret in Cloudflare.' }, 500);

      ctx.waitUntil(cache.put(cacheKey, json(result)));
      return json(result);
    } catch (e) {
      return json({ error: String(e.message || e) }, 502);
    }
  },
};
