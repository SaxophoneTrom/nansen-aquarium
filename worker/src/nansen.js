// The one upstream call this Worker is allowed to make, plus the mock that
// stands in for it locally, plus the whitelist that decides what a visitor is
// allowed to see.
//
// `profiler/address/pnl-summary` is the only endpoint here, and its URL is a
// hardcoded constant — nothing a request carries can steer it. That is what
// keeps this from being a general-purpose Nansen proxy, which the redistribution
// guidelines would not survive.

const NANSEN_URL = 'https://api.nansen.ai/api/v1/profiler/address/pnl-summary';
const TIMEOUT_MS = 8000;
const WINDOW_DAYS = 90;
const MOCK_LATENCY_MS = 400;

/** Thrown for anything the client should see as `upstream_error` (502). */
export class UpstreamError extends Error {}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Fetch the raw pnl-summary payload for one address.
 * Same request shape as scripts/fetch.mjs: POST, `apiKey` header, 90-day window.
 * @returns {Promise<object>} the upstream JSON, unfiltered
 * @throws {UpstreamError}
 */
export async function fetchPnlSummary(env, chain, address) {
  if (env.MOCK_NANSEN === '1') return mockPnlSummary(chain, address);

  if (!env.NANSEN_API_KEY) {
    console.error('CONFIG BUG: NANSEN_API_KEY is not bound and MOCK_NANSEN is not 1');
    throw new UpstreamError('no_api_key');
  }

  const to = new Date().toISOString();
  const from = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();

  // No retry in v1: a second attempt doubles the credit spend on the failure
  // path, which is exactly the path an attacker would try to sit on.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(NANSEN_URL, {
      method: 'POST',
      headers: { apiKey: env.NANSEN_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ chain, address, date: { from, to } }),
      signal: ac.signal,
    });
  } catch (err) {
    throw new UpstreamError(err?.name === 'AbortError' ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // validate.js is supposed to make a 4xx unreachable, and each one eats into
    // the shared key's 10-failures-per-minute allowance — so if one lands, the
    // log has to say so loudly. The body is never read or relayed: it can carry
    // request ids and upstream detail that is none of a visitor's business.
    if (res.status >= 400 && res.status < 500) {
      console.error('DESIGN BUG: upstream 4xx', res.status);
    }
    throw new UpstreamError(`http_${res.status}`);
  }

  const used = res.headers.get('x-nansen-credits-used');
  if (used) console.log(`nansen credits used: ${used}`);

  try {
    return await res.json();
  } catch {
    throw new UpstreamError('bad_json');
  }
}

/**
 * Blank guard + whitelist, in one pure step. Everything the client ever sees is
 * built here, field by field, from an explicit list.
 *
 * A wallet the profiler holds no history for answers with a full row of zeroes
 * rather than nulls — the same shape a genuinely flat trader would wear. Here
 * the zeroes are an absence, not a fact, and taken literally they darken the
 * creature to the floor and name it "The Gambler" off a 0% win rate it never
 * earned. Both counters at zero is the tell: no trades across no tokens is not a
 * trading record, it is a blank page. The whole row drops back to null so the
 * null paths in the front end take over — glow settles at a middling 0.5, the
 * stat rows stay off the card, and the epithet becomes "The Enigma".
 *
 * @returns {object} exactly the fields in the design doc §4.6 and no others
 */
export function toHatchPayload({ chain, address, raw, fetchedAt, cached = false }) {
  const blank = Boolean(raw) && num(raw.traded_times) === 0 && num(raw.traded_token_count) === 0;
  const hasHistory = Boolean(raw) && !blank;
  const stat = (v) => (hasHistory && typeof v === 'number' && Number.isFinite(v) ? v : null);

  // Symbols only. `token_address` is dropped the same way tank.json drops it,
  // and `pagination` never leaves the Worker.
  const topTokens = hasHistory
    ? (Array.isArray(raw.top5_tokens) ? raw.top5_tokens : [])
      .map((t) => t?.token_symbol)
      .filter((s) => typeof s === 'string' && s.length > 0)
      .slice(0, 5)
    : [];

  return {
    chain,
    address,
    has_history: hasHistory,
    win_rate: stat(raw?.win_rate),
    realized_pnl_usd: stat(raw?.realized_pnl_usd),
    realized_pnl_percent: stat(raw?.realized_pnl_percent),
    traded_times: stat(raw?.traded_times),
    traded_token_count: stat(raw?.traded_token_count),
    top_tokens: topTokens,
    fetched_at: fetchedAt,
    cached: Boolean(cached),
  };
}

// ---- mock ----------------------------------------------------------------

// Two addresses that always hatch The Enigma, so the no-history path can be
// exercised without hunting for a real empty wallet. Both are valid for their
// chain and neither is on the deny list, so they walk the whole pipeline.
export const BLANK_TEST_ADDRESSES = Object.freeze({
  robinhood: '0x00000000000000000000000000000000000000ee',
  solana: 'EggEnigma1111111111111111111111111111111111',
});

const BLANK_ROW = Object.freeze({
  pagination: { page: 1, per_page: 1, is_last_page: true },
  top5_tokens: [],
  traded_token_count: 0,
  traded_times: 0,
  realized_pnl_usd: 0,
  realized_pnl_percent: 0,
  win_rate: 0,
});

