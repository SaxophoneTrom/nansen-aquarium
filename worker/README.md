# Aquarium Hatchery Worker

The only server-side piece of Nansen Aquarium. A visitor types a wallet address
into the hatch box; this Worker reads that wallet's 90-day PnL summary from
Nansen exactly once, and hands back the handful of numbers the front end turns
into a fish.

It is deliberately not a proxy. One route, two chains, one hardcoded upstream
URL, and a whitelist that rebuilds the response field by field — nothing a
request carries can steer it anywhere else.

## Why the gauntlet

The API key is shared with the GitHub Actions job that restocks the tank every
few hours. Two things follow from that:

- **Credits are finite.** Someone scripting the hatch box could drain a month of
  budget in an afternoon and take the whole aquarium down with it. Hence
  Turnstile, a per-minute throttle, a per-IP daily cap, and a hard global daily
  budget that closes the nursery gracefully rather than spending past it.
- **Failures are rationed too.** Nansen caps *failed* calls at 10 per minute per
  key (undocumented — found by measurement, see
  `docs/nansen-api/10_empirical_findings.md`). A stranger typing nonsense must
  never reach the upstream API, or the cron's next run gets rate-limited on
  someone else's typos. Every malformed request dies in `src/validate.js`; a 4xx
  from Nansen is treated as a bug in that file and logged as one.

## Endpoints

```
POST /v1/hatch      Content-Type: application/json
{ "chain": "robinhood" | "solana", "address": "<raw address>", "token": "<turnstile token>" }

GET  /v1/health     → { "ok": true }   monitoring; no captcha, no limits, never touches Nansen
OPTIONS /v1/hatch   CORS preflight
anything else       → 404, empty body
```

### Success

```json
{
  "chain": "robinhood",
  "address": "0x1f9090aae28b8a3dceadf281b0f12828e676c326",
  "has_history": true,
  "win_rate": 0.68,
  "realized_pnl_usd": 1193692.28,
  "realized_pnl_percent": 0.0226,
  "traded_times": 214,
  "traded_token_count": 12,
  "top_tokens": ["NVDA", "USDG", "TSLA"],
  "fetched_at": "2026-08-28T09:14:22.104Z",
  "cached": false
}
```

`has_history: false` means every stat is `null` and `top_tokens` is `[]` — the
front end reads that as "The Enigma" and settles glow at a middling 0.5. The
upstream's `pagination`, `token_address` and `realized_roi` never leave the
Worker; the response is rebuilt from an explicit field list, so a new upstream
field cannot leak by accident.

### Errors

```json
{ "error": "invalid_input" | "captcha_failed" | "rate_limited" | "budget_exhausted" | "upstream_error" }
```

| Code | Status | When |
|---|---|---|
| `invalid_input` | 400 | bad content type, body over 4 KB, unparseable JSON, unknown chain, malformed or deny-listed address, ENS/SNS name, missing captcha token |
| `invalid_input` | 403 | `Origin` missing or not on the allowlist |
| `captcha_failed` | 403 | Turnstile said no, or siteverify could not be reached (fails closed) |
| `rate_limited` | 429 | over 6/min or over the per-IP daily cap. `Retry-After` is 60 or the seconds to the next UTC midnight |
| `budget_exhausted` | 503 | the global daily budget is spent. `Retry-After` counts down to UTC midnight |
| `upstream_error` | 502 | Nansen timed out, refused, or answered unparseable JSON |

Upstream error bodies and request ids are never relayed.

## Pipeline

Ordered by cost, cheapest first — everything decidable from the request alone is
decided before a byte leaves the Worker.

1. method / path / `Content-Type` / body ≤ 4 KB
2. `Origin` on the allowlist
3. input validation — chain enum, per-chain regex, deny list, `.eth`/`.sol`
4. `IP_LIMITER` — 6 per minute per IP
5. Turnstile `siteverify`
6. KV cache lookup → a hit returns here with `cached: true` and charges nothing
7. `COUNTERS` Durable Object — per-IP daily cap and the global budget, in one atomic call
8. Nansen `pnl-summary`, 8 s timeout, no retry
9. blank guard — a row of all zeroes is an absence, not a flat trader
10. whitelist, write to KV, respond

