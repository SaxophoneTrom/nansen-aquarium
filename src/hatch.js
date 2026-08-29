// The hatchery. An address goes in, an egg drifts down out of the dark, and a
// creature the visitor can release into the tank comes out. Everything with a
// key in it lives in worker/ — this module only ever speaks to POST /v1/hatch,
// and the only thing it can ask for is one wallet's PnL summary.
//
// Three beats, in strict order (design doc §5.2). The request leaves the moment
// the modal opens, and the animation is deliberately allowed to outlast it: a
// cache hit answers in forty milliseconds, and an egg that pops that fast reads
// as a glitch rather than a birth. So the reveal waits for the slower of the
// two — the read, or the story.

import { HATCH_API_BASE, TURNSTILE_SITE_KEY } from './config.js';
import { SPECIES, creatureHTML, variantPicker } from './sprites.js';
import { legendOf } from './legend.js';
import { glowRange } from './tank.js';
import { fmtUsd } from './feed.js';
import { chainById } from './chains.js';

// ---- timing ---------------------------------------------------------------

const PHASE1_MS = 2000;       // the egg drifts down
const PHASE2_MIN_MS = 3000;   // …and the read is never shorter than this
const MAX_WAIT_MS = 15000;    // past here the deep has swallowed the request
const TEASER_HOLD_MS = 600;   // so a slow answer's teasers are still readable
const LINE_MS = 1600;         // status line rotation
const FADE_MS = 260;          // matches #egg-modal's CSS transition
const TURNSTILE_MS = 10000;

// prefers-reduced-motion: no drift to watch, so there is nothing to wait for.
// The read still gets a beat, because a form that answers instantly reads as a
// form that did not do anything.
const PHASE1_REDUCED_MS = 0;
const PHASE2_REDUCED_MS = 1000;

// The page the Share button points at. Not location.href: a visitor sharing
// from a local checkout should still send people to the aquarium.
const SITE_URL = 'https://saxophonetrom.github.io/nansen-aquarium/';

// The Worker asks pnl-summary for one chain over this window — never `all`
// (worker/src/nansen.js, WINDOW_DAYS). So every number on the reveal card is
// this tank's chain and this many days, and the card has to say so: "Realized
// PnL −$48K" with nothing beside it reads as a whole wallet's whole life.
// If the Worker's window ever moves, this moves with it.
const WINDOW_DAYS = 90;

const READING_LINES = [
  'Counting the trades in your wake…',
  'Weighing what you kept and what you let go…',
  'Measuring the water you displace…',
  'Listening for the shape you swim in…',
];

// ---- pnl-summary → fish (design doc §5.3) ---------------------------------

const WHALE_USD = 10_000_000;
const SHARK_USD = 1_000_000;
const DOLPHIN_USD = 100_000;
const SIZE_MIN = 0.3;

