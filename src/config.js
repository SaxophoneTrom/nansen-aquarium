// Hatchery endpoint + Turnstile site key. Setting the base to '' turns the CTA
// back into the "nursery opens soon" fallback, so the tank never breaks if the
// Worker has to come down.
//
// `1x00000000000000000000BB` is Cloudflare's published invisible always-pass
// TEST sitekey; worker/.dev.vars holds the matching always-pass test secret.
// The production site key is a public value by design — the secret half lives
// only in the Worker.
const DEV = ['localhost', '127.0.0.1'].includes(location.hostname);

export const HATCH_API_BASE = DEV
  ? 'http://localhost:8788'
  : 'https://aquarium-hatchery.saxo55.workers.dev';
export const TURNSTILE_SITE_KEY = DEV
  ? '1x00000000000000000000BB'
  : '0x4AAAAAAEgCWtiV-jbvhcX2';
