// Thin client over the COUNTERS Durable Object, plus the number-parsing the
// rest of the Worker leans on. Vars arrive as strings from wrangler.jsonc and
// from `--var` overrides, and a typo there should not silently disable a limit —
// so every read falls back to the documented default.

/** @returns {number} `env[name]` as a positive integer, or `fallback`. */
export function intVar(env, name, fallback) {
  const n = Number.parseInt(String(env?.[name] ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * The address a rate bucket is keyed on. A single IPv4 is one host, but a single
 * IPv6 client is handed a whole /64 (or wider) by its ISP and can bind a fresh
 * address per request for free — so counting the full /128 would let one
 * attacker look like 2^64 first-time visitors and walk straight past both the
 * per-minute and per-day caps. IPv6 is therefore folded to its /64 prefix (the
 * first four hextets) before it is counted; IPv4 is used whole.
 * @param {string} ip the edge-set CF-Connecting-IP
 * @returns {string}
 */
export function ipBucket(ip) {
  if (typeof ip !== 'string' || !ip.includes(':')) return ip;
  return ip.split(':').slice(0, 4).join(':') + '::/64';
}

/** Seconds until the next UTC midnight — the moment the daily counters reset. */
export function secondsUntilUtcMidnight(now = Date.now()) {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/**
 * Spend one credit against both daily quotas, atomically.
 * @returns {Promise<{ ok: true } | { ok: false, reason: 'ip_daily' | 'budget' }>}
 */
export async function chargeDaily(env, ip) {
  const stub = env.COUNTERS.get(env.COUNTERS.idFromName('global'));
  return stub.charge({
    ip: ipBucket(ip),
    ipLimit: intVar(env, 'IP_DAILY_LIMIT', 20),
    budgetLimit: intVar(env, 'DAILY_BUDGET', 1000),
  });
}

/**
 * Per-minute throttle via the Rate Limiting binding. It counts per colocation
 * rather than globally, so it is a deterrent and not a guarantee — the exact
 * numbers are the Durable Object's job. If the binding is missing the request is
 * let through: the daily counters and Turnstile are still in front of the API
 * key, and failing closed here would take the whole feature down over a config
 * slip.
 * @returns {Promise<boolean>} true if the request may continue
 */
export async function underMinuteLimit(env, ip) {
  if (!env.IP_LIMITER?.limit) {
    console.warn('IP_LIMITER binding missing — per-minute throttle disabled');
    return true;
  }
  const { success } = await env.IP_LIMITER.limit({ key: ipBucket(ip) });
  return success;
}
