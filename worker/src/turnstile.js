const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5000;

/**
 * Verify a Turnstile token with Cloudflare.
 *
 * Fails closed on every uncertainty — no secret bound, no token, siteverify
 * unreachable, a non-2xx answer, unparseable JSON — because the only thing
 * standing between a script and the Nansen credit balance is this check saying
 * no. An outage that blocks legitimate hatching is a bad afternoon; an outage
 * that waves everyone through is a drained API key.
 *
 * @param {string} token the `cf-turnstile-response` value from the client
 * @param {string|null} remoteip CF-Connecting-IP, if the edge gave us one
 * @returns {Promise<boolean>}
 */
export async function verifyTurnstile(secret, token, remoteip) {
  if (!secret) {
    console.error('CONFIG BUG: TURNSTILE_SECRET_KEY is not bound');
    return false;
  }
  if (typeof token !== 'string' || token.length === 0) return false;

  const form = new FormData();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteip) form.append('remoteip', remoteip);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(SITEVERIFY_URL, { method: 'POST', body: form, signal: ac.signal });
    if (!res.ok) {
      console.warn('turnstile siteverify HTTP', res.status);
      return false;
    }
    const data = await res.json();
    if (!data?.success) {
      // `error-codes` is Cloudflare's own enum, not user data, so it is safe to
      // log — but it never reaches the client, which only ever sees
      // "captcha_failed".
      console.warn('turnstile rejected:', (data?.['error-codes'] ?? []).join(',') || 'no-codes');
      return false;
    }
    return true;
  } catch (err) {
    console.warn('turnstile siteverify failed:', err?.name ?? 'error');
    return false;
  } finally {
    clearTimeout(timer);
  }
}
