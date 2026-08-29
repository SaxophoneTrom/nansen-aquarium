// Nansen Aquarium — hatchery Worker
//
// One route that matters: POST /v1/hatch takes a chain and a wallet address,
// reads that wallet's 90-day PnL summary from Nansen exactly once, and hands
// back the handful of numbers the front end turns into a fish.
//
// The pipeline below is ordered by cost, cheapest first. Everything that can be
// decided from the request alone is decided before a single byte leaves the
// Worker, because the expensive things at the bottom — a Turnstile round trip, a
// Durable Object hop, a Nansen credit — are exactly what an attacker would like
// to make us spend. Read src/validate.js for why the free checks are not
// optional.

import { validateHatchInput } from './validate.js';
import { verifyTurnstile } from './turnstile.js';
import { chargeDaily, intVar, secondsUntilUtcMidnight, underMinuteLimit } from './limits.js';
import { fetchPnlSummary, toHatchPayload, UpstreamError } from './nansen.js';

export { CountersDO } from './counters.js';

// Turnstile documents its response token as up to 2048 characters, so a
// legitimate hatch request can approach 2.2 KB of JSON. 4 KB leaves that room
// with margin; anything larger is not a browser filling in the form.
const MAX_BODY_BYTES = 4096;

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v1/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return methodNotAllowed('GET');
      // Deliberately outside every gate: uptime checks must not need a captcha,
      // must not consume a rate-limit slot, and must never touch Nansen.
      return json({ ok: true }, { origin: allowedOrigin(request, env) });
    }

    if (path !== '/v1/hatch') return new Response(null, { status: 404 });

    const origin = allowedOrigin(request, env);

    if (request.method === 'OPTIONS') {
      if (!origin) return json({ error: 'invalid_input' }, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }

    if (request.method !== 'POST') return methodNotAllowed('POST, OPTIONS');

    try {
      return await hatch(request, env, ctx, origin);
    } catch (err) {
      console.error('unhandled:', err?.stack ?? String(err));
      return json({ error: 'upstream_error' }, { status: 502, origin });
    }
  },
};

async function hatch(request, env, ctx, origin) {
  // --- 1. shape of the request ------------------------------------------
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return json({ error: 'invalid_input' }, { status: 400, origin });
  }

  const declared = Number(request.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ error: 'invalid_input' }, { status: 400, origin });
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return json({ error: 'invalid_input' }, { status: 400, origin });
  }

  // --- 2. origin ---------------------------------------------------------
  // A browser always sends Origin on a cross-origin fetch, so a request without
  // one is not the aquarium. This stops honest pages, not curl — the real
  // defence is everything below it.
  if (!origin) return json({ error: 'invalid_input' }, { status: 403 });

  // --- 3. input ----------------------------------------------------------
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: 'invalid_input' }, { status: 400, origin });
  }

  const input = validateHatchInput(body);
  if (!input.ok) {
    console.log('rejected input:', input.reason);
    return json({ error: 'invalid_input' }, { status: 400, origin });
  }
  const { chain, address, token } = input;

  // --- 4. per-minute throttle -------------------------------------------
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  if (!(await underMinuteLimit(env, ip))) {
    return json({ error: 'rate_limited' }, { status: 429, origin, retryAfter: 60 });
  }

  // --- 5. Turnstile ------------------------------------------------------
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, ip === 'unknown' ? null : ip))) {
    return json({ error: 'captcha_failed' }, { status: 403, origin });
  }

  // --- 6. cache ----------------------------------------------------------
  // A hit returns here and skips both daily counters, so hammering one address
  // costs nothing — which is the point. It sits behind Turnstile, so the cache
  // is not a free read endpoint for anyone who wants to enumerate wallets.
  const cacheKey = `pnl:${chain}:${address}`;
  const hit = await readCache(env, cacheKey);
  if (hit) return json({ ...hit, cached: true }, { origin });

  // --- 7. daily quotas ---------------------------------------------------
  const quota = await chargeDaily(env, ip);
  if (!quota.ok) {
    const retryAfter = secondsUntilUtcMidnight();
    return quota.reason === 'budget'
      ? json({ error: 'budget_exhausted' }, { status: 503, origin, retryAfter })
      : json({ error: 'rate_limited' }, { status: 429, origin, retryAfter });
  }

  // --- 8/9/10. read, guard, minimise, cache ------------------------------
  let raw;
  try {
    raw = await fetchPnlSummary(env, chain, address);
  } catch (err) {
    if (!(err instanceof UpstreamError)) throw err;
    console.warn('upstream failed:', err.message);
    return json({ error: 'upstream_error' }, { status: 502, origin });
  }

  const payload = toHatchPayload({
    chain,
    address,
    raw,
    fetchedAt: new Date().toISOString(),
    cached: false,
  });

  // Cache the whitelisted payload, not the upstream row: nothing that was
  // filtered out can leak back in through a cache hit. `cached` is re-stamped on
  // read, so the stored copy's value is irrelevant.
  ctx.waitUntil(
    env.CACHE.put(cacheKey, JSON.stringify(payload), {
      expirationTtl: intVar(env, 'CACHE_TTL_S', 86400),
    }).catch((err) => console.warn('cache put failed:', err?.message)),
  );

  return json(payload, { origin });
}

/**
 * A cache read must never be able to fail the request. Anything unreadable is
 * treated as a miss and re-fetched — a bad entry costs one credit, whereas
 * letting it throw would 502 that one address for the whole TTL.
 */
async function readCache(env, key) {
  try {
    const hit = await env.CACHE.get(key, 'json');
    return hit && typeof hit === 'object' && !Array.isArray(hit) ? hit : null;
  } catch (err) {
    console.warn('cache get failed:', err?.message);
    return null;
  }
}

// ---- responses ------------------------------------------------------------

/** @returns {string|null} the request's Origin if it is on the allowlist */
function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  const allowed = String(env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function json(body, { status = 200, origin = null, retryAfter = null } = {}) {
  const headers = { ...JSON_HEADERS, Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  if (retryAfter !== null) headers['Retry-After'] = String(retryAfter);
  return new Response(JSON.stringify(body), { status, headers });
}

function methodNotAllowed(allow) {
  return new Response(null, { status: 405, headers: { Allow: allow } });
}
