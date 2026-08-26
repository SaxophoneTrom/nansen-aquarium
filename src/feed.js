import { miniIcon } from './sprites.js';

const MAX_ROWS = 5;

// The one money formatter in the app — feed rows, amount pops, hover chips and
// the legend card all read from it, so $1M is $1M wherever it is written.
// Positive amounts only: callers carrying a sign put it outside (see money() in
// legend.js).
export const fmtUsd = (v) => (v >= 1e6 ? '$' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  : v >= 1e3 ? '$' + Math.round(v / 1e3) + 'K'
  : '$' + Math.round(v));

function relTime(ts) {
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (!isFinite(s) || s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Live feed panel: newest row slides in on top, the sixth collapses away.
 * @param {HTMLElement} rowsEl  #feed-rows
 */
export function createFeed(rowsEl, { chain = 'Ethereum' } = {}) {
  function push(evt, { animate = true } = {}) {
    const species = evt.species || 'fish';
    const icon = miniIcon(species);
    const who = cap(species);
    const buy = evt.side === 'buy';
    const verb = buy ? 'fed' : 'spat out';
    const prep = buy ? 'to' : 'of';

    const row = document.createElement('div');
    row.className = 'feed-row' + (animate ? ' in' : '');
    row.innerHTML = `
      <div class="feed-ico" style="background:${icon.color}1f">${icon.svg}</div>
      <div class="feed-txt">
        <div class="feed-line"><b>${who}</b> ${verb} <span class="amt ${buy ? 'buy' : 'sell'}">${fmtUsd(evt.amount_usd)}</span> ${prep} ${esc(evt.token)}</div>
        <div class="feed-sub">${chain} · ${relTime(evt.ts)}</div>
      </div>`;

    rowsEl.prepend(row);
    if (animate) requestAnimationFrame(() => row.classList.remove('in'));

    const live = [...rowsEl.children].filter((el) => !el.classList.contains('out'));
    while (live.length > MAX_ROWS) {
      const old = live.pop();
      old.classList.add('out');
      // transitionend can be skipped (hidden tab); the timer guarantees cleanup
      setTimeout(() => old.remove(), 400);
    }
  }

  return { push };
}
