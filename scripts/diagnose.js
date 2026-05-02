import { config } from '../src/config.js';

const input = process.argv[2];
if (!input) {
  console.error('Usage: npm run diagnose <marketId|slug|url>');
  process.exit(1);
}

function parseInput(raw) {
  let s = raw.trim();
  const urlMatch = s.match(/\/market\/([^/?#]+)/);
  if (urlMatch) s = urlMatch[1];
  return { value: s, kind: /^\d+$/.test(s) ? 'id' : 'slug' };
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

function unwrap(t) {
  let cur = t;
  while (cur && (cur.kind === 'NON_NULL' || cur.kind === 'LIST')) cur = cur.ofType;
  return cur;
}

async function introspect(typeName) {
  const q = `query I($n: String!) {
    __type(name: $n) {
      name kind
      fields {
        name
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
      inputFields {
        name
        type { kind name ofType { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }`;
  const json = await postGraphQL(q, { n: typeName });
  return json?.data?.__type ?? null;
}

async function introspectRoot() {
  const q = `query QIntrospect {
    __schema {
      queryType {
        fields {
          name
          type { kind name ofType { kind name ofType { kind name } } }
          args { name type { kind name ofType { kind name } } }
        }
      }
    }
  }`;
  const json = await postGraphQL(q);
  return json?.data?.__schema?.queryType?.fields ?? [];
}

async function marketScalarFields() {
  const t = await introspect('Market');
  if (!t || !t.fields) return [];
  return t.fields
    .filter((f) => {
      const u = unwrap(f.type);
      return u?.kind === 'SCALAR' && (u.name === 'String' || u.name === 'ID');
    })
    .map((f) => f.name);
}

async function findMarketsReturnShape() {
  const root = await introspectRoot();
  const marketsField = root.find((f) => f.name === 'markets');
  if (!marketsField) return null;
  const retName = unwrap(marketsField.type)?.name;
  if (!retName) return null;
  const retType = await introspect(retName);
  if (!retType?.fields) return { typeName: retName, listField: null };
  // Look for the field that contains the list of markets
  for (const f of retType.fields) {
    const u = unwrap(f.type);
    if (!u) continue;
    if (u.name === 'Market') return { typeName: retName, listField: f.name, edges: false };
    // Edge wrapper, e.g. MarketEdge with `node: Market`
    if (u.name && /edge/i.test(u.name)) {
      const edgeType = await introspect(u.name);
      const nodeField = edgeType?.fields?.find((x) => unwrap(x.type)?.name === 'Market');
      if (nodeField) return { typeName: retName, listField: f.name, edges: true, nodeField: nodeField.name };
    }
  }
  return { typeName: retName, listField: null };
}

async function probeREST(template, key) {
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

async function lookupByMarketId(id, fields) {
  const sel = ['id', ...fields.filter((f) => f !== 'id')].join('\n      ');
  const q = `query L($v: ID!) { market(id: $v) { ${sel} } }`;
  const json = await postGraphQL(q, { v: String(id) });
  if (json.errors) return null;
  return json.data?.market ?? null;
}

async function lookupViaMarketsFilter(value, fields, shape) {
  const filterInput = await introspect('MarketFilterInput');
  const paginationInput = await introspect('ForwardPaginationInput');
  const filterFieldNames = (filterInput?.inputFields ?? []).map((f) => f.name);
  const pageFieldNames = (paginationInput?.inputFields ?? []).map((f) => f.name);

  console.log(`  MarketFilterInput fields: ${filterFieldNames.join(', ') || '(none)'}`);
  console.log(`  ForwardPaginationInput fields: ${pageFieldNames.join(', ') || '(none)'}`);

  if (!filterFieldNames.length) return null;

  const limitKey = pageFieldNames.includes('first') ? 'first'
    : pageFieldNames.includes('limit') ? 'limit'
    : pageFieldNames[0];
  const limitClause = limitKey ? `, pagination: { ${limitKey}: 5 }` : '';

  const sel = ['id', ...fields.filter((f) => f !== 'id')].join('\n        ');
  const innerSelection = shape?.edges
    ? `{ ${shape.listField} { ${shape.nodeField} { ${sel} } } }`
    : shape?.listField
    ? `{ ${shape.listField} { ${sel} } }`
    : `{ ${sel} }`;

  // Prefer slug-like filter fields, then id-like, then any string-ish field.
  const slugLike = filterFieldNames.filter((n) => /slug/i.test(n));
  const idLike = filterFieldNames.filter((n) => /^id$|^ids$|marketId/i.test(n));
  const otherText = filterFieldNames.filter((n) => /search|title|name|query|keyword/i.test(n));
  const candidates = [...slugLike, ...idLike, ...otherText];

  for (const key of candidates) {
    // Try as scalar then as list
    for (const valExpr of [JSON.stringify(value), JSON.stringify([value])]) {
      const q = `query L {
        markets(filter: { ${key}: ${valExpr} }${limitClause}) ${innerSelection}
      }`;
      const json = await postGraphQL(q, {});
      if (json.errors) continue;
      const conn = json.data?.markets;
      if (!conn) continue;
      let arr;
      if (shape?.edges) {
        arr = (conn[shape.listField] ?? []).map((e) => e?.[shape.nodeField]);
      } else if (shape?.listField) {
        arr = conn[shape.listField] ?? [];
      } else if (Array.isArray(conn)) {
        arr = conn;
      } else {
        arr = [conn];
      }
      const market = arr.find((m) => m && m.id);
      if (market) {
        return { lookup: `markets(filter: { ${key}: ${valExpr} })`, market };
      }
    }
  }
  return null;
}

(async () => {
  console.log(`> input parsed as ${kind}: ${value}`);
  console.log(`> graphql=${config.graphqlUrl}`);
  console.log(`> rest=${config.restUrl}`);

  console.log('\n> introspecting Market type');
  const fields = await marketScalarFields();
  console.log(`  scalar (String|ID): ${fields.join(', ') || '(none)'}`);

  console.log('\n> introspecting markets() return shape');
  const shape = await findMarketsReturnShape();
  if (shape) {
    console.log(`  ${shape.typeName} -> ${shape.edges ? `${shape.listField}.${shape.nodeField}[]` : (shape.listField ? `${shape.listField}[]` : '(direct)')}`);
  } else {
    console.log('  no markets() root field');
  }

  console.log('\n> looking up the market');
  let result = null;
  if (kind === 'id') {
    const m = await lookupByMarketId(value, fields);
    if (m) result = { lookup: 'market(id: $v)', market: m };
  }
  if (!result) {
    const r = await lookupViaMarketsFilter(value, fields, shape);
    if (r) result = r;
  }

  if (!result) {
    console.error('No GraphQL lookup returned a market.');
    console.error('If you pasted a slug, the GraphQL filter input may use a different key name.');
    console.error('Try a different market or paste a numeric id.');
    process.exit(2);
  }
  console.log(`  using: ${result.lookup}`);
  for (const [k, v] of Object.entries(result.market)) {
    if (v == null) continue;
    const display = typeof v === 'string' && v.length > 70 ? v.slice(0, 70) + '...' : v;
    console.log(`  ${k} = ${display}`);
  }

  console.log('\n> probing orderbook endpoints');
  const wins = [];
  for (const [field, v] of Object.entries(result.market)) {
    if (v == null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    for (const tpl of PATH_TEMPLATES) {
      const r = await probeREST(tpl, v);
      const tag = r.status === 200 ? 'WIN' : '   ';
      console.log(`  [${tag}] ${String(r.status).padEnd(3)}  field=${String(field).padEnd(20)}  ${tpl}`);
      if (r.status === 200) wins.push({ field, tpl });
    }
  }

  console.log('');
  if (!wins.length) {
    console.log('No combination returned 200.');
    console.log('  - This market may have resolved/closed (no live orderbook).');
    console.log('  - The API key may lack permission for the orderbook endpoint.');
    process.exit(2);
  }
  const w = wins[0];
  console.log('Set these in Railway Variables (then redeploy):');
  console.log(`  ORDERBOOK_PATH_TEMPLATE=${w.tpl}`);
  console.log(`  ORDERBOOK_KEY_FIELD=${w.field}`);
  if (result.market.id) {
    console.log(`\nMarket friendly id: ${result.market.id}`);
    console.log(`If you want to monitor this market, set MARKET_IDS=${result.market.id}`);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
