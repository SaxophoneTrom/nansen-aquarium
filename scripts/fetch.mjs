#!/usr/bin/env node
// Nansen Aquarium — data fetcher
// Usage:
//   npm run fetch                              # reads NANSEN_API_KEY from .env
//   NANSEN_API_KEY=… node scripts/fetch.mjs [chain] [--feed-only]
// Writes public/data/<chain>/tank.json and feed.json.
//
// Pipeline (all endpoints are ✅ Allowed for redistribution under Nansen's
// Data Redistribution Guidelines — see README):
//   1. token-screener                 1cr   → today's five busiest tokens
//   2. tgm/who-bought-sold  x5        5cr   → per-trader volume on each token
//   3. tgm/dex-trades       x5        5cr   → the trades the feed replays
//   4. profiler/address/pnl-summary  25cr   → one per creature in the tank
// Full run ≈ 36 credits; a --feed-only run reuses the token list already in
// tank.json and costs 5.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'https://api.nansen.ai';
const API_KEY = process.env.NANSEN_API_KEY;

const args = process.argv.slice(2);
const CHAIN = args.find((a) => !a.startsWith('--')) ?? 'ethereum';
const FEED_ONLY = args.includes('--feed-only');
const TANK_SIZE = 25;
const TOKEN_COUNT = 5;      // tokens the aquarium watches for a day
const TRADES_PER_TOKEN = 200;
const MAX_EVENTS = 600;
const MIN_TRADE_USD = 100;  // anything smaller is dust, not a snack

// Symbols that count as "money" rather than a token anyone is trading *for*.
// The screener ranks by raw volume, so without this the tank would be five
// flavours of stablecoin and wrapped ETH every single day.
const MONEY = new Set([
  'USDC', 'USDT', 'DAI', 'USDS', 'USDG', 'USDE', 'FDUSD', 'PYUSD', 'GHO', 'FRAX',
  'ETH', 'WETH', 'STETH', 'WSTETH', 'WEETH', 'RETH', 'CBETH',
  'WBTC', 'CBBTC', 'TBTC', 'BTC',
  'SOL', 'WSOL', 'JITOSOL', 'MSOL', 'BNB', 'WBNB', 'POL', 'WPOL',
]);

// `include_stablecoins: false` only drops what Nansen has tagged, so newer
// dollar tokens still slip through on raw volume. Their tickers give them away.
const STABLE_ISH = /USD|EURC?$|DOLLAR/;

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

let creditsUsed = 0;

function cleanSymbol(sym) {
  // strip Nansen's emoji prefixes (🌱 new token / ⚠️ warning) for comparisons only
  return (sym ?? '').replace(/[\u{1F331}\u{26A0}\u{FE0F}]/gu, '').trim().toUpperCase();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { apiKey: API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const used = Number(res.headers.get('x-nansen-credits-used') ?? 0);
  if (used) creditsUsed += used;
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    throw new Error(`${path} -> HTTP ${res.status}: ${text}`);
  }
  return res.json();
}

const rows = (payload) => (Array.isArray(payload) ? payload : payload?.data ?? []);