Step 6 sits behind Turnstile on purpose: the cache is not a free read endpoint
for anyone who wants to enumerate wallets. Step 7 sits after it on purpose too —
hammering one address is free, which is exactly the behaviour to encourage.

## Local development

No Cloudflare account and no `wrangler login` needed. `wrangler dev` runs the
whole thing — KV, the Durable Object, the rate limiter — in a local `workerd`.

```bash
npm install
cp .dev.vars.example .dev.vars     # already contains the public Turnstile test key
npm run dev                        # http://localhost:8788
npm test                           # unit tests, no wrangler involved
```

Port 8788 is pinned in `wrangler.jsonc` because the aquarium's static dev server
(`npm run dev` in the parent directory) already owns 8787.

`.dev.vars` sets `MOCK_NANSEN=1`. **Keep it that way.** Local work must never
reach `api.nansen.ai`: the key is shared with the cron, and its failure
allowance is small. In mock mode `src/nansen.js` answers from six deterministic
profiles in the real upstream shape, so the blank guard and the whitelist run
over exactly the fields production will see.

### Turnstile test keys

Cloudflare publishes secrets that always give the same verdict. They are safe to
commit and they work against the real `siteverify` endpoint (so `wrangler dev`
does need outbound network for step 5):

| Secret | Verdict |
|---|---|
| `1x0000000000000000000000000000000AA` | always passes |
| `2x0000000000000000000000000000000AA` | always fails |
| `3x0000000000000000000000000000000AA` | "token already spent" |

With the always-pass secret, any non-empty token string is accepted — curl can
send `"test-token"`.

### Reserved mock addresses

Two addresses always come back as blank wallets, so the no-history path can be
exercised without hunting for a real empty one. Both are valid for their chain
and pass the deny list, so they walk the entire pipeline:

| Chain | Address |
|---|---|
| robinhood | `0x00000000000000000000000000000000000000ee` |
| solana | `EggEnigma1111111111111111111111111111111111` |

Every other address is hashed to one of six profiles — big winner, loser,
scalper, tiny wallet, mixed, and one with history but a `null` win rate — so the
same address always hatches the same fish.

### curl

```bash
BASE=http://localhost:8788
ORIGIN='Origin: http://localhost:8787'
JSON='Content-Type: application/json'

curl -s $BASE/v1/health

curl -s -X POST $BASE/v1/hatch -H "$JSON" -H "$ORIGIN" \
  -d '{"chain":"robinhood","address":"0x1f9090aaE28b8a3dCeaDf281B0F12828e676c326","token":"test-token"}'

# same address again → "cached": true, and no counter moves
curl -s -X POST $BASE/v1/hatch -H "$JSON" -H "$ORIGIN" \
  -d '{"chain":"robinhood","address":"0x1f9090aaE28b8a3dCeaDf281B0F12828e676c326","token":"test-token"}'

# The Enigma
curl -s -X POST $BASE/v1/hatch -H "$JSON" -H "$ORIGIN" \
  -d '{"chain":"solana","address":"EggEnigma1111111111111111111111111111111111","token":"test-token"}'

# rejected before anything is spent
curl -s -X POST $BASE/v1/hatch -H "$JSON" -H "$ORIGIN" \
  -d '{"chain":"ethereum","address":"0x1f9090aae28b8a3dceadf281b0f12828e676c326","token":"test-token"}'
```

### Exercising the limits

Override any var on the command line — `--var` beats `.dev.vars`:

```bash
npx wrangler dev --var TURNSTILE_SECRET_KEY:2x0000000000000000000000000000000AA   # → 403 captcha_failed
npx wrangler dev --var IP_DAILY_LIMIT:2                                          # → 3rd uncached request 429
npx wrangler dev --var DAILY_BUDGET:2                                            # → 3rd distinct address 503
```

The per-minute limiter counts every valid request, so it can fire before the
daily one during a burst. Vary the address to dodge the cache, and start from a
clean slate with `--persist-to <tmpdir>` — local KV and Durable Object state
otherwise survive a restart in `.wrangler/state`.

## Configuration

### Vars (`wrangler.jsonc`, non-secret)

| Var | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | the Pages site + `localhost:8787` + `127.0.0.1:8787` | comma-separated exact `Origin` matches |
| `DAILY_BUDGET` | `1000` | global Nansen calls per UTC day |
| `IP_DAILY_LIMIT` | `20` | calls per IP per UTC day |
| `CACHE_TTL_S` | `86400` | KV cache lifetime |
| `MOCK_NANSEN` | `0` | `1` answers from the local mock and never calls Nansen |

