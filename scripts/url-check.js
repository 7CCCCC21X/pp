import { config } from '../src/config.js';
import { fetchJson } from '../src/http.js';
import { getSlugMapCached, getMarketByIdFast } from '../src/predict.js';
import { slugifyMarketTitle } from '../src/format.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run url-check <marketId>');
  console.error('  e.g. npm run url-check 241373');
  process.exit(1);
}

function restHeaders() {
  const h = { Accept: 'application/json' };
  if (config.predictApiKey) h['x-api-key'] = config.predictApiKey;
  return h;
}

async function probeUrl(url) {
  try {
    // Use GET (not HEAD) — predict.fun's edge often blocks HEAD; we abort
    // the body read to keep it cheap.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10_000);
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual', signal: ctrl.signal });
      const finalUrl = res.headers.get('location') || res.url;
      return { status: res.status, location: res.headers.get('location'), finalUrl };
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    return { status: 'ERR', error: err.message };
  }
}

(async () => {
  console.log(`> resolving market ${arg}`);

  // 1. GraphQL view (what discovery sees)
  let market;
  try {
    market = await getMarketByIdFast(arg);
  } catch (err) {
    console.error('  getMarketByIdFast failed:', err.message);
  }
  if (!market) {
    console.error('  market not found via GraphQL — quitting');
    process.exit(2);
  }
  console.log(`  GraphQL fields:`);
  for (const k of ['id', 'conditionId', 'title', 'question', 'status', 'tradingStatus', 'isResolved']) {
    if (market[k] != null) console.log(`    ${k.padEnd(15)} = ${market[k]}`);
  }

  // 2. REST view — categorySlug etc
  console.log(`\n> fetching REST slug map (cached)`);
  let restSlug = null;
  try {
    const map = await getSlugMapCached();
    restSlug = map.get(String(arg)) ?? null;
    console.log(`  cache size: ${map.size} markets`);
    console.log(`  REST slug for #${arg}: ${restSlug ?? '(not in cache — likely past first 100)'}`);
  } catch (err) {
    console.log(`  REST cache failed: ${err.message}`);
  }

  // 3. Probe REST single-market endpoint(s) to see what fields it returns
  console.log(`\n> trying REST single-market lookups`);
  for (const path of [
    `/markets/${encodeURIComponent(arg)}`,
    `/markets?id=${encodeURIComponent(arg)}`,
    market.conditionId ? `/markets/${encodeURIComponent(market.conditionId)}` : null,
  ].filter(Boolean)) {
    const url = `${config.restUrl}${path}`;
    try {
      const json = await fetchJson(url, { headers: restHeaders(), timeoutMs: 8_000, retries: 0 });
      const data = json?.data ?? json;
      const m = Array.isArray(data) ? data[0] : data;
      const slugLike = ['slug', 'marketSlug', 'categorySlug', 'category_slug', 'eventSlug'];
      const found = {};
      for (const k of slugLike) if (m?.[k] != null) found[k] = m[k];
      console.log(`  ${url}`);
      console.log(`    status: 200 · slug fields: ${Object.keys(found).length ? JSON.stringify(found) : '(none)'}`);
      if (m?.title) console.log(`    title=${m.title}`);
    } catch (err) {
      console.log(`  ${url} → ${err.message.split(':')[0]}`);
    }
  }

  // 4. Build candidate URLs
  console.log(`\n> candidate URLs (testing each)`);
  const candidates = [];
  if (restSlug) {
    candidates.push(['REST categorySlug', `https://predict.fun/zh-cn/market/${restSlug}`]);
    candidates.push(['REST categorySlug (no lang)', `https://predict.fun/market/${restSlug}`]);
  }
  if (market.question) {
    const slug = slugifyMarketTitle(market.question);
    candidates.push(['slugify(question)', `https://predict.fun/zh-cn/market/${slug}`]);
  }
  if (market.title) {
    const slug = slugifyMarketTitle(market.title);
    candidates.push(['slugify(title)', `https://predict.fun/zh-cn/market/${slug}`]);
  }
  candidates.push(['id only', `https://predict.fun/zh-cn/market/${encodeURIComponent(arg)}`]);
  if (market.conditionId) {
    candidates.push(['conditionId', `https://predict.fun/zh-cn/market/${encodeURIComponent(market.conditionId)}`]);
  }

  for (const [label, url] of candidates) {
    const r = await probeUrl(url);
    let tag = '   ';
    if (r.status === 200) tag = ' ✓ ';
    else if (r.status === 301 || r.status === 302 || r.status === 307 || r.status === 308) tag = ' → ';
    else if (r.status === 404) tag = ' ✗ ';
    const extra = r.location ? ` → ${r.location}` : (r.error ? ` (${r.error})` : '');
    console.log(`  [${tag}] ${String(r.status).padEnd(3)}  ${label.padEnd(28)}  ${url}${extra}`);
  }

  console.log(`\n> what bot uses now`);
  const { marketLink } = await import('../src/format.js');
  const html = marketLink(arg, market.title, market.question, restSlug);
  const url = html.match(/href="([^"]+)"/)?.[1] ?? '(unknown)';
  console.log(`  ${url}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
