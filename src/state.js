import fs from 'node:fs/promises';
import { config } from './config.js';

export async function loadState() {
  try {
    const text = await fs.readFile(config.stateFile, 'utf8');
    const json = JSON.parse(text);
    if (!json || typeof json !== 'object') return { markets: {} };
    if (!json.markets || typeof json.markets !== 'object') json.markets = {};
    return json;
  } catch (err) {
    if (err.code === 'ENOENT') return { markets: {} };
    throw err;
  }
}

export async function saveState(state) {
  const tmp = `${config.stateFile}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, config.stateFile);
}