All are parsed defensively — a typo falls back to the default rather than
silently disabling a limit. Raising the budget is a one-line edit plus
`npx wrangler deploy`, or an env-var edit in the dashboard.

### Secrets (never in this repo)

| Secret | Used by |
|---|---|
| `NANSEN_API_KEY` | `src/nansen.js` — sent as the `apiKey` header |
| `TURNSTILE_SECRET_KEY` | `src/turnstile.js` — sent to `siteverify` |

### Bindings

| Binding | Kind | Why |
|---|---|---|
| `CACHE` | KV | response cache, one write per miss — which is what keeps it inside the 1,000 writes/day free tier |
| `COUNTERS` | Durable Object (SQLite) | per-IP daily and global budget counters. Exact, because KV's eventual consistency cannot hold a spend limit. SQLite-backed is mandatory: the free plan allows nothing else |
| `IP_LIMITER` | Rate Limiting (`unsafe.bindings`) | 6/min per IP. Counts per colocation, so it is a deterrent, not a guarantee — the exact numbers are the DO's job |

`unsafe.bindings` is still the only way to declare a Rate Limiting binding, so
wrangler prints a warning about it on every run. That warning is expected.

## Files

```
src/index.js     routing + the pipeline; re-exports CountersDO (wrangler needs it on the main module)
src/validate.js  chain enum, per-chain regex, deny list, normalization — pure, unit-tested
src/turnstile.js siteverify, failing closed on every uncertainty
src/limits.js    var parsing, UTC-midnight maths, the COUNTERS stub call
src/counters.js  CountersDO — one SQLite table, one atomic charge
src/nansen.js    the upstream call, the mock, the blank guard, the whitelist
test/            node --test over the pure parts
```

`src/validate.js` and `src/nansen.js` deliberately duplicate `scripts/fetch.mjs`
rather than importing from it — the Worker ships to a different runtime and must
not depend on the Node fetcher's file layout. The deny list, `normAddr`, and the
blank guard are line-for-line the same logic; if one changes, change both.

## Deploying

### Human-only (Claude does not run these)

1. **Create the Turnstile widget** in the Cloudflare dashboard (Managed,
   invisible). The sitekey is a public value for the front end; the secret goes
   in as a Worker secret.
2. **`npx wrangler login`** — opens a browser.
3. **Create the KV namespace** and paste the id it prints into the `CACHE`
   binding in `wrangler.jsonc`, replacing `LOCAL_PLACEHOLDER`:
   ```bash
   npx wrangler kv namespace create CACHE
   ```
4. **Put the secrets in.** Both prompt for a hidden value — do not echo them, do
   not pass them on the command line, do not paste them into a chat:
   ```bash
   npx wrangler secret put NANSEN_API_KEY
   npx wrangler secret put TURNSTILE_SECRET_KEY
   ```
   The project's `deploy-guide-ja.md` has the no-echo pipeline for this.
5. **First deploy**, then note the `*.workers.dev` URL:
   ```bash
   npx wrangler deploy
   ```
6. Put that URL in `src/config.js` on the front end. While it is an empty string
   the hatch feature stays off and the site falls back to the existing modal, so
   a Worker outage never touches the tank itself.

### After that

`npm run deploy` handles subsequent releases. Secrets persist across deploys;
the KV id and the vars live in `wrangler.jsonc`. The first deploy also applies
the `v1` Durable Object migration that creates the SQLite class — it runs once
and is a no-op afterwards.

Check the live Worker with `GET /v1/health`, and watch it with
`npx wrangler tail`. A `DESIGN BUG: upstream 4xx` line there means a malformed
request slipped past `src/validate.js` and burned part of the shared key's
failure allowance — fix the validator, not the symptom.

## Compliance

`profiler/address/pnl-summary` is the only endpoint used, and it is ✅ Allowed
for redistribution with no attribution requirement. No `smart-money/*`, no
`address/labels`, no `tgm/pnl-leaderboard`, no `only_smart_money` filters. The
response whitelist is the enforcement point: `address_label` does not appear in
this endpoint's payload today, and the whitelist means it could not reach a
visitor if it ever did.
