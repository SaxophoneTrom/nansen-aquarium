import { COIN_SVG } from './sprites.js';
import { fmtUsd } from './feed.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const GAP = [4500, 9000];      // ms between replayed events
const SINK = 60;               // coin sink speed px/s
const COIN_Y0 = -60;           // where a buy coin enters, above the tank
const COIN_WOBBLE = 9;         // px of sway on the way down
const CATCH = 40;              // capture radius px
const COIN_LIFE = 14;          // s after the drop before the coin gives up
const POP_RISE = 54;           // px the amount pop travels up — matches @keyframes popUp
const POP_TOP = 80;            // header band the pop must never enter
const POP_PAD = 8;             // breathing room against the viewport edges
const COIN_BAND = 0.28;        // buy coins want to drop inside [W*0.28, W*0.72] …
const COIN_EDGE = 0.10;        // … and never outside [W*0.10, W*0.90]
const LEAD = [3, 4];           // s of ordinary swimming the mark is read off
const TRAVEL = [9, 13];        // s a resident / a guest may spend reaching it
const LIFT = [36, 68];         // px it rises off its lane to take the coin
const MILL = [26, 110];        // px it may drift past the mark while it waits
const MISSED = 150;            // px below the mark a coin sinks before it is written off
const TURN_S = 0.4;            // the scaleX flip, matching TURN_MS in tank.js

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

  /**
   * Works out where this wallet and its coin should meet.
   *
   * The mark is read off the course the creature is already on — where its
   * mouth would be after LEAD seconds of ordinary swimming — and then pulled
   * into the middle of the tank so the feeding plays in view. Three things can
   * move it from there, in order:
   *
   *   · the middle band can land it *behind* the creature, which is fine: it
   *     turns, and the swim back is what burns the coin's fall;
   *   · nothing swims faster than it swims — a whale covers 8px a second — so
   *     the mark is finally cut back to somewhere this creature can honestly
   *     be inside its travel budget, even if that is short of the band;
   *   · if it will still arrive early, the surplus becomes `mill`: how far past
   *     the mark it may drift before turning back, so the wait is spent
   *     swimming rather than parked.
   *
   * The coin is then dropped `delay` seconds late so its fall and that swim
   * finish together. tank.js absorbs whatever error is left.
   *
   * The mark comes back twice over: `coinX` is where the *mouth* has to be, and
   * so where the coin is offered; `ix` is the same place expressed for the body
   * centre, which is what tank.js can actually steer on without the mouth
   * swinging out from under it every time the creature turns.
   * @param {object} c the performing creature
   * @returns {{ix: number, coinX: number, meetY: number, mill: number,
   *            deadline: number, delay: number}}
   */
  function planBuy(c) {
    const swing = c.w * (0.5 - c.spec.mouth.x);       // mouth, px ahead of the centre
    const mid = c.x + c.w / 2;
    const nose = mid + c.dir * swing;
    const rest = c.baseY + c.h * c.spec.mouth.y;      // where its mouth rides normally
    const meetY = clamp(rest - rand(LIFT[0], LIFT[1]), 64, tank.H - 56);
    const fall = (meetY - COIN_Y0) / SINK;            // s of falling before they meet

    const lo = tank.W * COIN_BAND, hi = tank.W * (1 - COIN_BAND);
    let coinX = clamp(nose + c.dir * c.speed * Math.max(rand(LEAD[0], LEAD[1]), fall), lo, hi);

    let turn = c.dir * (coinX - nose) < 0;
    if (turn) coinX = clamp(nose - c.dir * c.speed * Math.max(1, fall - TURN_S), lo, hi);

    coinX = clamp(coinX, tank.W * COIN_EDGE, tank.W * (1 - COIN_EDGE));
    const budget = (c.guest ? TRAVEL[1] : TRAVEL[0]) - (turn ? TURN_S : 0);
    coinX = clamp(coinX, nose - c.speed * budget, nose + c.speed * budget);

    turn = c.dir * (coinX - nose) < 0;
    const ix = coinX - (turn ? -c.dir : c.dir) * swing;
    const eta = (turn ? TURN_S : 0) + Math.abs(ix - mid) / c.speed;
    return {
      ix, coinX, meetY,
      mill: clamp((c.speed * Math.max(0, fall - eta)) / 2, MILL[0], MILL[1]),
      deadline: Math.max(eta, fall),
      delay: Math.max(0, eta - fall),
    };
  }

  // buy: the wallet swims on as it was, a coin sinks onto the spot it is headed
  // for, and it tips its nose up at the last moment and takes it
  function playBuy(evt, c, done) {
    const plan = planBuy(c);
    let coin = null, cx = plan.coinX, cy = COIN_Y0, t = 0, ct = 0, over = false;

    tank.beginFeed(c, { ...plan, coin: () => (coin ? { x: cx, y: cy } : null) });

    const settleUp = (caught) => {
      if (over) return;
      over = true;
      off();
      if (coin) {
        coin.classList.add(caught ? 'eaten' : 'lost');
        const el = coin;
        setTimeout(() => el.remove(), caught ? 240 : 460);
      }
      if (caught) {
        const m = tank.mouthOf(c);
        c.el.classList.add('gulp');
        setTimeout(() => c.el.classList.remove('gulp'), 320);
        sparkle(m.x, m.y);
        pop(tank.centerOf(c).x, c.y - 10, `+${fmtUsd(evt.amount_usd)} ${evt.token}`, 'buy');
      }
      // The trade happened either way, so the panel records it either way — a
      // missed interception just ends quietly instead of announcing itself.
      feedRow(evt, c.species);
      tank.release(c);
      setTimeout(done, caught ? 1200 : 500);
    };

    const off = tank.onFrame((dt) => {
      if (over) return;
      t += dt;
      if (!coin) {
        if (t < plan.delay) return;   // the swim is still catching the fall up
        coin = coinEl(cx, cy);
        return;
      }
      ct += dt;
      cy = COIN_Y0 + SINK * ct;
      cx = plan.coinX + COIN_WOBBLE * Math.sin(ct * 2.2);
      coin.style.transform = `translate3d(${cx.toFixed(1)}px, ${cy.toFixed(1)}px, 0)`;

      const m = tank.mouthOf(c);
      // Sinking well past the mark means the interception did not happen — call
      // it there rather than letting the coin ride all the way to the gravel.
      if (Math.hypot(cx - m.x, cy - m.y) < CATCH) settleUp(true);
      else if (ct > COIN_LIFE || cy > plan.meetY + MISSED || cy > tank.H + 80) settleUp(false);
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
    // A buy guest starts its performance the moment it is spawned: the mark is
    // taken from where it enters, so the course it swims in on is already the
    // course to the coin. A sell guest still gets a beat to appear first.
    if (reduced) playReduced(evt, c, done);
    else if (evt.side === 'buy') playBuy(evt, c, done);
    else if (guest) setTimeout(() => playSell(evt, c, done), 900);
    else playSell(evt, c, done);
  }

  function finish() {
    busy = false;
    schedule();
  }

  const onVisibility = () => {
    if (stopped) return;
    if (document.hidden) clearTimeout(timer);
    else if (!busy) schedule(1200);
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    start(fromIndex = 0) { idx = fromIndex; schedule(2000); },
    // Stopping is final: a chain switch throws this replay away and builds a
    // new one against the new tank, so the listener goes with it.
    stop() {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
