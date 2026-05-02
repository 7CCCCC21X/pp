import fs from 'node:fs/promises';
import { config } from '../src/config.js';

const keepDays = Number(process.argv[2] ?? process.env.HISTORY_KEEP_DAYS ?? 14);
if (!Number.isFinite(keepDays) || keepDays <= 0) {
  console.error(`HISTORY_KEEP_DAYS must be > 0 (got ${keepDays})`);
  process.exit(1);
}
const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
const file = config.historyFile;

let text;
try {
  text = await fs.readFile(file, 'utf8');
} catch (err) {
  if (err.code === 'ENOENT') {
    console.log(`no history file at ${file}`);
    process.exit(0);
  }
  throw err;
}

let total = 0;
let kept = 0;
const out = [];
for (const line of text.split('\n')) {
  if (!line) continue;
  total += 1;
  try {
    const rec = JSON.parse(line);
    if (Number.isFinite(rec?.ts) && rec.ts >= cutoff) {
      out.push(line);
      kept += 1;
    }
  } catch {
    // drop malformed lines
  }
}

const tmp = `${file}.tmp`;
await fs.writeFile(tmp, out.length ? out.join('\n') + '\n' : '');
await fs.rename(tmp, file);
console.log(`pruned ${total - kept} of ${total} records, kept ${kept} (last ${keepDays} days)`);
