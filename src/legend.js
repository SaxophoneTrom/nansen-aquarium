// "Legend of the Deep" — the biography card that opens when a creature is
// clicked. Layout follows design/Legend.dc.html; every value is read off the
// creature's own tank.json row, so nothing here is hard-coded per wallet.

import { SPECIES, miniIcon } from './sprites.js';
import { fmtUsd } from './feed.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
// 0xae0f6a97…88f72b92 on an EVM chain, 8Hj4Kq2P…Vk3BmDw9 on Solana. The "0x" is
// scaffolding rather than address, so the hex head takes two extra characters
// to leave the same eight meaningful ones a base58 head shows.
const shortAddr = (a) => {
  const head = /^0x/i.test(a) ? 10 : 8;
  return a.length > head + 9 ? a.slice(0, head) + '…' + a.slice(-8) : a;
};
// fmtUsd only knows positive money, so the sign is carried outside it
const money = (v) => (v < 0 ? '−' : '') + fmtUsd(Math.abs(v));

/**
 * Rule-based epithets, checked top-down — the first match names the wallet.
 * Nulls never match: a missing stat must not read as a zero.
 */
const LEGENDS = [
  // First, because it is the one rule that reads an absence. A wallet the
  // profiler has no history for arrives with every stat null, and none of the
  // rules below can speak for a row that is empty — so the emptiness names it.
  { name: 'The Enigma',      flavor: 'Appeared from nowhere. Moves millions.',
    when: (d) => !fin(d.traded_times) },
  { name: 'The Unsinkable',  flavor: 'Rarely wrong. Never loud.',
    when: (d) => fin(d.win_rate) && d.win_rate >= 0.8 },
  { name: 'The Gambler',     flavor: 'Wins big. Loses bigger.',
    when: (d) => fin(d.win_rate) && d.win_rate <= 0.2 },
  // Rarity first: a hundred trades is common enough in this crowd that The
  // Restless swallowed most of the tank when it ran early. Deep Pocket and
  // Collector are the scarcer facts, so they get to speak before the tally.
  { name: 'The Deep Pocket', flavor: 'Moves markets without making waves.',
    when: (d) => fin(d.realized_pnl_usd) && d.realized_pnl_usd >= 500000 },
  { name: 'The Collector',   flavor: 'A little of everything, forever.',
    when: (d) => fin(d.traded_token_count) && d.traded_token_count >= 20 },
  { name: 'The Restless',    flavor: 'The tank never sleeps, and neither does this one.',
    when: (d) => fin(d.traded_times) && d.traded_times >= 100 },
  { name: 'The Survivor',    flavor: "Still swimming. That's the whole story.",
    when: (d) => fin(d.realized_pnl_usd) && d.realized_pnl_usd < 0 },
];
const CITIZEN = { name: 'Citizen of the Deep', flavor: 'Every legend starts somewhere.' };

/** @param {object} d a tank.json creature row */
export const legendOf = (d) => LEGENDS.find((l) => l.when(d)) || CITIZEN;

const CLOSE_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">'
  + '<path d="M2 2 L12 12 M12 2 L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';

const ARROW_SVG = '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">'
  + '<path d="M3 11 L11 3 M5 3 L11 3 L11 9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';

const FADE_MS = 150;

/**
 * Builds the modal shell once and re-renders its body per creature.
 * @param {{ parent?: HTMLElement, chain?: string }} opts chain is the Nansen
 *   chain id — it is what the "View on Nansen" link opens the profiler on.
 */