// Fallback ladder for a wallet whose realized percent is too close to zero to
// divide by. Coarse on purpose — it only has to land a busy wallet above a
// quiet one, and a trade count says nothing about size beyond that.
const TRADE_TIERS = [
  [5000, 2_000_000],
  [1000, 300_000],
  [250, 60_000],
  [50, 20_000],
  [1, 10_000],
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fin = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * How much money this wallet moves, in dollars — the one number the whole
 * mapping hangs off. pnl-summary reports no volume, but realized PnL and the
 * percent it represents imply the cost basis behind it: $119k at 2.26% is a
 * wallet turning over about $5.3M.
 *
 * That percent collapses toward zero for a wallet that came out flat, and the
 * division blows up with it, so anything inside ±1e-6 falls back to the trade
 * count instead. A wallet with no history at all returns NaN, which every rule
 * below reads as "unknown" rather than "small".
 * @param {object} d a hatch payload (worker README, "Success")
 */
export function scaleOf(d) {
  const usd = d.realized_pnl_usd;
  const pct = d.realized_pnl_percent;
  if (fin(usd) && fin(pct) && Math.abs(pct) > 1e-6) return Math.abs(usd / pct);
  if (!fin(d.traded_times) || d.traded_times <= 0) return NaN;
  const tier = TRADE_TIERS.find(([trades]) => d.traded_times >= trades);
  return tier ? tier[1] : 10_000;
}

/** @param {number} scale from scaleOf() */
export const speciesOf = (scale) => (!fin(scale) ? 'fish'
  : scale >= WHALE_USD ? 'whale'
    : scale >= SHARK_USD ? 'shark'
      : scale >= DOLPHIN_USD ? 'dolphin' : 'fish');

/**
 * Absolute, not relative to the tank: $10k is the smallest a hatched fish gets
 * and $100M the largest, and everything between rides the log. A wallet the
 * profiler knows nothing about sits at the middle — an unknown is not a minnow.
 * @param {number} scale from scaleOf()
 */
export const sizeOf = (scale) => (!fin(scale) ? 0.5
  : scale <= 0 ? SIZE_MIN
    : clamp(SIZE_MIN + (1 - SIZE_MIN) * (Math.log10(scale) - 4) / 4, SIZE_MIN, 1));

/**
 * A hatch payload in the shape tank.json creatures wear, so legend.js,
 * sprites.js and the hover chip all read it without knowing where it came from.
 * `trades_24h_usd` is null and stays null: pnl-summary has no volume in it, and
 * a zero there would claim a quiet day rather than an absent number.
 * @param {object} p a hatch payload
 */
export function creatureFrom(p) {
  const scale = scaleOf(p);
  return {
    address: String(p.address || ''),
    species: speciesOf(scale),
    size: sizeOf(scale),
    glow: fin(p.win_rate) ? p.win_rate : 0.5,
    win_rate: fin(p.win_rate) ? p.win_rate : null,
    realized_pnl_usd: fin(p.realized_pnl_usd) ? p.realized_pnl_usd : null,
    realized_pnl_percent: fin(p.realized_pnl_percent) ? p.realized_pnl_percent : null,
    traded_times: fin(p.traded_times) ? p.traded_times : null,
    traded_token_count: fin(p.traded_token_count) ? p.traded_token_count : null,
    top_tokens: Array.isArray(p.top_tokens) ? p.top_tokens.filter((t) => typeof t === 'string') : [],
    trades_24h_usd: null,
  };
}

// ---- Turnstile ------------------------------------------------------------
// Loaded on the first hatch and never on page load: the aquarium itself must
// not pay for a script most visitors never trigger. One widget is rendered into
// the modal and reused, in `interaction-only` dress — it draws nothing unless
// Cloudflare decides this visitor has something to prove, and the container
// sits inside the card so that challenge has somewhere to appear.

const TURNSTILE_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

let scriptPromise = null;
let widgetId = null;
let inflight = null;   // the token currently being minted, if any

function loadTurnstile() {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TURNSTILE_SRC;
      s.async = true;
      s.defer = true;
      s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile_missing')));
      s.onerror = () => { scriptPromise = null; s.remove(); reject(new Error('turnstile_script')); };
      document.head.appendChild(s);
    });
    scriptPromise.catch(() => {});   // a rejection is a normal outcome here
  }
  return scriptPromise;
}

const deliver = (key, value) => {
  const p = inflight;
  inflight = null;
  if (p) p[key](value);
};

/**
 * One fresh token per submission. A retry resets the widget rather than
 * re-rendering it — a spent token is refused by siteverify, so every attempt
 * has to mint its own.
 * @param {HTMLElement} container
 */
async function captchaToken(container) {
  if (!TURNSTILE_SITE_KEY) return '';
  const ts = await loadTurnstile();
  deliver('reject', new Error('superseded'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => deliver('reject', new Error('turnstile_timeout')), TURNSTILE_MS);
    inflight = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
    try {
      if (widgetId === null) {
        widgetId = ts.render(container, {
          sitekey: TURNSTILE_SITE_KEY,
          appearance: 'interaction-only',
          theme: 'dark',
          retry: 'never',
          callback: (token) => deliver('resolve', token),
          // returning true says the page has handled it, so Turnstile leaves
          // its own error card out of the modal
          'error-callback': () => { deliver('reject', new Error('turnstile_error')); return true; },
          'timeout-callback': () => deliver('reject', new Error('turnstile_timeout')),
        });
      } else {
        ts.reset(widgetId);
      }
    } catch (err) {
      deliver('reject', err);
    }
  });
}

