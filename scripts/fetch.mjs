#!/usr/bin/env node
// Nansen Aquarium — data fetcher
// Usage:
//   npm run fetch robinhood                    # reads NANSEN_API_KEY from .env
//   npm run fetch base
//   npm run fetch solana
//   NANSEN_API_KEY=… node scripts/fetch.mjs [chain] [--feed-only]
// Writes public/data/<chain>/tank.json and feed.json. The pipeline is generic —
// any chain the Nansen API knows works; the app ships robinhood, base and
// solana.
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
const CHAIN = args.find((a) => !a.startsWith('--')) ?? 'robinhood';
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
  // Solana's own money: the native token, its wrappers, and the liquid-staking
  // receipts that trade like it. Without these the Solana tank is five SOLs.
  'SOL', 'WSOL', 'JITOSOL', 'MSOL', 'BSOL', 'JUPSOL', 'INF', 'HSOL', 'BNSOL',
  'BNB', 'WBNB', 'POL', 'WPOL',
]);

// `include_stablecoins: false` only drops what Nansen has tagged, so newer
// dollar tokens still slip through on raw volume. Their tickers give them away.
const STABLE_ISH = /USD|EURC?$|DOLLAR/;

// Addresses that are a hole in the ledger rather than a trader: the EVM zero
// address, and Solana's system / incinerator programs.
const NULL_ADDRS = new Set([
  '0x0000000000000000000000000000000000000000',
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

// EVM addresses are case-insensitive and arrive in mixed checksum casing, so
// they are folded to lower case to key on. Solana addresses are base58 and
// case-*sensitive* — folding one corrupts it, so anything that is not plainly
// hex is passed through untouched.
const normAddr = (a) => {
  const s = String(a ?? '').trim();
  return /^0x[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : s;
};
const isRealAddr = (a) => Boolean(a) && !NULL_ADDRS.has(a.toLowerCase());

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
    .map((r) => ({ address: normAddr(r?.address), volume: num(r.trade_volume_usd) }))
    .filter((r) => isRealAddr(r.address) && r.volume > 0);
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
    const actor = normAddr(t.trader_address);
    if (!isRealAddr(actor) || !t.block_timestamp) continue;
    const side = String(t.action ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy';
    out.push({
      ts: t.block_timestamp,
      actor,
      side,
      amount_usd: Math.round(usd),
      token: (t.token_name ?? token.symbol ?? '?').trim(),
      token_address: t.token_address ?? token.address,
      tx: t.transaction_hash,
    });
  }
  return out;
}

// ---- 2b. the same roster, read off the trades instead ---------------------

/**
 * Fallback for chains where `tgm/who-bought-sold` answers with nothing: the
 * feed we already paid for names a trader and a size on every row, so the tank
 * can be cast straight out of it. Same shape as the who-bought-sold roster —
 * address, summed USD, and the per-token split behind it — and it costs no
 * extra credits because the trades are already in hand.
 * @param {Array} events feed rows, oldest first
 */
function actorsFromTrades(events) {
  const byActor = new Map();
  for (const e of events) {
    if (!isRealAddr(e.actor)) continue;
    const usd = num(e.amount_usd);
    if (usd <= 0) continue;
    const a = byActor.get(e.actor) ?? { address: e.actor, volume: 0, tokens: new Map() };
    a.volume += usd;
    a.tokens.set(e.token, (a.tokens.get(e.token) ?? 0) + usd);
    byActor.set(e.actor, a);
  }
  return byActor;
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

  // If who-bought-sold came back thin — it is empty on some chains — top the
  // roster up from the trades themselves, which are already paid for.
  let rosterSource = 'who-bought-sold';
  if (byActor.size < TANK_SIZE) {
    const spare = [...actorsFromTrades(events).values()]
      .filter((a) => !byActor.has(a.address))
      .sort((a, b) => b.volume - a.volume);
    if (spare.length) {
      rosterSource = byActor.size ? 'who-bought-sold + dex-trades fallback' : 'dex-trades fallback';
      console.warn(
        `who-bought-sold yielded ${byActor.size} traders (want ${TANK_SIZE}) — `
        + `topping up from ${spare.length} dex-trades actors`,
      );
      for (const a of spare.slice(0, TANK_SIZE - byActor.size)) byActor.set(a.address, a);
    }
  }

  const roster = [...byActor.values()].sort((a, b) => b.volume - a.volume).slice(0, TANK_SIZE);
  console.log(`roster: ${roster.length} creatures via ${rosterSource}, enriching with pnl-summary…`);

  // ---- 3. enrich each creature with pnl-summary (1cr each) ----
  const to = new Date().toISOString();
  const from = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
  const creatures = [];
  let blankPnl = 0;
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
    // A wallet the profiler holds no history for answers with a full row of
    // zeroes rather than nulls — the same shape a genuinely flat trader would
    // wear. Here the zeroes are an absence, not a fact, and taken literally
    // they darken the creature to the floor and name it "The Gambler" off a 0%
    // win rate it never earned. Both counters at zero is the tell: no trades
    // across no tokens is not a trading record, it is a blank page. The whole
    // row drops back to null so the null paths downstream take over — glow
    // settles at a middling 0.5, the stat rows stay off the legend card, and
    // the epithet comes from the absence itself.
    const blank = Boolean(pnl) && num(pnl.traded_times) === 0 && num(pnl.traded_token_count) === 0;
    if (blank) blankPnl += 1;
    const stat = (v) => (!blank && typeof v === 'number' && Number.isFinite(v) ? v : null);
    const winRate = stat(pnl?.win_rate);
    const fromPnl = (pnl?.top5_tokens ?? []).map((t) => t.token_symbol).filter(Boolean).slice(0, 5);
    creatures.push({
      address: a.address,
      species: 'fish', // assigned after the loop by rank
      trades_24h_usd: Math.round(a.volume),
      win_rate: winRate,
      glow: winRate ?? 0.5,
      realized_pnl_usd: stat(pnl?.realized_pnl_usd),
      traded_times: stat(pnl?.traded_times),
      traded_token_count: stat(pnl?.traded_token_count),
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
  // Brightness reads off win_rate, and a null falls back to a middling 0.5 —
  // so how many of them Nansen could actually answer is worth saying out loud.
  const withWin = creatures.filter((c) => typeof c.win_rate === 'number').length;
  console.log(`win_rate: ${withWin}/${creatures.length} populated`
    + ` (${creatures.length - withWin} fall back to glow 0.5`
    + `${blankPnl ? `, ${blankPnl} of them with no profiler history at all` : ''})`);
  console.log(`credits used this run: ${creditsUsed}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
