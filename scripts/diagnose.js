import { config } from '../src/config.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run diagnose <marketId|slug|url>');
  console.error('  e.g. npm run diagnose 257916');
  console.error('  e.g. npm run diagnose bnb-up-or-down-may-2-2026-2am-et');
  console.error('  e.g. npm run diagnose https://predict.fun/zh-cn/market/<slug>');
  process.exit(1);
}

// Accept full URLs and pull the slug out of /market/<slug>
function parseInput(raw) {
  let s = raw.trim();
  const urlMatch = s.match(/\/market\/([^/?#]+)/);
  if (urlMatch) s = urlMatch[1];
  const isNumeric = /^\d+$/.test(s);
  return { value: s, kind: isNumeric ? 'id' : 'slug' };
}

const { value, kind } = parseInput(input);

const PATH_TEMPLATES = [
  '/markets/{key}/orderbook',
  '/orderbook/{key}',
];

async function postGraphQL(query, variables) {
  const res = await fetch(config.graphqlUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

function restHeaders() {
  const headers = { Accept: 'application/json' };
  if (config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
  return headers;
}

async function introspectRoot() {
  const q = `query QIntrospect {
    __schema {
      queryType {
        fields {
          name
          args { name type { kind name ofType { kind name } } }
        }
      }
    }
  }`;
  const json = await postGraphQL(q);
  return json?.data?.__schema?.queryType?.fields ?? [];
}

async function introspectMarketScalars() {
  const q = `query Introspect {
    __type(name: "Market") {
      fields { name type { kind name ofType { kind name } } }
    }
  }`;
  const json = await postGraphQL(q);
  const fields = json?.data?.__type?.fields ?? [];
  if (!fields.length) throw new Error(`Market introspection failed: ${JSON.stringify(json)}`);
  return fields.filter((f) => {
    const k = f.type?.kind ?? f.type?.ofType?.kind;
    const n = f.type?.name ?? f.type?.ofType?.name;
    return k === 'SCALAR' && (n === 'String' || n === 'ID');
  }).map((f) => f.name);
}

function buildSelection(fields) {
  return ['id', ...fields.filter((f) => f !== 'id')].join('\n      ');
}

async function tryGraphQLLookups(rootFields, kind, value, marketFields) {
  const sel = buildSelection(marketFields);
  const candidates = [];

  // Always try the canonical id lookup
  candidates.push({
    label: 'market(id: $v)',
    query: `query L($v: ID!) { market(id: $v) { ${sel} } }`,
  });

  // From introspection: any root query whose name matches /market/i and takes
  // exactly one argument. Try with our value regardless of whether the arg
  // wants ID/String — try both forms.
  for (const f of rootFields) {
    if (!/market/i.test(f.name)) continue;
    if ((f.args ?? []).length !== 1) continue;
    const argName = f.args[0].name;
    if (f.name === 'market' && argName === 'id') continue; // already covered
    for (const t of ['ID!', 'String!']) {
      candidates.push({
        label: `${f.name}(${argName}: $v) [${t}]`,
        query: `query L($v: ${t}) { ${f.name}(${argName}: $v) { ${sel} } }`,
      });
    }
  }

  // Hardcoded fallbacks in case introspection misses something
  for (const tpl of [
    'query L($v: String!) { marketBySlug(slug: $v) { __SEL__ } }',
    'query L($v: String!) { market(slug: $v) { __SEL__ } }',
  ]) {
    candidates.push({
      label: tpl.replace(/{ __SEL__ }/, '').trim(),
      query: tpl.replace('__SEL__', sel),
    });
  }

  for (const c of candidates) {
    const json = await postGraphQL(c.query, { v: value });
    if (json.errors) {
      // Drop unknown fields and retry once
      const bad = new Set();
      for (const e of json.errors) {
        const m = e.message?.match(/Cannot query field "(\w+)"/);
        if (m) bad.add(m[1]);
      }
      if (bad.size) {
        const fixed = c.query.split('\n').map((line) => {
          const trimmed = line.trim();
          if (bad.has(trimmed)) return null;
          return line;
        }).filter(Boolean).join('\n');
        const retry = await postGraphQL(fixed, { v: value });
        if (!retry.errors) {
          const data = retry.data ?? {};
          const market = data[Object.keys(data)[0]];
          if (market) return { lookup: c.label, market };
        }
      }
      continue;
    }
    const data = json.data ?? {};
    const market = data[Object.keys(data)[0]];
    if (market) return { lookup: c.label, market };
  }
  return null;
}

async function probe(template, key) {
  const path = template.replace('{key}', encodeURIComponent(key));
  const url = `${config.restUrl}${path.startsWith('/') ? path : '/' + path}`;
  try {
    const res = await fetch(url, { headers: restHeaders() });
    let body = '';
    try { body = (await res.text()).slice(0, 200); } catch {}
    return { url, status: res.status, body };
  } catch (err) {
    return { url, status: 'ERR', body: err.message };
  }
}

(async () => {
  console.log(`> input parsed as ${kind}: ${value}`);
  console.log(`> graphql=${config.graphqlUrl}`);
  console.log(`> rest=${config.restUrl}`);

  console.log(`\n> introspecting root Query`);
  const root = await introspectRoot();
  const marketRoots = root.filter((f) => /market/i.test(f.name));
  if (marketRoots.length) {
    for (const c of marketRoots) {
      const argList = (c.args ?? []).map((a) => `${a.name}:${a.type?.name ?? a.type?.ofType?.name ?? '?'}`).join(', ');
      console.log(`  ${c.name}(${argList})`);
    }
  } else {
    console.log('  no market-related root queries');
  }

  console.log(`\n> introspecting Market type fields`);
  const marketFields = await introspectMarketScalars();
  console.log(`  scalar (String|ID): ${marketFields.join(', ')}`);

  console.log(`\n> looking up the market`);
  const result = await tryGraphQLLookups(root, kind, value, marketFields);
  if (!result) {
    console.error('No GraphQL lookup returned a market. Try a different id/slug, or paste a different URL.');
    process.exit(2);
  }
  console.log(`  using: ${result.lookup}`);
  for (const [k, v] of Object.entries(result.market)) {
    if (v == null) continue;
    const display = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : v;
    console.log(`  ${k} = ${display}`);
  }

  console.log(`\n> probing orderbook endpoints (${Object.keys(result.market).length} fields x ${PATH_TEMPLATES.length} paths)`);
  const wins = [];
  for (const [field, v] of Object.entries(result.market)) {
    if (v == null || v === '') continue;
    for (const tpl of PATH_TEMPLATES) {
      const r = await probe(tpl, v);
      const tag = r.status === 200 ? 'WIN' : '   ';
      console.log(`  [${tag}] ${String(r.status).padEnd(3)}  field=${field.padEnd(16)}  ${tpl}  -> ${r.url}`);
      if (r.status === 200) wins.push({ field, tpl });
    }
  }

  console.log('');
  if (!wins.length) {
    console.log('No combination returned 200.');
    console.log('Likely causes:');
    console.log('  - This market resolved/closed (no live orderbook).');
    console.log('  - API key lacks permission for the orderbook endpoint.');
    console.log('  - The REST path shape changed (open an issue if so).');
    process.exit(2);
  }
  const w = wins[0];
  console.log('Set these in Railway Variables (then redeploy):');
  console.log(`  ORDERBOOK_PATH_TEMPLATE=${w.tpl}`);
  console.log(`  ORDERBOOK_KEY_FIELD=${w.field}`);
  if (result.market.id) {
    console.log(`\nIf you want to monitor this market, use the friendly id in MARKET_IDS:`);
    console.log(`  MARKET_IDS=${result.market.id}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