// ---- the call -------------------------------------------------------------

/** Anything the visitor should see as a gentle sentence rather than a status. */
class HatchError extends Error {
  constructor(status, code) {
    super(code || `http_${status}`);
    this.name = 'HatchError';
    this.status = status;
    this.code = code || null;
  }
}

// Nothing technical ever reaches the card: a 429 is a resting egg, not a rate
// limit, and everything unrecognised is murky water.
function messageFor(err) {
  if (err instanceof HatchError) {
    if (err.status === 429) return 'The egg is resting. Try again in a minute.';
    if (err.status === 503 && err.code === 'budget_exhausted') return 'The nursery is full for today. Come back tomorrow.';
  }
  return 'The deep is murky right now. Try again.';
}

// ---- small formatters (the legend card's rules, so a fish reads the same
//      before and after it is released) --------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const money = (v) => (v < 0 ? '−' : '') + fmtUsd(Math.abs(v));
const percent = (v) => (v < 0 ? '−' : '+') + (Math.abs(v) * 100).toFixed(2) + '%';
const shortAddr = (a) => {
  const head = /^0x/i.test(a) ? 10 : 8;
  return a.length > head + 9 ? a.slice(0, head) + '…' + a.slice(-8) : a;
};

const CHECK_SVG = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"></circle>'
  + '<path d="M4.5 8 L7 10.5 L11.5 5.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"'
  + ' stroke-linejoin="round" fill="none"></path></svg>';

// A colourway is stored alongside the fish so it wears the same light after a
// reload — but localStorage is the visitor's to edit, and the sprite name goes
// into an <img src>, so only a plain lowercase filename is ever honoured.
const SPRITE_NAME = /^[a-z][a-z_]{0,20}$/;
function savedVariant(v) {
  if (v === null) return null;
  return v && typeof v === 'object' && SPRITE_NAME.test(String(v.sprite)) && typeof v.glow === 'string'
    ? { sprite: v.sprite, glow: v.glow }
    : undefined;
}

/**
 * Wires the egg modal to the Worker for one chain, and remembers the fish that
 * comes out of it. Torn down and rebuilt on every chain switch, exactly like
 * the legend card and the feed.
 *
 * @param {{ tank: object, chain: string, parent?: HTMLElement,
 *           reduced?: boolean, say?: (msg: string) => void }} opts
 *   `chain` is the Nansen chain id — it picks the localStorage slot as well as
 *   what the Worker is asked for, so two chains keep two separate fish.
 */