export function createLegend({ parent = document.getElementById('stage'), chain = 'robinhood' } = {}) {
  const modal = document.createElement('div');
  modal.id = 'legend-modal';
  modal.hidden = true;
  modal.innerHTML = `<div class="legend-card" role="dialog" aria-modal="true" aria-label="Legend of the Deep" tabindex="-1">
      <button class="legend-close" type="button" aria-label="Close">${CLOSE_SVG}</button>
      <div class="legend-body"></div>
    </div>`;
  parent.appendChild(modal);

  const card = modal.querySelector('.legend-card');
  const body = modal.querySelector('.legend-body');
  let hideTimer = 0;

  function render(c) {
    const d = c.data;
    const spec = SPECIES[c.species] || SPECIES.fish;
    const { name, flavor } = legendOf(d);
    const icon = miniIcon(c.species);
    // the individual's own glow (fish come in three colours), not the species default
    const gc = (c.el.style.getPropertyValue('--gc') || spec.glow).trim();
    // The painted sprites carry a wide glow halo, so the portrait is sized off
    // a taller box than the old flat silhouettes needed.
    const sw = Math.min(300, Math.round(176 * spec.vw / spec.vh));
    const sh = Math.round(sw * spec.vh / spec.vw);
    // and it is lit to the same level as the creature still swimming behind it
    const lit = ['--b0', '--b1'].map((k) => `${k}:${c.el.style.getPropertyValue(k) || ''}`).join(';');

    const stats = [
      ['Realized PnL', fin(d.realized_pnl_usd) ? money(d.realized_pnl_usd) : null, d.realized_pnl_usd < 0 ? 'neg' : 'pos'],
      ['Win rate', fin(d.win_rate) ? Math.round(d.win_rate * 100) + '%' : null, ''],
      ['Trades', fin(d.traded_times) ? d.traded_times.toLocaleString('en-US') : null, ''],
      ['Tokens traded', fin(d.traded_token_count) ? d.traded_token_count.toLocaleString('en-US') : null, ''],
      ['24h volume', fin(d.trades_24h_usd) ? fmtUsd(d.trades_24h_usd) : null, ''],
    ].filter(([, v]) => v != null);

    const loves = (d.top_tokens || []).filter(Boolean).slice(0, 3);
    const profile = `https://app.nansen.ai/profiler?address=${encodeURIComponent(d.address)}&amp;chain=${encodeURIComponent(chain)}&amp;ref=saxo55`;

    return `<div class="legend-kicker">LEGEND OF THE DEEP</div>
      <div class="legend-sprite" style="width:${sw}px;height:${sh}px;--sg:${gc}59;${lit}">${c.body.innerHTML}</div>
      <div class="legend-name">${esc(name)}</div>
      <div class="legend-addr">${esc(shortAddr(d.address))}</div>
      <div class="legend-badges">
        <span class="legend-pill" style="color:${icon.color};border-color:${icon.color}73;background:${icon.color}1a">${icon.svg}${cap(c.species)}</span>
      </div>
      <div class="legend-stats">${stats.map(([k, v, tone]) =>
        `<div class="legend-row"><span class="legend-k">${k}</span><span class="legend-v ${tone}">${v}</span></div>`).join('')}</div>
      ${loves.length ? `<div class="legend-loves">Loves: ${loves.map(esc).join(', ')}</div>` : ''}
      <div class="legend-flavor">&#8220;${esc(flavor)}&#8221;</div>
      <a class="legend-btn" href="${profile}" target="_blank" rel="noopener">View on Nansen ${ARROW_SVG}</a>`;
  }

  function open(c) {
    if (!c || !c.data || !c.data.address) return;   // guests have no wallet to tell a story about
    clearTimeout(hideTimer);
    body.innerHTML = render(c);
    card.scrollTop = 0;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('show'));
    card.focus({ preventScroll: true });
  }

  function close() {
    if (modal.hidden) return;
    modal.classList.remove('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { modal.hidden = true; body.innerHTML = ''; }, FADE_MS + 20);
  }

  modal.querySelector('.legend-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  const onKey = (e) => { if (e.key === 'Escape' && !modal.hidden) close(); };
  document.addEventListener('keydown', onKey);

  // a chain switch retires this card along with the creatures it described
  function destroy() {
    clearTimeout(hideTimer);
    document.removeEventListener('keydown', onKey);
    modal.remove();
  }

  return { open, close, destroy, get isOpen() { return !modal.hidden; } };
}
