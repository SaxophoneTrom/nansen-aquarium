import { COIN_SVG } from './sprites.js';
import { fmtUsd } from './feed.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const GAP = [4500, 9000];      // ms between replayed events
const SINK = 60;               // coin sink speed px/s
const CATCH = 40;              // capture radius px
const SEEK_TIMEOUT = 14;       // s — bail out if the fish never reaches the coin
const POP_RISE = 54;           // px the amount pop travels up — matches @keyframes popUp
const POP_TOP = 80;            // header band the pop must never enter
const POP_PAD = 8;             // breathing room against the viewport edges
const COIN_BAND = 0.28;        // buy coins drop inside [W*0.28, W*0.72], never at the edges

const guestSpecies = (usd) => (usd >= 100_000 ? 'shark' : usd >= 20_000 ? 'dolphin' : 'fish');

/**
 * Replays feed.json one event at a time. Only one performance runs at a
 * time; each one drives itself off the tank's rAF loop.
 */
export function createReplay({ tank, feed, events, chain = 'Ethereum' }) {
  const layer = tank.el;
  const reduced = tank.reduced;
  let idx = 0, timer = 0, busy = false, stopped = false;

  // ---- tiny DOM factories (everything is torn down when it finishes) ------

  function coinEl(x, y) {
    const el = document.createElement('div');
    el.className = 'coin';
    el.innerHTML = COIN_SVG;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    layer.appendChild(el);
    return el;
  }

  function sparkle(x, y) {
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + rand(-0.3, 0.3);
      const r = rand(22, 46);
      const s = document.createElement('div');
      s.className = 'sparkle';
      s.style.left = x + 'px';
      s.style.top = y + 'px';
      s.style.setProperty('--dx', (Math.cos(a) * r).toFixed(1) + 'px');
      s.style.setProperty('--dy', (Math.sin(a) * r).toFixed(1) + 'px');
      s.style.animationDelay = (i * 12) + 'ms';
      s.addEventListener('animationend', () => s.remove());
      layer.appendChild(s);
    }
  }

  // The pop is centred on x (translateX(-50%)) and rises POP_RISE px as it
  // fades, so both its width and its whole flight have to be kept on screen —
  // otherwise an event at the edge of the tank throws the label off the
  // viewport or up behind the header bar.
  function pop(x, y, text, tone) {
    const el = document.createElement('div');
    el.className = 'amt-pop ' + tone;
    el.textContent = text;
    el.addEventListener('animationend', () => el.remove());
    layer.appendChild(el);

    const half = el.offsetWidth / 2;   // measured before the first paint
    const loX = half + POP_PAD, hiX = tank.W - half - POP_PAD;
    const loY = POP_TOP + POP_RISE;    // highest start that keeps the flight clear of the header
    const hiY = Math.max(loY, tank.H - el.offsetHeight - POP_PAD);

    el.style.left = (hiX < loX ? tank.W / 2 : clamp(x, loX, hiX)).toFixed(1) + 'px';
    el.style.top = clamp(y, loY, hiY).toFixed(1) + 'px';
  }

  function trail(x, y) {
    const t = document.createElement('div');
    t.className = 'trail';
    t.style.left = x + 'px';
    t.style.top = y + 'px';
    t.addEventListener('animationend', () => t.remove());
    layer.appendChild(t);
  }

  // ---- performances -------------------------------------------------------

  function feedRow(evt, species) {
    feed.push({ ...evt, species, chain });
  }

  // buy: coin sinks from above, the wallet chases it down and gulps it
  function playBuy(evt, c, done) {
    // The coin is offered near the wallet, but always inside the middle band of
    // the tank — a fish loitering at the edge would otherwise drop the whole
    // performance half off screen. tank.W is re-read here so it follows resizes.
    const startX = clamp(tank.centerOf(c).x + rand(-200, 200), tank.W * COIN_BAND, tank.W * (1 - COIN_BAND));
    const coin = coinEl(startX, -60);
    let cx = startX, cy = -60, t = 0, captured = false;

    c.mode = 'seek';
    c.seekFn = () => {
      const m = tank.mouthOf(c);
      return { dx: cx - m.x, dy: cy - m.y };
    };

    const off = tank.onFrame((dt) => {
      if (captured) return;
      t += dt;
      cy += SINK * dt;
      cx = startX + 12 * Math.sin(t * 3.6);
      coin.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;

      const m = tank.mouthOf(c);
      const near = Math.hypot(cx - m.x, cy - m.y) < CATCH;
      const lost = t > SEEK_TIMEOUT || cy > tank.H + 80;
      if (!near && !lost) return;

      captured = true;
      off();
      coin.classList.add('eaten');
      setTimeout(() => coin.remove(), 240);

      if (near) {
        c.el.classList.add('gulp');
        setTimeout(() => c.el.classList.remove('gulp'), 320);
        sparkle(m.x, m.y);
      }
      const ctr = tank.centerOf(c);
      pop(ctr.x, c.y - 10, `+${fmtUsd(evt.amount_usd)} ${evt.token}`, 'buy');
      feedRow(evt, c.species);

      c.seekFn = null;
      tank.release(c);
      setTimeout(done, 1200);
    });
  }

  // sell: the wallet shivers, spits a coin out and it drifts up on a pink trail
  function playSell(evt, c, done) {
    c.el.classList.add('shiver');
    setTimeout(() => c.el.classList.remove('shiver'), 470);

    setTimeout(() => {
      const m = tank.mouthOf(c);
      const coin = coinEl(m.x, m.y);
      let cx = m.x, cy = m.y, t = 0, since = 0;
      const drift = rand(-40, 40);

      const off = tank.onFrame((dt) => {
        t += dt; since += dt;
        cy -= 95 * dt;
        cx += drift * dt;
        coin.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;
        coin.style.opacity = String(Math.max(0, 1 - t / 1.5));
        if (since > 0.08) { since = 0; trail(cx, cy); }
        if (t < 1.5) return;
        off();
        coin.remove();
      });

      const ctr = tank.centerOf(c);
      pop(ctr.x, c.y - 10, `−${fmtUsd(evt.amount_usd)} ${evt.token}`, 'sell');
      feedRow(evt, c.species);
      tank.release(c);
      setTimeout(done, 1200);
    }, 470);
  }

  function playReduced(evt, c, done) {
    feedRow(evt, c ? c.species : guestSpecies(evt.amount_usd));
    if (c && c.guest) tank.remove(c);
    setTimeout(done, 300);
  }

  // ---- scheduler ----------------------------------------------------------

  function schedule(ms) {
    clearTimeout(timer);
    if (stopped || document.hidden) return;
    timer = setTimeout(next, ms ?? rand(GAP[0], GAP[1]));
  }

  function next() {
    if (stopped || busy || !events.length) return;
    const evt = events[idx % events.length];
    idx++;
    busy = true;

    let c = tank.byAddress(evt.actor);
    let guest = false;
    if (!c) {
      if (reduced) { playReduced(evt, null, finish); return; }
      c = tank.spawnGuest(guestSpecies(evt.amount_usd), evt.amount_usd);
      guest = true;
    }

    const done = () => finish();
    if (reduced) playReduced(evt, c, done);
    else if (guest) setTimeout(() => (evt.side === 'buy' ? playBuy(evt, c, done) : playSell(evt, c, done)), 900);
    else if (evt.side === 'buy') playBuy(evt, c, done);
    else playSell(evt, c, done);
  }

  function finish() {
    busy = false;
    schedule();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else if (!busy) schedule(1200);
  });

  return {
    start(fromIndex = 0) { idx = fromIndex; schedule(2000); },
    stop() { stopped = true; clearTimeout(timer); },
  };
}
