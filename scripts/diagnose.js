import { config } from '../src/config.js';

const marketId = process.argv[2];
if (!marketId) {
  console.error('Usage: npm run diagnose <marketId>   (e.g. npm run diagnose 257916)');
  process.exit(1);
}

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
  const json = await res.json();
  return json;
}

function restHeaders() {
  const headers = { Accept: 'application/json' };
  if (config.predictApiKey) headers['x-api-key'] = config.predictApiKey;
  return headers;
}

async function introspectMarket() {
  const q = `query Introspect {
    __type(name: "Market") {
      name
      fields { name type { kind name ofType { kind name } } }
    }
  }`;
  const json = await postGraphQL(q);
  const t = json?.data?.__type;
  if (!t) throw new Error(`Introspection failed: ${JSON.stringify(json)}`);
  const scalars = (t.fields ?? []).filter((f) => {
    const k = f.type?.kind ?? f.type?.ofType?.kind;
    const n = f.type?.name ?? f.type?.ofType?.name;
    return k === 'SCALAR' && (n === 'String' || n === 'ID');
  }).map((f) => f.name);
  return scalars;
}

async function fetchMarketWithFields(id, fields) {
  const sel = ['id', ...fields.filter((f) => f !== 'id')].join('\n    ');
  const q = `query Probe($id: ID!) {
    market(id: $id) {
      ${sel}
    }
  }`;
  const json = await postGraphQL(q, { id: String(id) });
  if (json.errors) {
    // Drop problematic fields and retry with just the safe ones
    const bad = new Set();
    for (const e of json.errors) {
      const m = e.message?.match(/Cannot query field "(\w+)"/);
      if (m) bad.add(m[1]);
    }
    if (!bad.size) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
    return fetchMarketWithFields(id, fields.filter((f) => !bad.has(f)));
  }
  return json.data?.market ?? {};
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
  console.log(`> introspecting Market type at ${config.graphqlUrl}`);
  const fields = await introspectMarket();
  console.log(`  scalar (String|ID) fields: ${fields.join(', ')}`);

  console.log(`\n> fetching market ${marketId}`);
  const market = await fetchMarketWithFields(marketId, fields);
  for (const [k, v] of Object.entries(market)) {
    if (v == null) continue;
    const display = typeof v === 'string' && v.length > 60 ? v.slice(0, 60) + '...' : v;
    console.log(`  ${k} = ${display}`);
  }

  console.log(`\n> probing orderbook endpoints`);
  const wins = [];
  for (const [field, value] of Object.entries(market)) {
    if (value == null || value === '') continue;
    for (const tpl of PATH_TEMPLATES) {
      const r = await probe(tpl, value);
      const tag = r.status === 200 ? 'WIN' : `   `;
      console.log(`  [${tag}] ${r.status}  field=${field}  ${tpl}  -> ${r.url}`);
      if (r.status === 200) wins.push({ field, tpl });
    }
  }

  console.log('');
  if (!wins.length) {
    console.log('No combination returned 200. The market may be resolved/closed,');
    console.log('the API key may lack permission, or the path shape changed.');
    process.exit(2);
  }
  const w = wins[0];
  console.log('Set these env vars in Railway / .env:');
  console.log(`  ORDERBOOK_PATH_TEMPLATE=${w.tpl}`);
  console.log(`  ORDERBOOK_KEY_FIELD=${w.field}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
