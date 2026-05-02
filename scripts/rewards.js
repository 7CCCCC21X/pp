import { getAllMarketsCached, extractHourlyRate, isMarketTradeable } from '../src/predict.js';

const limit = Number(process.argv[2] ?? 1000);
const minRate = Number(process.env.MIN_HOURLY_RATE ?? 0);

(async () => {
  console.log('> fetching all markets via REST /v1/markets ...');
  const t0 = Date.now();
  const all = await getAllMarketsCached();
  console.log(`  got ${all.length} markets in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  const rows = [];
  for (const m of all) {
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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