export function createHatchery({
  tank,
  chain,
  parent = document.getElementById('stage'),
  reduced = false,
  say = () => {},
} = {}) {
  const modal = parent.querySelector('#egg-modal');
  const card = modal.querySelector('.egg-card');
  const stepsEl = modal.querySelector('.egg-steps');
  const artEl = modal.querySelector('.egg-art');
  const soonEl = modal.querySelector('.egg-soon');
  const flowEl = modal.querySelector('.egg-flow');
  const addrEl = flowEl.querySelector('.egg-addr');
  const titleEl = flowEl.querySelector('.egg-title');
  const subEl = flowEl.querySelector('.egg-sub');
  const teaserEl = flowEl.querySelector('.egg-teasers');
  const revealEl = modal.querySelector('.egg-reveal');
  const buttonsEl = modal.querySelector('.egg-buttons');
  const captchaEl = modal.querySelector('#egg-captcha');
  const btn = {
    release: modal.querySelector('#egg-release'),
    share: modal.querySelector('#egg-share'),
    retry: modal.querySelector('#egg-retry'),
    close: modal.querySelector('#egg-close'),
  };

  // one picker per hatchery, so a shoal of neutral fish still varies; the
  // chosen colourway travels with the creature into the tank and into storage
  const pick = variantPicker();

  // What the numbers on the card are actually about, written the way the rest
  // of the page writes a chain — chains.js is the only place that names one.
  const chainName = chainById(chain).name;
  const scope = `${chainName} · last ${WINDOW_DAYS} days`;

  const listeners = [];
  const on = (target, type, fn) => { target.addEventListener(type, fn); listeners.push([target, type, fn]); };

  const waits = new Set();
  /** A cancellable pause. Every await site re-checks `seq` afterwards, so a
   *  cancelled wait resolves into a flow that quietly stops. */
  const sleep = (ms) => new Promise((resolve) => {
    if (ms <= 0) { resolve(); return; }
    const rec = { timer: 0, resolve };
    rec.timer = setTimeout(() => { waits.delete(rec); resolve(); }, ms);
    waits.add(rec);
  });
  function cancelWaits() {
    for (const rec of waits) { clearTimeout(rec.timer); rec.resolve(); }
    waits.clear();
  }

  let seq = 0;            // bumped by every submit and every close
  let busy = false;       // a flow is between the egg and its reveal
  let controller = null;  // aborts the POST in flight
  let lineTimer = 0;
  let hideTimer = 0;
  let pending = null;     // { payload, data } waiting on Release
  let mine = null;        // the creature swimming as this visitor's own
  let lastAddress = '';
  let lastFocus = null;
  let dead = false;

  // ---- storage ----------------------------------------------------------

  const slot = `aquarium.my_fish.${chain}`;

  function persist(payload, data) {
    try {
      localStorage.setItem(slot, JSON.stringify({ ...payload, ...data, hatched_at: new Date().toISOString() }));
    } catch { /* private mode — the fish still swims, it just isn't remembered */ }
  }

  function readSaved() {
    try {
      const raw = localStorage.getItem(slot);
      if (!raw) return null;
      const s = JSON.parse(raw);
      return s && typeof s === 'object' && typeof s.address === 'string' && s.address ? s : null;
    } catch {
      return null;
    }
  }

  /** Puts the fish in the water and retires whichever one was there before. */
  function stock(data) {
    if (mine) { tank.remove(mine); mine = null; }
    mine = tank.addResident(data);
    return mine;
  }

  // ---- modal ------------------------------------------------------------

  function setStep(n) {
    stepsEl.hidden = n < 0;
    [...stepsEl.children].forEach((dot, i) => {
      dot.classList.toggle('on', i === n);
      dot.classList.toggle('done', i < n);
    });
  }

  function showButtons(names) {
    for (const [key, el] of Object.entries(btn)) el.hidden = !names.includes(key);
    buttonsEl.hidden = names.length === 0;
  }

  function openModal() {
    // A reopen during the fade-out has to re-arm the transition class as well,
    // or the card comes back at opacity 0 and stays there.
    clearTimeout(hideTimer);
    if (!lastFocus) lastFocus = document.activeElement;
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('show'));
    tank.clearHover();
  }

  /** Closes and abandons: a reveal left unreleased is simply discarded. */
  function closeModal() {
    seq += 1;
    busy = false;
    cancelWaits();
    stopLines();
    if (controller) { controller.abort(); controller = null; }
    pending = null;
    if (modal.hidden) return;
    modal.classList.remove('show');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      modal.hidden = true;
      revealEl.innerHTML = '';
      revealEl.hidden = true;
    }, FADE_MS + 20);
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }

  function stopLines() {
    clearInterval(lineTimer);
    lineTimer = 0;
  }

  // ---- phases -----------------------------------------------------------

  function showEgg(address) {
    card.dataset.phase = 'egg';
    setStep(0);
    artEl.hidden = false;
    soonEl.hidden = true;
    flowEl.hidden = false;
    revealEl.hidden = true;
    revealEl.innerHTML = '';
    teaserEl.hidden = true;
    teaserEl.innerHTML = '';
    addrEl.textContent = shortAddr(address);
    titleEl.textContent = 'An egg drifts down from the surface…';
    subEl.hidden = false;
    subEl.textContent = 'We found your wallet in the deep. Something is stirring inside.';
    showButtons([]);
    card.focus({ preventScroll: true });
  }

  function showReading() {
    card.dataset.phase = 'reading';
    setStep(1);
    titleEl.textContent = 'Reading your on-chain soul…';
    let i = 0;
    subEl.textContent = READING_LINES[0];
    stopLines();
    lineTimer = setInterval(() => {
      i = (i + 1) % READING_LINES.length;
      subEl.textContent = READING_LINES[i];
    }, LINE_MS);
  }

  /** One or two things the read actually found. A blank wallet gets none. */
  function showTeasers(p) {
    const found = [];
    if (fin(p.traded_times)) found.push(`${p.traded_times.toLocaleString('en-US')} trades scanned`);
    if (fin(p.win_rate)) found.push(`win rate ${Math.round(p.win_rate * 100)}%`);
    else if (fin(p.traded_token_count)) found.push(`${p.traded_token_count.toLocaleString('en-US')} tokens traded`);
    if (!found.length) return;
    teaserEl.innerHTML = found.slice(0, 2)
      .map((t) => `<li>${CHECK_SVG}<span>${esc(t)}</span></li>`).join('');
    teaserEl.hidden = false;
  }

  function revealHTML(d) {
    const spec = SPECIES[d.species] || SPECIES.fish;
    const { name, flavor } = legendOf(d);
    const gc = d.variant ? d.variant.glow : spec.glow;
    const [b0, b1] = glowRange(d.glow);
    const sw = Math.min(240, Math.round(132 * spec.vw / spec.vh));
    const sh = Math.round(sw * spec.vh / spec.vw);

    // Same rows and the same rules as the legend card — a hatched fish must not
    // describe itself one way here and another way once it is swimming.
    const stats = [
      ['Realized PnL', fin(d.realized_pnl_usd) ? money(d.realized_pnl_usd) : null, d.realized_pnl_usd < 0 ? 'neg' : 'pos'],
      ['Return', fin(d.realized_pnl_percent) ? percent(d.realized_pnl_percent) : null, d.realized_pnl_percent < 0 ? 'neg' : 'pos'],
      ['Win rate', fin(d.win_rate) ? Math.round(d.win_rate * 100) + '%' : null, ''],
      ['Trades', fin(d.traded_times) ? d.traded_times.toLocaleString('en-US') : null, ''],
      ['Tokens traded', fin(d.traded_token_count) ? d.traded_token_count.toLocaleString('en-US') : null, ''],
    ].filter(([, v]) => v != null);

    const loves = (d.top_tokens || []).filter(Boolean).slice(0, 3);

    return `<div class="egg-portrait" style="width:${sw}px;height:${sh}px;--sg:${gc}59;--b0:${b0};--b1:${b1}">`
      + `${creatureHTML(d.species, { variant: d.variant, mine: true })}</div>
      <div class="egg-you">You are…</div>
      <div class="egg-species">a ${esc(d.species.toUpperCase())}!</div>
      <div class="egg-legend">${esc(name)}</div>
      <div class="egg-wallet">${esc(shortAddr(d.address))}</div>
      <div class="egg-scope">${esc(scope)}</div>
      ${stats.length
    ? `<div class="legend-stats">${stats.map(([k, v, tone]) =>
      `<div class="legend-row"><span class="legend-k">${k}</span><span class="legend-v ${tone}">${v}</span></div>`).join('')}</div>`
    : '<div class="egg-blank">No trading history here — the deep keeps its secrets.</div>'}
      ${loves.length ? `<div class="legend-loves">Loves: ${loves.map(esc).join(', ')}</div>` : ''}
      <div class="legend-flavor">&#8220;${esc(flavor)}&#8221;</div>`;
  }

  function showReveal(payload) {
    const data = creatureFrom(payload);
    data.variant = pick(data.species, data);
    pending = { payload, data };

    stopLines();
    card.dataset.phase = 'reveal';
    setStep(2);
    artEl.hidden = true;
    flowEl.hidden = true;
    revealEl.innerHTML = revealHTML(data);
    revealEl.hidden = false;
    showButtons(['release', 'share']);
    card.scrollTop = 0;
    card.focus({ preventScroll: true });
    busy = false;
  }

  // The egg never dies. It sits there, uncracked, with one sentence and a way
  // to try again — nothing about statuses, limits or upstreams.
  function showError(err) {
    stopLines();
    card.dataset.phase = 'error';
    artEl.hidden = false;
    flowEl.hidden = false;
    revealEl.hidden = true;
    revealEl.innerHTML = '';
    teaserEl.hidden = true;
    teaserEl.innerHTML = '';
    titleEl.textContent = messageFor(err);
    subEl.hidden = true;
    subEl.textContent = '';
    showButtons(['retry', 'close']);
    busy = false;
  }

  // ---- the run ----------------------------------------------------------

  async function request(address) {
    const started = performance.now();
    const token = await captchaToken(captchaEl);

    const left = MAX_WAIT_MS - (performance.now() - started);
    if (left <= 0) throw new HatchError(0, 'timeout');

    controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), left);
    try {
      const res = await fetch(`${HATCH_API_BASE}/v1/hatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chain, address, token }),
        signal: controller.signal,
      });
      let body = null;
      try { body = await res.json(); } catch { /* a broken body is still a status */ }
      if (!res.ok) throw new HatchError(res.status, body && body.error);
      if (!body || typeof body !== 'object') throw new HatchError(502, 'upstream_error');
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  async function run(address) {
    const mySeq = ++seq;
    busy = true;
    lastAddress = address;
    pending = null;
    openModal();
    showEgg(address);

    const started = performance.now();
    const call = request(address);
    call.catch(() => {});   // awaited below; this only keeps the rejection quiet

    await sleep(reduced ? PHASE1_REDUCED_MS : PHASE1_MS);
    if (mySeq !== seq) return;
    showReading();

    let payload = null;
    let failure = null;
    try { payload = await call; } catch (err) { failure = err; }
    if (mySeq !== seq) return;

    if (payload) showTeasers(payload);

    // The floor is measured from submit, so a cache hit and a cold read tell
    // the same length of story.
    const floor = reduced
      ? PHASE1_REDUCED_MS + PHASE2_REDUCED_MS
      : PHASE1_MS + PHASE2_MIN_MS;
    const held = performance.now() - started;
    await sleep(Math.max(floor - held, payload && !reduced ? TEASER_HOLD_MS : 0));
    if (mySeq !== seq) return;

    if (failure) showError(failure);
    else showReveal(payload);
  }

  // ---- actions ----------------------------------------------------------

  function release() {
    if (!pending) return;
    const { payload, data } = pending;
    pending = null;
    stock(data);
    persist(payload, data);
    closeModal();
    say('Released. Look for the cracked shell.');
  }

  function share() {
    if (!pending) return;
    const { name } = legendOf(pending.data);
    // the chain belongs in the boast too — the fish was read off one tank
    const text = `My wallet hatched as ${name} — a ${pending.data.species} in the ${chainName} tank at the Nansen Aquarium.`;
    const url = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(SITE_URL)}`;
    window.open(url, '_blank', 'noopener');
  }

  // ---- wiring -----------------------------------------------------------

  on(btn.release, 'click', release);
  on(btn.share, 'click', share);
  on(btn.retry, 'click', () => { if (lastAddress) run(lastAddress); });
  on(btn.close, 'click', closeModal);
  on(modal.querySelector('.egg-x'), 'click', closeModal);
  on(modal, 'click', (e) => { if (e.target === modal) closeModal(); });
  on(document, 'keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

  // A fish hatched on an earlier visit is already this chain's, so it is back in
  // the water before the visitor sees the tank at all.
  const saved = readSaved();
  if (saved) {
    const data = creatureFrom(saved);
    const v = savedVariant(saved.variant);
    data.variant = v === undefined ? pick(data.species, data) : v;
    stock(data);
  }

  return {
    /** Start a hatch. Ignored while one is already under way. */
    submit(address) {
      if (dead || busy) return;
      run(address);
    },
    /** The pre-launch card, shown when config.js has no Worker to talk to. */
    soon() {
      if (dead) return;
      seq += 1;
      busy = false;
      cancelWaits();
      stopLines();
      openModal();
      card.dataset.phase = 'soon';
      setStep(-1);
      artEl.hidden = false;
      soonEl.hidden = false;
      flowEl.hidden = true;
      revealEl.hidden = true;
      showButtons(['close']);
      card.focus({ preventScroll: true });
    },
    close: closeModal,
    destroy() {
      if (dead) return;
      dead = true;
      closeModal();
      clearTimeout(hideTimer);
      modal.hidden = true;
      modal.classList.remove('show');
      revealEl.innerHTML = '';
      revealEl.hidden = true;
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
      listeners.length = 0;
      mine = null;   // the tank retires its own creatures on destroy
    },
  };
}
