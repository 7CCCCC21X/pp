import { htmlEscape } from '../telegram.js';
import { marketLink, formatOrderbookBlock, formatOpportunitySummary } from '../format.js';

// Periodic orderbook snapshot for markets registered via /snapshot.
// Fires on a fixed interval (set per-market in state.snapshots), goes
// to admin DM only (routed in monitor.js via ADMIN_ONLY_KINDS), and
// is exempt from cooldown / priority / quiet gates because the user
// explicitly asked for it.
export async function detectSnapshot(ctx) {
  const { state, slot, orderbook, marketId, totalHourlyRate, alert, zone, now } = ctx;
  const snap = state.snapshots?.[marketId];
  if (!snap || !Number.isFinite(snap.intervalMs) || snap.intervalMs <= 0) return;
  const lastSent = snap.lastSentAt ?? 0;
  if (now - lastSent < snap.intervalMs) return;

  const intervalMin = Math.max(1, Math.round(snap.intervalMs / 60000));
  const msg = [
    `📸 <b>定时快照</b>`,
    `${marketLink(marketId, slot.title, slot.question, slot.slug)}`,
    `<code>#${htmlEscape(marketId)}</code> · 每 ${intervalMin}min`,
    formatOpportunitySummary({ orderbook, zone, totalHourlyRate, endMs: slot.endMs }),
    '',
    formatOrderbookBlock(orderbook, zone),
  ].join('\n');

  if (await alert('snapshot', slot, marketId, msg, { intervalMs: snap.intervalMs })) {
    snap.lastSentAt = now;
  }
}
