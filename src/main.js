import { BRAND_SVG } from './sprites.js';
import { createTank } from './tank.js';
import { createFeed } from './feed.js';
import { createReplay } from './events.js';
import { createLegend } from './legend.js';
import { createBackdrop } from './backdrop.js';
import { createHatchery } from './hatch.js';
import { CHAINS, DEFAULT_CHAIN, chainById } from './chains.js';
import { HATCH_API_BASE } from './config.js';

const PREFILL = 3;   // seed the panel so it is never empty on load
const FADE_MS = 400; // half a swap: the old tank fades out, the new one fades in

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ?og=1 — poster mode, only ever loaded by the screenshot run that produces
// the link-preview card: interactive chrome hidden, wordmark on stage.
if (new URLSearchParams(location.search).has('og')) document.body.classList.add('og-mode');

document.querySelector('.brand-icon').innerHTML = BRAND_SVG;
if (reduced) document.body.classList.add('reduced');

const stage = document.getElementById('stage');
const tankEl = document.getElementById('tank');
const chainsEl = document.getElementById('chains');
const badgeEl = document.querySelector('.replay-badge');
const creditEl = document.getElementById('credit');
const input = document.getElementById('cta-input');
const backdrop = createBackdrop(stage);

const json = (p) => fetch(p, { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- toast ----------------------------------------------------------------

const toast = document.createElement('div');
toast.id = 'toast';
stage.appendChild(toast);
let toastTimer = 0;
function say(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

// ---- chain tabs -----------------------------------------------------------

for (const c of CHAINS) {
  const btn = document.createElement('button');
  btn.className = 'chain';
  btn.type = 'button';
  btn.dataset.chain = c.id;
  btn.textContent = c.tab;
  chainsEl.appendChild(btn);
}

// ---- the live scene -------------------------------------------------------

/** Everything one chain owns, torn down together when another is chosen. */
let scene = null;
/** The chain currently on screen, or being switched to. */
let current = null;
/** Bumped on every switch; a load that finishes after a newer one started is
 *  stale and drops its results on the floor instead of racing them onto the
 *  stage. This, plus the button guard below, is the double-load guard. */
let generation = 0;
let switching = false;

function teardown() {
  if (!scene) return;
  scene.replay.stop();
  scene.hatchery.destroy();
  scene.tank.destroy();
  scene.legend.destroy();
  scene.feed.clear();
  tankEl.removeEventListener('click', scene.onClick);
  scene = null;
}

function build(chain, tankData, feedData) {
  const tank = createTank(tankEl, tankData.creatures, { reduced });
  const feed = createFeed(document.getElementById('feed-rows'), {
    chain: chain.name,
    txUrl: chain.tx,
  });
  const legend = createLegend({ chain: chain.id });
  // owns the egg modal, and puts this chain's remembered fish back in the water
  const hatchery = createHatchery({ tank, chain: chain.id, reduced, say });

  // click a resident → its biography card. Guests are anonymous walk-ons, so
  // they have no story to tell and stay unclickable.
  const onClick = (e) => {
    const el = e.target.closest?.('.creature');
    if (!el || !el.__creature || !el.__creature.data.address) return;
    tank.clearHover();
    legend.open(el.__creature);
  };
  tankEl.addEventListener('click', onClick);

  const events = feedData.events; // already oldest-first
  const byAddr = new Map(tankData.creatures.map((c) => [c.address, c]));
  const guestSpecies = (u) => (u >= 100_000 ? 'shark' : u >= 20_000 ? 'dolphin' : 'fish');

  for (const evt of events.slice(0, PREFILL).reverse()) {
    const m = byAddr.get(evt.actor);
    feed.push({ ...evt, species: m ? m.species : guestSpecies(evt.amount_usd) }, { animate: false });
  }

  const replay = createReplay({ tank, feed, events, chain: chain.name });
  replay.start(PREFILL);

  scene = { tank, feed, legend, hatchery, replay, onClick };
}

/** Writes the chain's name everywhere the page says it out loud. */
function relabel(chain) {
  for (const btn of chainsEl.querySelectorAll('.chain')) {
    const on = btn.dataset.chain === chain.id;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-current', on ? 'true' : 'false');
  }
  document.title = `Nansen Aquarium — ${chain.name}`;
  badgeEl.title = `Replaying the last 24h of real DEX trades on ${chain.name}`;
  creditEl.innerHTML = 'Powered by <a href="https://app.nansen.ai/smart-money?ref=saxo55"'
    + ' target="_blank" rel="noopener"><b>Nansen API</b></a> · replaying the last 24h of'
    + ` real DEX trades on ${chain.name}`;
  input.placeholder = chain.placeholder;
}

/**
 * Swaps the tank over to another chain: the stage fades down, the old scene is
 * torn out, the new data is poured in and the stage comes back up. Total
 * 2 × FADE_MS. Re-entrant calls are refused outright, and a load that is
 * overtaken mid-flight is discarded by its generation stamp.
 */
async function loadChain(id, { first = false } = {}) {
  const chain = chainById(id);
  if (switching || (!first && chain.id === current)) return;

  switching = true;
  const gen = ++generation;
  const previous = current;
  current = chain.id;
  relabel(chain);
  if (!first) stage.classList.add('swapping');

  try {
    // the fade and the fetch race each other; the swap waits for the slower one
    const [tankData, feedData] = await Promise.all([
      json(`./public/data/${chain.id}/tank.json`),
      json(`./public/data/${chain.id}/feed.json`),
      first ? null : sleep(FADE_MS),
    ]);
    if (gen !== generation) return;
    teardown();
    // repainted here rather than in relabel(): the stage is at its darkest
    // between the two fades, which is where the motif wants to change hands.
    // The error path below never reaches this, so a failed switch keeps the
    // water belonging to the tank still on screen.
    backdrop.set(chain.id);
    build(chain, tankData, feedData);
    // one frame with the new tank laid out, then let the stage back up
    requestAnimationFrame(() => stage.classList.remove('swapping'));
  } catch (err) {
    console.error('[aquarium]', err);
    stage.classList.remove('swapping');
    say(`Could not load the ${chain.name} tank.`);
    // the tank on screen is still the old one, so the tabs go back to saying so
    if (previous && previous !== chain.id) {
      current = previous;
      relabel(chainById(previous));
    }
  } finally {
    if (gen === generation) switching = false;
  }
}

chainsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('.chain');
  if (!btn) return;
  if (switching) { say('Draining the tank…'); return; }
  loadChain(btn.dataset.chain);
});

// ---- CTA ------------------------------------------------------------------

const form = document.getElementById('cta-form');

// ENS and SNS both pass chains.js's `accepts` — the placeholder invites them —
// but resolving a name needs a resolver the Worker deliberately does not have.
// So they are turned away here rather than sent to a hatch that would 400.
const NAME = /\.(eth|sol)$/i;

function remember(v) {
  try {
    localStorage.setItem('aquarium.pending_egg', JSON.stringify({ id: v, chain: current, at: Date.now() }));
  } catch { /* private mode — the modal still works */ }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value.trim();
  // each chain spells an address its own way — EVM hex here, base58 on Solana
  if (!chainById(current).accepts(v)) {
    input.classList.remove('bad');
    void input.offsetWidth; // restart the shake
    input.classList.add('bad');
    setTimeout(() => input.classList.remove('bad'), 700);
    input.focus();
    return;
  }
  if (!scene) return;   // the tank is still filling; nothing to hatch into yet

  // No Worker configured: the site behaves exactly as it did before the
  // hatchery existed, which is also the graceful degradation if it goes down.
  if (!HATCH_API_BASE) {
    remember(v);
    scene.hatchery.soon();
    return;
  }
  if (NAME.test(v)) {
    say("Names aren't supported yet — paste the raw address");
    input.focus();
    return;
  }
  remember(v);
  scene.hatchery.submit(v);
});

loadChain(DEFAULT_CHAIN, { first: true });
