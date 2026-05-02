import { listAllMarkets, extractHourlyRate, isMarketTradeable } from '../src/predict.js';

const limit = Number(process.argv[2] ?? 1000);
const minRate = Number(process.env.MIN_HOURLY_RATE ?? 0);
const maxPages = Number(process.env.MAX_PAGES ?? 100);
const pageSize = Number(process.env.PAGE_SIZE ?? 100);

const start = Date.now();
let allMarkets = [];

// Print whatever we have if the user Ctrl+Cs mid-pagination.
function printResults(reason) {
  console.log(`\n[${reason}] elapsed ${((Date.now() - start) / 1000).toFixed(1)}s, ${allMarkets.length} markets total`);
  const rows = [];
  for (const m of allMarkets) {
    if (!isMarketTradeable(m)) continue;
    const rate = extractHourlyRate(m);
    if (rate <= minRate) continue;
    rows.push({
      id: String(m.id),
      conditionId: m.conditionId ?? '',
      title: m.title ?? m.question ?? '',
      hourlyRate: rate,
    });
  }
  rows.sort((a, b) => b.hourlyRate - a.hourlyRate);
  if (rows.length > limit) rows.length = limit;
  const total = rows.reduce((acc, r) => acc + r.hourlyRate, 0);

  console.log(`Markets with hourlyRate > ${minRate}: ${rows.length}`);
  console.log(`Total hourly PP across these markets: ${total.toFixed(4)} / hour\n`);

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`${pad('marketId', 10)}  ${pad('PP/h', 10)}  title`);
  console.log('-'.repeat(80));
  for (const r of rows) {
    console.log(`${pad(r.id, 10)}  ${pad(r.hourlyRate.toFixed(4), 10)}  ${pad(r.title, 60)}`);
  }

  console.log('\nReady-to-paste env:');
  console.log(`  MARKET_IDS=${rows.map((r) => r.id).join(',')}`);
}

let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  console.log('\n[interrupted] showing partial results...');
  printResults('partial-sigint');
  process.exit(0);
});

(async () => {
  console.log(`> fetching all markets via GraphQL markets(...) — pageSize=${pageSize}, maxPages=${maxPages}`);
  allMarkets = await listAllMarkets({
    pageSize,
    maxPages,
    onProgress: (p) => {
      if (interrupted) return;
      if (p.phase === 'fetching') {
        process.stdout.write(`  page ${p.page}: fetching ... `);
      } else if (p.phase === 'page') {
        const tag = p.hasNext ? '' : ' [last]';
        process.stdout.write(`+${p.newMarkets} new (${p.edges} edges, ${p.total} unique)${tag}\n`);
      } else if (p.phase === 'error') {
        process.stdout.write(`ERROR: ${p.error}\n`);
      }
    },
  });
  printResults('done');
})().catch((err) => {
  console.error(err);
  printResults('error');
  process.exit(1);
});
