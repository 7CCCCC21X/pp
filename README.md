# predict-fun-monitor

Telegram bot that watches Predict.fun markets with PP rewards, monitors their
order books, and pings you when something interesting happens — stalled top of
book, mid jumps, wide spreads, empty books, or unstaffed reward zones.

Designed to run as a long-lived worker on Railway. Zero npm dependencies; uses
Node 20+ built-ins.

---

## Quick start

```bash
# 1. Install Node 20+ (Mac)
brew install node

# 2. Clone + branch
gh repo clone 7CCCCC21X/pp
cd pp
git checkout claude/telegram-market-monitor-bot-kf6jI

# 3. Bot creds + Predict API key
cat > .env <<'EOF'
TELEGRAM_BOT_TOKEN=...      # @BotFather
TELEGRAM_CHAT_ID=...        # npm run get-chat-id after sending /start
PREDICT_API_KEY=...
AUTODISCOVER=true
MIN_HOURLY_RATE=500
MIN_REMAINING_HOURS=6
EOF

# 4. Sanity-check
npm test
npm run rewards            # list all rewarded markets, sorted by PP/h
npm run probe 241373       # snapshot one market

# 5. Run
npm start
```

### Telegram setup

1. Create the bot via [@BotFather](https://t.me/BotFather), copy the token.
2. Send `/start` to your bot from your account (or add it to a group).
3. `npm run get-chat-id` to discover the chat id, paste into `.env`.
4. Once running, the bot's "/" menu auto-populates with all available commands.

---

## Telegram commands

| Command | Purpose |
|---------|---------|
| `/menu` | Inline-keyboard quick menu |
| `/status` | Overview: each market's stall duration, PP/h, reward zone status, plus 24h PP total |
| `/list` | Compact id-only listing |
| `/probe <id>` | Single-market snapshot: top-3 bids/asks, mid/spread, reward zone activation |
| `/watch <id>` | High-sensitivity tracking: alerts on every detected book move (1-min cooldown) |
| `/unwatch <id\|all>` | Stop watching |
| `/add <id>` | Add to monitor list |
| `/remove <id>` | Remove permanently (excluded from auto-discover too) |
| `/pause <id>` | Mute alerts for one market |
| `/resume <id>` | Re-enable |
| `/discover` | Trigger auto-discovery now |
| `/digest` | Send 24h PP summary now |
| `/filter` | Show current bid/ask price/size filters |
| `/setfilter <name> <value>` | Set a filter at any of 18 keys: `min/maxBid1-3Price`, `minBid1-3Size`, etc |
| `/clearfilter <name\|all>` | Clear an override |
| `/help` | Full command list |

Every alert message has inline buttons: `[静音此市场] [查看状态]`.

---

## Alert types

| Kind | Triggers when | Default |
|------|---------------|---------|
| `stall` | Best bid/ask price unchanged for ≥ N hours | 6h |
| `mid_jump` | Mid moved ≥ N between two ticks | 0.05 |
| `wide_spread` | Spread > N for ≥ M minutes | 0.04 / 15min |
| `empty_book` | Best bid OR ask missing for ≥ M minutes | 30min |
| `reward_zone` | One side outside `±spreadThreshold` of mid OR size < `shareThreshold` for ≥ M min | 15min, ±6¢, size 100 |
| `price_sanity` | Threshold-ladder mispricing: a higher cap target priced ≥ a lower one (or within `PRICE_SANITY_MARGIN`) | 3¢ gap |
| `watch` | Watched market's top-of-book moved (cooldown 1min) | – |

All gated by per-market `[paused]`, the global filter set, and reward presence
(`SKIP_NO_REWARD=true` skips markets with `hourlyRate=0`).

**`price_sanity`** is a *cross-market* check that runs once per tick after every
market is refreshed. It groups markets that form a ladder over a single
underlying number — e.g. "reach a **$3B** market cap", "… **$4B**", "… **$5B**"
(also Chinese `30亿 / 40亿 / 50亿`, and `$3B ≡ 30亿`). Such a ladder is
monotonic: a higher target is strictly harder, so its implied probability (mid)
must be *lower*. The bot flags any adjacent pair whose lower rung isn't at least
`PRICE_SANITY_MARGIN` (default **3¢**) more likely than the next rung — catching
equal, inverted, or too-close pricing. "Below $X" ladders are detected and the
expectation flipped automatically. One alert per ladder, rate-limited by
`PRICE_SANITY_COOLDOWN_MS` (default 1h). Toggle with `/alerts off price_sanity`.

---

## CLI tools

```bash
npm start                      # run the bot
npm run once                   # one tick then exit (smoke test)
npm test                       # node --test, ~40 unit tests
npm run check                  # node --check on every source file

npm run rewards                # paginate all PP-rewarded markets, print sorted table
npm run rewards 500            # cap to 500 markets
MIN_HOURLY_RATE=1000 npm run rewards
MIN_REMAINING_HOURS=12 npm run rewards
MAX_PAGES=5 PAGE_SIZE=50 npm run rewards

npm run probe 241373           # one-shot snapshot for market 241373
npm run diagnose <id|slug|url> # introspect GraphQL schema, probe REST paths
                                # (use this if orderbook 404s after a deploy)

npm run get-chat-id            # find your TELEGRAM_CHAT_ID
npm run prune-history 14       # drop history.jsonl entries older than 14 days
```

---

## Configuration

Defaults are in `src/config.js`; override via env or `.env`. `validateConfig()`
runs at startup and throws with a clear list of bad values.

Required:
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- One of: `MARKET_IDS=a,b,c` or `AUTODISCOVER=true`
- `PREDICT_API_KEY`

Common knobs (see [.env.example](.env.example) for the full list):

```bash
POLL_INTERVAL_MS=300000          # 5 min
STALE_HOURS=6
PRICE_EPSILON=0.001
MID_JUMP_THRESHOLD=0.05
MAX_SPREAD=0.04
WIDE_SPREAD_MIN_MINUTES=15

# Auto-discover + filtering
AUTODISCOVER=true
MIN_HOURLY_RATE=500              # skip low-PP markets
MIN_REMAINING_HOURS=6            # skip markets ending soon
DISCOVERY_MAX_MARKETS=50

# Reward zone (Predict.fun PP rules)
REWARD_ZONE_MAX_DISTANCE=0.06    # ±6¢ from mid
REWARD_ZONE_MIN_SIZE=100

# Filters (limit which markets emit alerts; 18 keys, all optional)
FILTER_MIN_BID1_PRICE=0.05
FILTER_MAX_BID1_PRICE=0.95
FILTER_MIN_BID1_SIZE=100

# Persistence (Railway: mount Volume at /data)
STATE_FILE=/data/state.json
HISTORY_FILE=/data/history.jsonl
HISTORY_KEEP_DAYS=14             # auto-prune older records

# Network resilience
GRAPHQL_TIMEOUT_MS=30000
ORDERBOOK_TIMEOUT_MS=10000
```

---

## Railway deployment

1. Railway → New Project → Deploy from GitHub repo → pick the branch.
2. Service → Settings → Volumes → New Volume → mount `/data` (1 GB plenty).
3. Variables:

   ```
   TELEGRAM_BOT_TOKEN=...
   TELEGRAM_CHAT_ID=...
   PREDICT_API_KEY=...
   AUTODISCOVER=true
   MIN_HOURLY_RATE=1000
   MIN_REMAINING_HOURS=6
   DISCOVERY_MAX_MARKETS=50
   STATE_FILE=/data/state.json
   HISTORY_FILE=/data/history.jsonl
   ```
4. Networking → don't generate a domain (this is a worker, no HTTP).
5. Deploy. `railway.json` already wires up Nixpacks + `npm start` + restart
   on failure (max 10 retries).

---

## Architecture

```
src/
├── config.js          # Env loading + schema validation
├── http.js            # fetchJson: timeout + retry + backoff
├── predict.js         # GraphQL paginator + introspection-aware queries +
│                       # orderbook self-heal + cache
├── telegram.js        # Bot API + long-message chunking
├── state.js           # Atomic JSON state read/write
├── filters.js         # 18-key bid/ask price/size filter (3 levels x 2 sides)
├── format.js          # midOf/spreadOf/rewardZoneStatus + display helpers
├── monitor.js         # Tick orchestration: build context + run detectors
├── alerts/
│   ├── stall.js       # ≥ STALE_HOURS unchanged
│   ├── watch.js       # any change on watched markets
│   ├── midJump.js     # tick-to-tick mid drift
│   ├── wideSpread.js  # spread > MAX_SPREAD sustained
│   ├── rewardZone.js  # PP activation rule check
│   └── emptyBook.js   # missing side sustained
├── commands.js        # Telegram command handler + inline keyboards
├── discovery.js       # Auto-discover rewarded markets, sort + filter
├── history.js         # JSONL append + 24h aggregation
├── digest.js          # Daily summary
└── index.js           # Orchestrator: tick loop + cmd loop + persist queue

scripts/
├── rewards.js         # CLI: list all PP-rewarded markets
├── probe.js           # CLI: snapshot one market
├── diagnose.js        # CLI: introspect schema, probe orderbook URL shapes
├── get-chat-id.js     # CLI: discover Telegram chat id
└── prune-history.js   # CLI: rotate history.jsonl

test/                  # node --test suites for pure helpers
```

State (`state.json`) and history (`history.jsonl`) survive restarts via the
mounted volume. Per-market orderbook URL combinations (`{template, key}`) are
cached in state after first successful fetch — restarts go straight to the
working URL.

---

## Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| `Orderbook 404 not_found` | Set `ORDERBOOK_KEY_FIELD=conditionId` (default already). Run `npm run diagnose <id>` to find the right combo. |
| `npm run rewards` shows 0 markets | Verify `PREDICT_API_KEY`. Network can also block egress from sandboxed environments. |
| `Telegram getUpdates failed` | Bot token wrong, or no internet. Recheck `TELEGRAM_BOT_TOKEN`. |
| `/status` truncated | Long messages auto-chunk to ≤ 3900 chars; if you still hit a limit reduce `DISCOVERY_MAX_MARKETS`. |
| Bot runs but no alerts after hours | Check `MIN_HOURLY_RATE` isn't filtering everything; check `/status` for the 24h PP total to confirm activity. |
