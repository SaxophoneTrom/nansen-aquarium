// Input validation for POST /v1/hatch.
//
// This file is the reason the Worker is allowed to exist at all. Nansen caps
// *failed* calls at 10 per minute per key (an undocumented limit found by
// measurement), and that key is shared with the GitHub Actions refresh that
// keeps the tank stocked. So a stranger typing nonsense into the hatch box must
// never reach the upstream API: every malformed request is answered here, and a
// 4xx from Nansen is treated downstream as a bug in this file.
//
// Everything below is pure — no bindings, no fetch — so it is unit-tested
// directly with `node --test`.

// Same list as src/chains.js, in the same order. A chain the front end offers
// and this array does not is a tab whose eggs never hatch.
export const CHAINS = Object.freeze(['robinhood', 'base', 'solana']);

const ADDRESS_PATTERNS = Object.freeze({
  robinhood: /^0x[0-9a-fA-F]{40}$/,
  // Base is an EVM L2, so its addresses are the same 20 bytes of hex. Kept as
  // its own entry rather than shared with robinhood: the two chains are only
  // incidentally the same shape, and a per-chain pattern is what lets a future
  // non-EVM tank drop in without unpicking this.
  base: /^0x[0-9a-fA-F]{40}$/,
  // base58: no 0, O, I or l. Lengths run 32–44 characters.
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
});

// Addresses that are a hole in the ledger rather than a trader: the EVM zero
// address, and Solana's system / incinerator programs. Same list as
// scripts/fetch.mjs — a burn address has no soul to read.
const NULL_ADDRS = new Set([
  '0x0000000000000000000000000000000000000000',
  '11111111111111111111111111111111',
  '1nc1nerator11111111111111111111111111111111',
]);

// ENS / SNS names need a resolver the v1 Worker does not have. The address
// patterns already reject a dot, but naming the case makes the intent explicit
// (and the front end shows a friendlier toast for it).
const NAME_SUFFIX = /\.(eth|sol)$/i;

// Turnstile documents its token as up to 2048 characters. The 4 KB body cap in
// index.js already leaves room for a full-length token; this is a per-field
// ceiling so a pathological string never reaches siteverify.
export const MAX_TOKEN_CHARS = 2048;

/**
 * EVM addresses are case-insensitive and arrive in mixed checksum casing, so
 * they are folded to lower case to key on. Solana addresses are base58 and
 * case-*sensitive* — folding one corrupts it, so anything that is not plainly
 * hex is passed through untouched. (Identical to scripts/fetch.mjs.)
 */
export const normAddr = (a) => {
  const s = String(a ?? '').trim();
  return /^0x[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : s;
};

export const isRealAddr = (a) => Boolean(a) && !NULL_ADDRS.has(String(a).toLowerCase());

/**
 * @param {unknown} body parsed JSON request body
 * @returns {{ ok: true, chain: string, address: string, token: string }
 *          | { ok: false, reason: string }}
 *          `address` is normalized and safe to use as a cache key.
 *          `reason` is for logging only — the client always sees "invalid_input".
 */
export function validateHatchInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('body');

  const { chain, address, token } = body;

  if (typeof chain !== 'string' || !CHAINS.includes(chain)) return fail('chain');
  if (typeof address !== 'string') return fail('address_type');

  const raw = address.trim();
  if (NAME_SUFFIX.test(raw)) return fail('name_not_supported');
  if (!ADDRESS_PATTERNS[chain].test(raw)) return fail('address_format');
  if (!isRealAddr(raw)) return fail('address_denied');

  if (typeof token !== 'string' || token.length === 0) return fail('token_missing');
  if (token.length > MAX_TOKEN_CHARS) return fail('token_length');

  return { ok: true, chain, address: normAddr(raw), token };
}

const fail = (reason) => ({ ok: false, reason });