/** The 24h window every call shares. */
function window24h() {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 3600 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

// ---- 1. today's busiest tokens -------------------------------------------

async function pickTokens() {
  const res = await post('/api/v1/token-screener', {
    chains: [CHAIN],
    timeframe: '24h',
    filters: { include_stablecoins: false },
    pagination: { page: 1, per_page: 100 },
  });
  const all = rows(res)
    .filter((t) => {
      const sym = cleanSymbol(t.token_symbol);
      return t?.token_address && sym && !MONEY.has(sym) && !STABLE_ISH.test(sym);
    })
    .sort((a, b) => num(b.volume) - num(a.volume))
    .slice(0, TOKEN_COUNT)
    .map((t) => ({
      symbol: (t.token_symbol ?? '?').trim(),
      address: t.token_address,
      volume_24h_usd: Math.round(num(t.volume)),
    }));
  if (!all.length) throw new Error('token-screener returned no tradable tokens');
  return all;
}

// ---- 2. who traded them --------------------------------------------------

async function tradersFor(token, date) {
  const res = await post('/api/v1/tgm/who-bought-sold', {
    chain: CHAIN,
    token_address: token.address,
    date,
    pagination: { page: 1, per_page: 100 },
  });
  return rows(res)
    .filter((r) => r?.address && r.address !== ZERO_ADDR)
    .map((r) => ({ address: String(r.address).toLowerCase(), volume: num(r.trade_volume_usd) }))
    .filter((r) => r.volume > 0);
}

// ---- 3. the trades the feed replays --------------------------------------

async function tradesFor(token, date) {
  const res = await post('/api/v1/tgm/dex-trades', {
    chain: CHAIN,
    token_address: token.address,
    date,
    pagination: { page: 1, per_page: TRADES_PER_TOKEN },
  });
  const out = [];
  for (const t of rows(res)) {
    const usd = num(t.estimated_value_usd);
    if (usd < MIN_TRADE_USD) continue;
    if (!t.trader_address || !t.block_timestamp) continue;
    const side = String(t.action ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy';
    out.push({
      ts: t.block_timestamp,
      actor: String(t.trader_address).toLowerCase(),
      side,
      amount_usd: Math.round(usd),
      token: (t.token_name ?? token.symbol ?? '?').trim(),
      token_address: t.token_address ?? token.address,
      tx: t.transaction_hash,
    });
  }
  return out;
}

// Species = rank within today's tank (traded volume, desc).
// Top 2 whales, next 3 sharks, next 6 dolphins, the rest fish.
function assignSpecies(creatures) {
  creatures.forEach((c, i) => {
    c.species = i < 2 ? 'whale' : i < 5 ? 'shark' : i < 11 ? 'dolphin' : 'fish';
  });
}

async function main() {
  if (!API_KEY) {
    console.error('NANSEN_API_KEY is not set. Put it in .env at the project root, or export it before running.');
    process.exit(1);
  }

  const outDir = join(ROOT, 'public', 'data', CHAIN);
  await mkdir(outDir, { recursive: true });

  let prevTank = null;
  try {
    prevTank = JSON.parse(await readFile(join(outDir, 'tank.json'), 'utf8'));
  } catch { /* first run */ }

  // A feed-only refresh replays the same five tokens the tank was cast from,
  // so it can skip the screener and cost exactly 5 credits.
  const tokens = FEED_ONLY && prevTank?.tokens?.length ? prevTank.tokens : await pickTokens();
  console.log(`tokens: ${tokens.map((t) => t.symbol).join(', ')}`);

  const date = window24h();

  // ---- feed ----
  const fresh = [];
  for (const token of tokens) {
    try {
      const evts = await tradesFor(token, date);
      console.log(`dex-trades ${token.symbol}: ${evts.length} events`);
      fresh.push(...evts);
    } catch (err) {
      console.warn(`dex-trades failed for ${token.symbol}: ${err.message.slice(0, 140)}`);
    }
    await sleep(150);
  }

  // Merge with the previous feed so a rolling 24h window survives a call that
  // happens to return a short slice of the day.
  let prev = [];
  try {
    prev = JSON.parse(await readFile(join(outDir, 'feed.json'), 'utf8')).events ?? [];
  } catch { /* first run */ }
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const seen = new Set();
  const events = [...prev, ...fresh]
    .filter((e) => e.ts >= cutoff)
    .filter((e) => {
      const k = `${e.tx}:${e.token_address}:${e.side}:${e.actor}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-MAX_EVENTS);

  await writeFile(
    join(outDir, 'feed.json'),
    JSON.stringify({ chain: CHAIN, generated_at: new Date().toISOString(), events }, null, 1),
  );
  console.log(`feed.json: ${events.length} events`);

  if (FEED_ONLY) {
    console.log(`credits used this run: ${creditsUsed}`);
    return;
  }

  // ---- 2. roster: top traders across all five tokens ----
  const byActor = new Map();
  for (const token of tokens) {
    let traders = [];
    try {
      traders = await tradersFor(token, date);
    } catch (err) {
      console.warn(`who-bought-sold failed for ${token.symbol}: ${err.message.slice(0, 140)}`);
    }
    console.log(`who-bought-sold ${token.symbol}: ${traders.length} traders`);
    for (const t of traders) {
      const a = byActor.get(t.address) ?? { address: t.address, volume: 0, tokens: new Map() };
      a.volume += t.volume;
      a.tokens.set(token.symbol, (a.tokens.get(token.symbol) ?? 0) + t.volume);
      byActor.set(t.address, a);
    }
    await sleep(150);
  }

  const roster = [...byActor.values()].sort((a, b) => b.volume - a.volume).slice(0, TANK_SIZE);
  console.log(`roster: ${roster.length} creatures, enriching with pnl-summary…`);

  // ---- 3. enrich each creature with pnl-summary (1cr each) ----
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const creatures = [];
  for (const a of roster) {
    let pnl = null;
    try {
      pnl = await post('/api/v1/profiler/address/pnl-summary', {
        chain: CHAIN,
        address: a.address,
        date: { from, to },
      });
    } catch (err) {
      console.warn(`pnl-summary failed for ${a.address.slice(0, 10)}…: ${err.message.slice(0, 120)}`);
    }
    const winRate = typeof pnl?.win_rate === 'number' ? pnl.win_rate : null;
    const fromPnl = (pnl?.top5_tokens ?? []).map((t) => t.token_symbol).filter(Boolean).slice(0, 5);
    creatures.push({
      address: a.address,
      species: 'fish', // assigned after the loop by rank
      trades_24h_usd: Math.round(a.volume),
      win_rate: winRate,
      glow: winRate ?? 0.5,
      realized_pnl_usd: pnl?.realized_pnl_usd ?? null,
      traded_times: pnl?.traded_times ?? null,
      traded_token_count: pnl?.traded_token_count ?? null,
      top_tokens: fromPnl.length
        ? fromPnl
        : [...a.tokens.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([s]) => s),
    });
    await sleep(150);
  }

  assignSpecies(creatures);

  // size: log-normalized 0.3..1.0 within the tank
  const vols = creatures.map((c) => Math.log10(Math.max(c.trades_24h_usd, 100)));
  const lo = Math.min(...vols);
  const hi = Math.max(...vols);
  creatures.forEach((c, i) => {
    c.size = hi === lo ? 0.6 : Number((0.3 + 0.7 * ((vols[i] - lo) / (hi - lo))).toFixed(2));
  });

  await writeFile(
    join(outDir, 'tank.json'),
    JSON.stringify({ chain: CHAIN, generated_at: new Date().toISOString(), tokens, creatures }, null, 1),
  );
  const counts = creatures.reduce((m, c) => ((m[c.species] = (m[c.species] ?? 0) + 1), m), {});
  console.log(`tank.json: ${creatures.length} creatures`, counts);
  console.log(`credits used this run: ${creditsUsed}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
