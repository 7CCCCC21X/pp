import { config } from '../src/config.js';
import { getMarketRewardSummary, getOrderbook } from '../src/predict.js';
import { rewardZoneStatus, midOf, spreadOf } from '../src/format.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run probe <marketId>');
  console.error('  e.g. npm run probe 241373');
  process.exit(1);
}

(async () => {
  console.log(`> resolving market ${arg}`);
  const summary = await getMarketRewardSummary(arg);
  if (!summary.market) {
    console.error('Market not in REST list. Confirm the id (try `npm run rewards` to find ids).');
    process.exit(2);
  }
  const m = summary.market;
  console.log(`  title:       ${m.title ?? m.question ?? '(none)'}`);
  console.log(`  conditionId: ${m.conditionId ?? '(none)'}`);
  console.log(`  status:      ${m.status ?? m.tradingStatus ?? '?'} ${m.isResolved ? '(resolved)' : ''}`);
  console.log(`  PP/h:        ${summary.totalHourlyRate.toFixed(2)}`);
  if (Number.isFinite(m.spreadThreshold)) console.log(`  spreadThr:   ±${(m.spreadThreshold * 100).toFixed(2)}¢ (per-market)`);
  if (Number.isFinite(m.shareThreshold)) console.log(`  shareThr:    ${m.shareThreshold} (per-market)`);
  for (const f of ['endsAt', 'endTime', 'closeTime']) {
    if (m[f]) {
      const ts = typeof m[f] === 'number' ? m[f] : Date.parse(m[f]);
      const remain = (ts - Date.now()) / 3600000;
      console.log(`  ${f}: ${new Date(ts).toISOString()}  (in ${remain.toFixed(1)}h)`);
      break;
    }
  }

  console.log(`\n> fetching orderbook ...`);
  let ob;
  try {
    ob = await getOrderbook(summary.orderbookKey, { contextMarketId: arg, market: m });
  } catch (err) {
    console.error('  FAILED:', err.message);
    process.exit(3);
  }
  console.log(`  url:         ${ob.template.replace('{key}', ob.orderbookKey)}`);
  console.log(`  updated:     ${new Date(ob.updatedAtMs).toISOString()}`);

  console.log('\n  买盘 (top 3):');
  if (!ob.bids.length) console.log('    (空)');
  for (let i = 0; i < ob.bids.length; i++) {
    const b = ob.bids[i];
    console.log(`    买${i + 1}: ${b.price.toFixed(4)} × ${b.size}`);
  }
  console.log('  卖盘 (top 3):');
  if (!ob.asks.length) console.log('    (空)');
  for (let i = 0; i < ob.asks.length; i++) {
    const a = ob.asks[i];
    console.log(`    卖${i + 1}: ${a.price.toFixed(4)} × ${a.size}`);
  }

  const mid = midOf(ob);
  const spread = spreadOf(ob);
  console.log('');
  console.log(`  mid:         ${mid != null ? mid.toFixed(4) : 'n/a'}`);
  console.log(`  spread:      ${spread != null ? `${spread.toFixed(4)} (${(spread * 100).toFixed(2)}¢)` : 'n/a'}`);

  const zone = rewardZoneStatus(ob, m, {
    maxDistance: config.rewardZoneMaxDistance,
    minSize: config.rewardZoneMinSize,
  });
  console.log(`\n  奖励区规则:  离 mid ≤ ±${(zone.maxDistance * 100).toFixed(2)}¢ 且 size ≥ ${zone.minSize}`);
  console.log(`    买侧: ${zone.bidActivated ? '✓ 已激活' : `✗ ${zone.bidReason ?? '未激活'}`}`);
  console.log(`    卖侧: ${zone.askActivated ? '✓ 已激活' : `✗ ${zone.askReason ?? '未激活'}`}`);
  if (!zone.bidActivated || !zone.askActivated) {
    console.log(`  → 这个市场有缺口可以挂单赚 PP`);
  }

  console.log('\n  当前阈值（来自 .env / 默认）:');
  console.log(`    STALE_HOURS=${config.staleHours}  PRICE_EPSILON=${config.priceEpsilon}`);
  console.log(`    MID_JUMP=${config.midJumpThreshold}  MAX_SPREAD=${config.maxSpread}`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
