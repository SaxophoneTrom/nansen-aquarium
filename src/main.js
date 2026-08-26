import { BRAND_SVG } from './sprites.js';
import { createTank } from './tank.js';
import { createFeed } from './feed.js';
import { createReplay } from './events.js';
import { createLegend } from './legend.js';

const CHAIN = 'ethereum';
const CHAIN_LABEL = 'Ethereum';
const PREFILL = 3; // seed the panel so it is never empty on load

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

document.querySelector('.brand-icon').innerHTML = BRAND_SVG;
if (reduced) document.body.classList.add('reduced');

const json = (p) => fetch(p, { cache: 'no-store' }).then((r) => {
  if (!r.ok) throw new Error(`${p} → ${r.status}`);
  return r.json();
});

async function boot() {
  const [tankData, feedData] = await Promise.all([
    json(`./public/data/${CHAIN}/tank.json`),
    json(`./public/data/${CHAIN}/feed.json`),
  ]);

  const tankEl = document.getElementById('tank');
  const tank = createTank(tankEl, tankData.creatures, { reduced });
  const feed = createFeed(document.getElementById('feed-rows'), { chain: CHAIN_LABEL });

  // click a resident → its biography card. Guests are anonymous walk-ons, so
  // they have no story to tell and stay unclickable.
  const legend = createLegend({ chain: CHAIN });
  tankEl.addEventListener('click', (e) => {
    const el = e.target.closest?.('.creature');
    if (!el || !el.__creature || !el.__creature.data.address) return;
    tank.clearHover();
    legend.open(el.__creature);
  });

  const events = feedData.events; // already oldest-first
  const byAddr = new Map(tankData.creatures.map((c) => [c.address, c]));
  const guestSpecies = (u) => (u >= 100_000 ? 'shark' : u >= 20_000 ? 'dolphin' : 'fish');

  for (const evt of events.slice(0, PREFILL).reverse()) {
    const m = byAddr.get(evt.actor);
    feed.push({ ...evt, species: m ? m.species : guestSpecies(evt.amount_usd) }, { animate: false });
  }

  createReplay({ tank, feed, events, chain: CHAIN_LABEL }).start(PREFILL);
}

// ---- CTA ------------------------------------------------------------------

const ADDR = /^0x[a-fA-F0-9]{40}$/;
const ENS = /\.eth$/i;

const form = document.getElementById('cta-form');
const input = document.getElementById('cta-input');
const modal = document.getElementById('egg-modal');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = input.value.trim();
  if (!ADDR.test(v) && !ENS.test(v)) {
    input.classList.remove('bad');
    void input.offsetWidth; // restart the shake
    input.classList.add('bad');
    setTimeout(() => input.classList.remove('bad'), 700);
    input.focus();
    return;
  }
  try {
    localStorage.setItem('aquarium.pending_egg', JSON.stringify({ id: v, chain: CHAIN, at: Date.now() }));
  } catch { /* private mode — the modal still works */ }
  modal.hidden = false;
  requestAnimationFrame(() => modal.classList.add('show'));
});

function closeEgg() {
  modal.classList.remove('show');
  setTimeout(() => { modal.hidden = true; }, 260);
}
document.getElementById('egg-close').addEventListener('click', closeEgg);
modal.addEventListener('click', (e) => { if (e.target === modal) closeEgg(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeEgg(); });

// ---- chain tabs -----------------------------------------------------------

const toast = document.createElement('div');
toast.id = 'toast';
document.getElementById('stage').appendChild(toast);
let toastTimer = 0;

document.getElementById('chains').addEventListener('click', (e) => {
  const btn = e.target.closest('.chain');
  if (!btn || !btn.classList.contains('soon')) return;
  toast.textContent = btn.title || 'This tank opens soon';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
});

boot().catch((err) => {
  console.error('[aquarium]', err);
  toast.textContent = 'Could not load the tank data.';
  toast.classList.add('show');
});