// Six wallets worth simulating, in the real upstream shape so the whitelist runs
// over the same fields it will see in production. Keep `realized_pnl_percent`
// meaningful: the front end derives the creature's size from
// abs(realized_pnl_usd / realized_pnl_percent), so these numbers decide whether
// a mock address hatches a whale or a minnow.
const MOCK_PROFILES = [
  // 0 — big winner: ~$53M implied scale, near-perfect record. Whale.
  {
    top5_tokens: [
      { realized_pnl: 902_411.44, realized_roi: 0.0281, token_address: '0x1', token_symbol: 'NVDA', chain: null },
      { realized_pnl: 214_880.9, realized_roi: 0.0166, token_address: '0x2', token_symbol: 'USDG', chain: null },
      { realized_pnl: 76_399.94, realized_roi: 0.0092, token_address: '0x3', token_symbol: 'TSLA', chain: null },
    ],
    traded_token_count: 12,
    traded_times: 214,
    realized_pnl_usd: 1_193_692.28,
    realized_pnl_percent: 0.0226,
    win_rate: 0.68,
  },
  // 1 — loser: red glow, one in five trades worked out.
  {
    top5_tokens: [
      { realized_pnl: -31_204.11, realized_roi: -0.2214, token_address: '0x4', token_symbol: 'CASHCAT', chain: null },
      { realized_pnl: -17_006.44, realized_roi: -0.1102, token_address: '0x5', token_symbol: 'DOGE', chain: null },
    ],
    traded_token_count: 6,
    traded_times: 88,
    realized_pnl_usd: -48_210.55,
    realized_pnl_percent: -0.1823,
    win_rate: 0.21,
  },
  // 2 — scalper: thousands of trades, coin-flip record, thin margin.
  {
    top5_tokens: [
      { realized_pnl: 4_112.08, realized_roi: 0.0141, token_address: '0x6', token_symbol: 'SPY', chain: null },
      { realized_pnl: 2_890.77, realized_roi: 0.0119, token_address: '0x7', token_symbol: 'QQQ', chain: null },
      { realized_pnl: 1_120.55, realized_roi: 0.0071, token_address: '0x8', token_symbol: 'USDG', chain: null },
      { realized_pnl: 0.0, realized_roi: 0.0, token_address: '0x9', token_symbol: 'AAPL', chain: null },
    ],
    traded_token_count: 31,
    traded_times: 2417,
    realized_pnl_usd: 8_123.4,
    realized_pnl_percent: 0.0309,
    win_rate: 0.54,
  },
  // 3 — tiny wallet: three trades, twelve dollars. Smallest fish in the tank.
  {
    top5_tokens: [
      { realized_pnl: 12.44, realized_roi: 0.0139, token_address: '0xa', token_symbol: 'HOOD', chain: null },
    ],
    traded_token_count: 1,
    traded_times: 3,
    realized_pnl_usd: 12.44,
    realized_pnl_percent: 0.0139,
    win_rate: 0.67,
  },
  // 4 — mixed: ~$1.25M implied scale, slightly under water on the record but up
  //     on the money. Shark territory.
  {
    top5_tokens: [
      { realized_pnl: 91_440.2, realized_roi: 0.1902, token_address: '0xb', token_symbol: 'PEPE', chain: null },
      { realized_pnl: -30_240.3, realized_roi: -0.0884, token_address: '0xc', token_symbol: 'WIF', chain: null },
    ],
    traded_token_count: 9,
    traded_times: 141,
    realized_pnl_usd: 61_199.9,
    realized_pnl_percent: 0.049,
    win_rate: 0.48,
  },
  // 5 — history but no win rate: the profiler answers null for some wallets, and
  //     the front end has to fall back to glow 0.5 without calling it Enigma.
  {
    top5_tokens: [
      { realized_pnl: 5_320.0, realized_roi: 0.0402, token_address: '0xd', token_symbol: 'BONK', chain: null },
      { realized_pnl: 980.5, realized_roi: 0.0111, token_address: '0xe', token_symbol: 'JUP', chain: null },
    ],
    traded_token_count: 4,
    traded_times: 37,
    realized_pnl_usd: 6_300.5,
    realized_pnl_percent: 0.0288,
    win_rate: null,
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deterministic stand-in for the real row: one address always hatches the same
 * fish, so a screenshot taken today still matches tomorrow. Pure, so the tests
 * can sweep hundreds of addresses without waiting on the simulated latency.
 */
export function pickMockRow(chain, address) {
  if (BLANK_TEST_ADDRESSES[chain] === address) return structuredClone(BLANK_ROW);

  let sum = 0;
  for (let i = 0; i < address.length; i += 1) sum += address.charCodeAt(i);
  const profile = MOCK_PROFILES[sum % MOCK_PROFILES.length];

  return {
    pagination: { page: 1, per_page: 1, is_last_page: true },
    ...structuredClone(profile),
    top5_tokens: profile.top5_tokens.map((t) => ({ ...t, chain })),
  };
}

/**
 * What `fetchPnlSummary` calls in mock mode. The artificial delay keeps the
 * front end's egg animation honest about how long a real read takes.
 */
export async function mockPnlSummary(chain, address) {
  await sleep(MOCK_LATENCY_MS);
  return pickMockRow(chain, address);
}
