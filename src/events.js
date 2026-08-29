import { COIN_SVG } from './sprites.js';
import { fmtUsd } from './feed.js';

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const GAP = [2000, 4000];      // ms between replayed events
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

  // ---- deferred work ------------------------------------------------------
  //
  // A performance is a chain of delayed beats — a coin appears 470ms in, a pop
  // fires when it lands, the panel row goes out at the end — and a chain switch
  // can arrive in the middle of one. That is worse than it sounds: `layer` is
  // the #tank element itself, and main.js pours the next chain into the very
  // same node. So a beat that fires after the switch does not draw into a dead
  // tank, it drops a coin into the live one and writes the outgoing chain's
  // name into the new chain's feed.
  //
  // Hence: every deferred beat is booked here, and stop() cancels the lot.
  // Each callback checks once more on its way in, because a timer that has
  // already been handed to the event loop cannot be recalled — clearTimeout
  // wins the race in practice, `stopped` wins it in principle.

  const pending = new Set();
  const frameOffs = new Set();

  /** setTimeout, but it cannot outlive the replay. */
  function after(ms, fn) {
    if (stopped) return;
    const id = setTimeout(() => {
      pending.delete(id);
      if (stopped) return;
      fn();
    }, ms);
    pending.add(id);
  }

  /**
   * tank.onFrame, but it cannot outlive the replay either. tank.destroy() drops
   * its frame callbacks as well, so this is belt and braces — but the replay is
   * stopped *before* the tank is destroyed, and it should not need the tank to
   * finish a job it started.
   * @returns {() => void} unsubscribe, safe to call more than once
   */
  function onFrame(fn) {
    if (stopped) return () => {};
    const off = tank.onFrame((dt) => { if (!stopped) fn(dt); });
    const cancel = () => { frameOffs.delete(cancel); off(); };
    frameOffs.add(cancel);
    return cancel;
  }

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

  // The panel is shared between chains — the rows are rewritten, the element is
  // not — so this is the one place a stopped replay would be visibly wrong
  // rather than merely wasteful. Guarded directly, on top of the gates above.
  function feedRow(evt, species) {
    if (stopped) return;
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
        after(caught ? 240 : 460, () => el.remove());
      }
      if (caught) {
        const m = tank.mouthOf(c);
        c.el.classList.add('gulp');
        after(320, () => c.el.classList.remove('gulp'));
        sparkle(m.x, m.y);
        pop(tank.centerOf(c).x, c.y - 10, `+${fmtUsd(evt.amount_usd)} ${evt.token}`, 'buy');
      }
      // The trade happened either way, so the panel records it either way — a
      // missed interception just ends quietly instead of announcing itself.
      feedRow(evt, c.species);
      tank.release(c);
      after(caught ? 1200 : 500, done);
    };

    const off = onFrame((dt) => {
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
    after(470, () => c.el.classList.remove('shiver'));

    after(470, () => {
      const m = tank.mouthOf(c);
      const coin = coinEl(m.x, m.y);
      let cx = m.x, cy = m.y, t = 0, since = 0;
      const drift = rand(-40, 40);

      const off = onFrame((dt) => {
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
      after(1200, done);
    });
  }

  function playReduced(evt, c, done) {
    feedRow(evt, c ? c.species : guestSpecies(evt.amount_usd));
    if (c && c.guest) tank.remove(c);
    after(300, done);
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
    else if (guest) after(900, () => playSell(evt, c, done));
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
    // Stopping is final, and it has to be final for work already in flight, not
    // just for work not yet scheduled: the next beat of a half-finished
    // performance would otherwise land in the tank and the feed panel that now
    // belong to another chain. Once this returns, nothing this replay started
    // can run again.
    stop() {
      stopped = true;
      clearTimeout(timer);
      for (const id of pending) clearTimeout(id);
      pending.clear();
      for (const off of [...frameOffs]) off();
      frameOffs.clear();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
