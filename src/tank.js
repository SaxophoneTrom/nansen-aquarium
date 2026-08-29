import { SPECIES, variantPicker, creatureHTML, JELLY_HTML } from './sprites.js';
import { fmtUsd } from './feed.js';

const TURN_MS = 400;   // scaleX flip duration
const EDGE = 100;      // turn this far inside the viewport

// A guest is a walk-on: it has one performance to swim in from off screen, take
// its coin and leave again, where a resident has all day. So it travels at a
// visitor's pace — which is still its *own* normal speed, and the feeding
// choreography never asks anything to beat that by more than FEED_HURRY.
const GUEST_PACE = 2;
const RETURN_S = [2, 3];   // s for the band anchor to ease home after a performance,
                           // the longer end for the creatures that ended furthest off it

const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

const GLOW_BASE = 0.9;     // brightness() at glow 0
const GLOW_SPAN = 0.25;    // added at glow 1
const GLOW_BREATH = 0.08;  // +/- of the level, over the 4s glowPulse cycle

/**
 * The two ends of the brightness breath for one glow level. Exported because
 * hatch.js lights its reveal portrait to the same numbers before the creature
 * it belongs to exists.
 * @param {number} glow 0..1, the wallet's win rate
 * @returns {[string, string]} the --b0 / --b1 pair
 */
export function glowRange(glow) {
  const level = GLOW_BASE + GLOW_SPAN * clamp(glow, 0, 1);
  return [(level * (1 - GLOW_BREATH)).toFixed(3), (level * (1 + GLOW_BREATH)).toFixed(3)];
}

/**
 * Writes a creature's bioluminescence onto its element as the two ends of the
 * brightness breath. legend.js copies both custom properties straight off the
 * element, so a portrait is lit exactly like the creature it was opened from.
 * @param {HTMLElement} el
 * @param {number} glow 0..1, the wallet's win rate
 */
function setGlow(el, glow) {
  const [b0, b1] = glowRange(glow);
  el.style.setProperty('--b0', b0);
  el.style.setProperty('--b1', b1);
}

/**
 * Owns every living thing in #tank plus the ambient layer, and runs the single
 * rAF loop that everything else piggybacks on via onFrame().
 */
export function createTank(root, roster, { reduced = false, poster = false } = {}) {
  const ambient = document.createElement('div');
  ambient.id = 'ambient';
  root.appendChild(ambient);

  const tank = {
    el: root, ambient, list: [], time: 0, reduced,
    W: root.clientWidth, H: root.clientHeight,
  };

  const frameCbs = new Set();
  tank.onFrame = (fn) => { frameCbs.add(fn); return () => frameCbs.delete(fn); };

  // ---- creature construction --------------------------------------------

  // one picker for the whole tank, so the neutral fish cycle runs across it
  const pickVariant = variantPicker();
  const topWhale = roster
    .filter((c) => c.species === 'whale')
    .sort((a, b) => b.trades_24h_usd - a.trades_24h_usd)[0];

  // spread each species evenly across its band and the width instead of
  // letting pure randomness pile everyone into one corner
  const total = {};
  roster.forEach((d) => { total[d.species] = (total[d.species] || 0) + 1; });
  const seq = {};
  const slot = (species) => {
    const count = Math.max(1, total[species] || 1);
    const n = (seq[species] = (seq[species] ?? -1) + 1);
    const span = 1 / count;
    const at = (k) => clamp((k + 0.5) * span + rand(-0.35, 0.35) * span, 0.02, 0.98);
    // A poster is cropped to a card, where the slack the even slices leave at
    // either end reads as a lopsided frame. So its lanes run end to end — the
    // outermost of each species starts against the edge instead of half a slice
    // inside it — and only the lanes do: the bands are shared with the tank.
    const edgeAt = (k) => clamp(count > 1 ? k / (count - 1) + rand(-0.2, 0.2) * span : 0.5, 0, 1);
    // shift the horizontal slot half a deck so bands and lanes don't correlate
    const k = (n + Math.ceil(count / 2)) % count;
    return { band: at(n), lane: poster ? edgeAt(k) : at(k) };
  };

  // How much water the opening tableau leaves at either end. EDGE is a swimming
  // margin — it is where a creature turns — and the poster still turns there;
  // it just starts closer in, so the shoal reaches both edges of the crop.
  const PLACE_EDGE = poster ? 18 : EDGE;

  // shrink everyone on narrow viewports so a whale still fits on a phone
  const sizeScale = () => clamp(tank.W / 1200, 0.45, 1);

  function resize(c) {
    const w = Math.max(24, Math.round(c.wUnit * sizeScale()));
    if (w === c.w) return;
    c.w = w;
    c.h = Math.round(w * c.spec.vh / c.spec.vw);
    c.el.style.width = c.w + 'px';
    c.el.style.height = c.h + 'px';
  }

  function build(data, { guest = false, mine = false } = {}) {
    const spec = SPECIES[data.species] || SPECIES.fish;
    // Which colourway it wears — mint when the wallet is up, pink when down. A
    // hatched fish arrives with its own already chosen, because the reveal card
    // showed the visitor that exact animal before they released it.
    const variant = data.variant !== undefined ? data.variant : pickVariant(data.species, data);
    const wUnit = spec.baseW * (0.6 + 0.7 * (data.size ?? 0.5));
    const w = Math.max(24, Math.round(wUnit * sizeScale()));
    const h = Math.round(w * spec.vh / spec.vw);
    const glowColor = variant ? variant.glow : spec.glow;

    const el = document.createElement('div');
    el.className = 'creature' + (guest ? ' guest' : '') + (mine ? ' mine' : '');
    el.style.width = w + 'px';
    el.style.height = h + 'px';
    el.style.setProperty('--gc', glowColor);
    // The glow is painted into the art, so the data speaks through exposure
    // instead: a high win rate burns brighter, and every creature breathes
    // +/-8% around its own level on a 4s cycle.
    setGlow(el, data.glow ?? 0.5);

    const body = document.createElement('div');
    body.className = 'body';
    body.innerHTML = creatureHTML(data.species, {
      variant,
      // the crown is the tank's own 24h lead and nobody else's — a hatched
      // whale is uncrowned however much it moves
      crown: !guest && !mine && topWhale && data.address === topWhale.address,
      mine,
    });
    body.querySelector('img').style.animationDelay = (-rand(0, 4)).toFixed(2) + 's';
    el.appendChild(body);
    root.appendChild(el);

    // The even-spread slots are handed out once, before the opening tableau is
    // settled; a guest or a hatched fish arrives long after that, so it takes a
    // spot at random and lets separation steering open the room for it.
    const place = guest || mine ? { band: Math.random(), lane: Math.random() } : slot(data.species);
    const bandPos = place.band;
    const c = {
      data, guest, species: data.species, el, body, w, h, wUnit,
      spec, bandPos, bandHome: bandPos,
      speed: spec.speed * rand(0.8, 1.2) * (guest ? GUEST_PACE : 1),
      amp: rand(10, 16), period: rand(6, 9), phase: rand(0, Math.PI * 2),
      dir: Math.random() < 0.5 ? -1 : 1,
      speedMul: 1, mode: 'swim', returnT: 0, returnS: RETURN_S[0], yOff: 0,
      feed: null, x: 0, y: 0, baseY: 0, sx: 0, sy: 0, speedBias: 0,
      yieldT: 0, turnCool: rand(0, 2),
    };
    c.face = -c.dir;
    layout(c);
    const runway = Math.max(0, tank.W - w - PLACE_EDGE * 2);
    c.x = guest ? (c.dir > 0 ? -w - 40 : tank.W + 40) : PLACE_EDGE + runway * place.lane;
    c.y = c.baseY;
    draw(c);
    tank.list.push(c);
    el.__creature = c;
    return c;
  }

  // baseY derives from the species band so resizes keep everyone in place
  function layout(c) {
    const [lo, hi] = c.spec.band;
    const cy = tank.H * (lo + (hi - lo) * c.bandPos);
    c.baseY = clamp(cy - c.h / 2, 8, Math.max(8, tank.H - c.h - 8));
  }

  const swimY = (c) => c.baseY + c.amp * Math.sin((Math.PI * 2 * tank.time) / c.period + c.phase);

  // ---- separation steering ----------------------------------------------
  // Personal space is an ellipse shaped like the sprite — wide and shallow —
  // so a crowded pair slides apart along whichever axis actually has room.
  // Three things resolve a squeeze, in ascending order of visibility:
  //   1. a direct nudge (x) and a drift of the band anchor (y);
  //   2. a swim-speed bias, so the one being shoved from behind eases off;
  //   3. if it is still being shoved backwards after a second or so, it veers —
  //      flips its heading and swims away. That last step is what breaks the
  //      head-on deadlock: two whales closing on each other saturate their
  //      band long before they clear, and a bias that can only slow them down
  //      settles into a stable, permanently overlapped standoff.
  const SEP_K = 1.05;       // personal space, × the pair's summed hull radii
  const SEP_PUSH = 20;      // px/s, strongest direct shove along x
  const SEP_LIFT = 18;      // px/s, strongest band drift along y
  const SEP_CAP = 1.7;      // ceiling on the summed push a creature may feel
  const SEP_BIAS = 0.55;    // ± fraction of swim speed while pressed
  const SEP_SLACK = 0.25;   // how far outside its band a creature may be pushed
  const SEP_HOME = 0.3;     // per second, easing back toward its own lane
  const YIELD_HOLD = 1.0;   // s of being shoved backwards before it veers off
  const YIELD_COOL = 5;     // s before the same creature may veer again

  // Sprite fractions are authored facing left, which is `face` = +1 (scaleX(1),
  // unmirrored); at face = -1 the sprite is flipped and u maps to 1 - u. This
  // slides the anchor across smoothly, mid-turn included.
  const mirrorX = (c, u) => u + (1 - 2 * u) * (1 - c.face) / 2;

  // Where the drawn body actually sits.
  const hullX = (c) => c.x + c.w * mirrorX(c, c.spec.hull.cx);
  const hullY = (c) => c.y + c.h * c.spec.hull.cy;

  // A minnow gets out of a whale's way, not the other way round: the pair's
  // push splits by silhouette area, and each creature dodges at a speed its own
  // species could plausibly manage. Whales stay stately, small fish scatter.
  const massOf = (c) => c.w * c.h;
  const agilityOf = (c) => clamp(c.spec.speed / 16, 0.55, 1.5);

  const onScreen = (c) => c.x + c.w > 0 && c.x < tank.W;
  // Performers still shoulder the crowd aside, but nothing shoves them: the
  // choreography stays exact and the shoal parts around a feeding wallet.
  const sepSolid = (c) => c.mode !== 'exit' && onScreen(c);
  const sepMovable = (c) => c.mode === 'swim' && onScreen(c);

  // How far this creature may swim before the edge logic turns it round.
  const turnMargin = (c) => Math.min(EDGE, Math.max(10, (tank.W - c.w) / 2 - 6));

  /**
   * Keeps a creature inside the tank without ever shoving it. A plain clamp
   * teleports a guest that is still half a body-length off screen straight to
   * the boundary; this one only ever tightens, so something already outside is
   * free to swim in at its own speed and is caught only once it is in.
   */
  function holdX(c, nx) {
    const lo = -c.w * 0.3, hi = tank.W - c.w * 0.7;
    return Math.min(Math.max(nx, Math.min(lo, c.x)), Math.max(hi, c.x));
  }

  /**
   * Accumulates the crowding each creature feels into c.sx / c.sy as a
   * dimensionless push — ±1 for a pair of equals in full contact, and up to
   * twice that for the lighter half of a mismatched pair. Shared by the live
   * loop and settle(); callers clamp it to whatever they can spend.
   */
  function pressure(list) {
    const n = list.length;
    for (let i = 0; i < n; i++) { list[i].sx = 0; list[i].sy = 0; }
    for (let i = 0; i < n; i++) {
      const a = list[i];
      if (!sepSolid(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = list[j];
        if (!sepSolid(b)) continue;
        const rx = (a.w * a.spec.hull.rx + b.w * b.spec.hull.rx) * SEP_K;
        const ry = (a.h * a.spec.hull.ry + b.h * b.spec.hull.ry) * SEP_K;
        let u = (hullX(a) - hullX(b)) / rx;
        let v = (hullY(a) - hullY(b)) / ry;
        let d = Math.hypot(u, v);
        if (d >= 1) continue;
        if (d < 1e-3) { u = i % 2 ? 1 : -1; v = 0; d = 1; }  // break an exact tie
        const push = 1 - d;
        const ux = (u / d) * push, uy = (v / d) * push;
        const ma = massOf(a), mb = massOf(b), mt = ma + mb;
        const ka = (2 * mb) / mt, kb = (2 * ma) / mt;   // equals 1 each for equals
        a.sx += ux * ka; a.sy += uy * ka;
        b.sx -= ux * kb; b.sy -= uy * kb;
      }
    }
  }

  function separate(dt) {
    pressure(tank.list);
    const ease = Math.min(1, SEP_HOME * dt);

    for (const c of tank.list) {
      if (!sepMovable(c)) { c.speedBias = 0; c.yieldT = 0; continue; }
      const [lo, hi] = c.spec.band;
      const bandH = Math.max(1, tank.H * (hi - lo));
      const sy = clamp(c.sy, -SEP_CAP, SEP_CAP), sx = clamp(c.sx, -SEP_CAP, SEP_CAP);
      const agi = agilityOf(c);

      // Vertical: ease the band anchor rather than y itself, so the sine bob
      // stays smooth — and always relax back toward the creature's own lane, so
      // a shove is a detour instead of a permanent exile against the band limit.
      c.bandPos = clamp(c.bandPos + (sy * SEP_LIFT * agi * dt) / bandH + (c.bandHome - c.bandPos) * ease,
        -SEP_SLACK, 1 + SEP_SLACK);
      layout(c);

      c.x = holdX(c, c.x + sx * SEP_PUSH * agi * dt);
      c.speedBias = clamp(sx, -1, 1) * c.dir * SEP_BIAS;

      // Being pushed against your own heading means you are swimming into
      // someone. Hold that for a beat and veer away — but only if there is
      // open water that way, or the edge logic would just flip you straight
      // back and the sprite would stutter.
      c.turnCool = Math.max(0, c.turnCool - dt);
      if (clamp(sx, -1, 1) * c.dir < -0.3) c.yieldT += dt; else c.yieldT = Math.max(0, c.yieldT - dt * 2);
      if (c.yieldT > YIELD_HOLD && !c.turnCool) {
        const nd = -c.dir;
        const m = turnMargin(c);
        const room = nd < 0 ? c.x > m + 20 : c.x + c.w < tank.W - m - 20;
        if (room) { c.dir = nd; c.speedBias = SEP_BIAS; c.turnCool = YIELD_COOL; }
        c.yieldT = 0;
      }
    }
  }

  // Big silhouettes need real daylight between them, which separation alone is
  // too gentle to open up — space them out along x when the layout is built.
  function spreadLarge() {
    for (const sp of ['whale', 'shark']) {
      const g = tank.list.filter((c) => !c.guest && c.species === sp).sort((a, b) => a.x - b.x);
      for (let i = 1; i < g.length; i++) {
        const prev = g[i - 1], cur = g[i];
        // each of the pair clears 0.8 of its own body, so the wider one rules
        const need = Math.max(prev.w, cur.w) * 0.8;
        const gap = (cur.x + cur.w / 2) - (prev.x + prev.w / 2);
        if (gap < need) cur.x += need - gap;
      }
      const last = g[g.length - 1];
      if (!last) continue;
      const over = last.x + last.w - (tank.W - 20);
      if (over > 0) for (const c of g) c.x = Math.max(20, c.x - over);
    }
  }

  // How far the band anchor may take a creature, in px, before it would leave
  // its own water or the tank.
  function yBounds(c) {
    const [lo, hi] = c.spec.band;
    const slack = tank.H * (hi - lo) * SEP_SLACK;
    const top = Math.max(8, tank.H * lo - c.h / 2 - slack);
    const bot = Math.max(top, Math.min(tank.H * hi - c.h / 2 + slack, tank.H - c.h - 8));
    return [top, bot];
  }

  /**
   * Resolves the opening tableau before the first paint, so the viewer never
   * watches the shoal untangle itself. Straight positional relaxation — far
   * blunter than the swimming steering, and it converges in a few dozen rounds.
   */
  function settle(rounds = 60) {
    spreadLarge();
    const list = tank.list.filter((c) => !c.guest);
    for (const c of list) c.y = swimY(c);

    for (let r = 0; r < rounds; r++) {
      pressure(list);
      let worst = 0;
      for (const c of list) {
        if (!c.sx && !c.sy) continue;
        worst = Math.max(worst, Math.abs(c.sx), Math.abs(c.sy));
        const [yLo, yHi] = yBounds(c);
        // half the penetration each, damped — overshoot would ring forever
        const xEdge = PLACE_EDGE * 0.4;
        c.x = clamp(c.x + clamp(c.sx, -1, 1) * c.w * 0.35, xEdge, Math.max(xEdge, tank.W - c.w - xEdge));
        c.y = clamp(c.y + clamp(c.sy, -1, 1) * c.h * 0.35, yLo, yHi);
      }
      if (worst < 0.01) break;
    }

    // fold the settled y back into the band anchor so the swim loop keeps it
    for (const c of list) {
      const [lo, hi] = c.spec.band;
      const bandH = Math.max(1, tank.H * (hi - lo));
      c.bandPos = clamp(c.bandPos + (c.y - swimY(c)) / bandH, -SEP_SLACK, 1 + SEP_SLACK);
      c.bandHome = c.bandPos;
      layout(c);
    }
    for (const c of tank.list) { c.y = swimY(c); c.sx = c.sy = 0; draw(c); }
  }

  function draw(c) {
    const f = Math.abs(c.face) < 0.02 ? (c.face < 0 ? -0.02 : 0.02) : c.face;
    c.el.style.transform = `translate3d(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px, 0) scaleX(${f.toFixed(3)})`;
  }

  // ---- helpers used by events.js ----------------------------------------

  tank.centerOf = (c) => ({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
  // sprite faces left, so the mouth sits on whichever side `face` points to
  tank.mouthOf = (c) => ({ x: c.x + c.w * mirrorX(c, c.spec.mouth.x), y: c.y + c.h * c.spec.mouth.y });
  tank.byAddress = (a) => tank.list.find((c) => !c.guest && c.data.address === a);

  /**
   * Drops one more creature into a tank that is already swimming — the
   * visitor's own fish, hatched from src/hatch.js. It goes through the same
   * build() every resident does, so it steers, breathes and opens a legend card
   * exactly like the rest; all that marks it out is a cracked eggshell and the
   * fact that it can never wear the crown.
   * @param {object} data a creature row in tank.json's shape
   * @returns {object} the creature, for whoever needs to retire it later
   */
  tank.addResident = (data) => build(data, { mine: true });

  tank.spawnGuest = (species, amountUsd) => {
    const c = build({ address: '', species, size: 0.5, glow: 0.6, trades_24h_usd: amountUsd || 0, win_rate: null }, { guest: true });
    return c;
  };

  /**
   * Hands a performer back to the shoal. Whatever the choreography left it —
   * mid-tank, nose up, facing whichever way it was — is simply where it is now:
   * nothing is restored to a remembered position. Only the band anchor eases
   * home, over RETURN_S, by holding the offset it ended on and letting it decay.
   * @param {object} c
   */
  tank.release = (c) => {
    c.feed = null;
    c.returnT = 0;
    c.yOff = c.y - swimY(c);
    c.returnS = clamp(Math.abs(c.yOff) / 40, RETURN_S[0], RETURN_S[1]);
    c.mode = c.guest ? 'exit' : 'return';
  };

  /**
   * Starts the buy choreography. `plan` is worked out in events.js from where
   * this creature was already headed — see stepFeed for what each field drives.
   * @param {object} c
   * @param {{ix: number, meetY: number, mill: number, deadline: number,
   *          coin: () => ({x: number, y: number}|null)}} plan
   */
  tank.beginFeed = (c, plan) => {
    c.feed = { t: 0, ...plan };
    c.mode = 'feed';
  };

  tank.remove = (c) => {
    const i = tank.list.indexOf(c);
    if (i >= 0) tank.list.splice(i, 1);
    c.el.remove();
  };

  // ---- hover -------------------------------------------------------------

  const chip = document.getElementById('hoverchip');
  let hovered = null;

  const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : 'Unknown wallet');
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  const onPointerOver = (e) => {
    const el = e.target.closest?.('.creature');
    if (!el || !el.__creature || el.__creature === hovered) return;
    if (hovered) hovered.speedMul = 1;
    hovered = el.__creature;
    hovered.speedMul = 0.2;
    const d = hovered.data;
    const line2 = [d.win_rate != null ? `Win rate ${Math.round(d.win_rate * 100)}%` : null,
      `${fmtUsd(d.trades_24h_usd || 0)} today`].filter(Boolean).join(' · ');
    const loves = (d.top_tokens || []).slice(0, 3).filter(Boolean);
    // address is escaped like every other data-derived string here — a fish
    // restored from localStorage carries whatever address the blob was edited to
    chip.innerHTML = `<div class="chip-1">${esc(short(d.address))} · ${cap(hovered.species)}</div>`
      + `<div class="chip-2">${line2}</div>`
      + (loves.length ? `<div class="chip-3">Loves: ${loves.map(esc).join(', ')}</div>` : '');
    chip.hidden = false;
  };
  root.addEventListener('pointerover', onPointerOver);

  // also called from outside when a modal takes over — a chip left hanging
  // under the overlay would otherwise wait for the next pointer move
  function clearHover() {
    if (hovered) hovered.speedMul = 1;
    hovered = null;
    chip.hidden = true;
  }
  tank.clearHover = clearHover;

  const onPointerOut = (e) => {
    const el = e.target.closest?.('.creature');
    if (!el || el.__creature !== hovered) return;
    if (el.contains(e.relatedTarget)) return;
    clearHover();
  };
  root.addEventListener('pointerout', onPointerOut);

  function placeChip() {
    if (!hovered) return;
    const cx = hovered.x + hovered.w / 2;
    const x = clamp(cx - chip.offsetWidth / 2, 8, tank.W - chip.offsetWidth - 8);
    const y = Math.max(8, hovered.y - chip.offsetHeight - 14);
    chip.style.transform = `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`;
  }

  // ---- the buy choreography ----------------------------------------------
  // A feeding wallet does not lunge. It carries on at its own swimming speed
  // toward a mark events.js read off the course it was already on, and only
  // once the coin is within FEED_ARC of its nose does it tip up and take it.
  // Every line below is an increment on the position the creature already had —
  // nothing here ever assigns one outright — so the performance can be joined
  // or abandoned on any frame without the picture jumping.
  const FEED_ARC = 120;    // px of horizontal gap that starts the rise
  const FEED_ARC_H = 170;  // …and the coin must be this close above the mark too,
                           // or a whale, 15s wide at that gap, would rise far too early
  const FEED_HURRY = 1.3;  // hardest a performer may push, × its own speed
  const FEED_EASE = 1.0;   // per second, how briskly the climb closes
  const FEED_HOME = 5;     // …and how briskly it settles back onto the swim line
  const FEED_VY = 70;      // px/s ceiling on it — over SINK, so a coin that got
                           // past the mark can still be run down
  const FEED_HOLD = 20;    // px of dither allowed once it is under the coin
  const FEED_DIVE = 110;   // px below the mark it will chase a coin it missed

  // The mouth sits on whichever side the creature faces, so it swings a body
  // length across the moment it turns. Steering on it therefore steers on
  // something that jumps, and the creature turns again, and again. Everything
  // below aims the body *centre* instead — which never jumps — and carries the
  // mouth's offset as a term. `mill` and the hold both have to clear that
  // offset, or a turn would immediately argue itself back.
  const swingOf = (c) => c.w * (0.5 - c.spec.mouth.x);

  function stepFeed(c, dt) {
    const f = c.feed;
    f.t += dt;
    const coin = f.coin();
    const swing = swingOf(c);
    const mid = c.x + c.w / 2;
    const nose = mid + c.dir * swing;

    // Aim at the coin once it is in reach, at the mark until then. `mill` is how
    // far past that it may drift before turning back: a creature that gets there
    // early spends the wait swimming a lazy figure over the spot rather than
    // parking on it, which is what a fish actually does.
    const arc = !!coin && Math.abs(coin.x - nose) < FEED_ARC && coin.y > f.meetY - FEED_ARC_H;
    const gap = (arc ? coin.x - c.dir * swing : f.ix) - mid;
    const slack = Math.max(arc ? FEED_HOLD : f.mill, Math.abs(swing) + 12);
    if (c.dir > 0 && gap < -slack) c.dir = -1;
    else if (c.dir < 0 && gap > slack) c.dir = 1;

    // Its own speed, hurried only if the coin would otherwise land first — and
    // never by more than FEED_HURRY, which is well under a dash.
    let v = c.speed * c.speedMul;
    const left = f.deadline - f.t;
    if (left > 0.2) v = clamp(Math.abs(gap) / left, v, c.speed * FEED_HURRY * c.speedMul);
    c.x = holdX(c, c.x + v * c.dir * dt);

    // The arc aims at the depth the coin was *planned* to arrive at, not at
    // wherever it happens to be — so the creature lifts its nose the last few
    // dozen px and lets the coin settle into it, instead of charging up to meet
    // one still near the surface. A coin that got past the mark is worth
    // following down, but only FEED_DIVE of it: nothing here drags a whale to
    // the floor of the tank after a coin it was never going to catch.
    //
    // Out of the arc the goal is simply the ordinary swim line, chased the same
    // rate-limited way rather than assigned — so drifting back out of range
    // eases the nose down instead of dropping it.
    const goalY = arc
      ? clamp(coin.y, f.meetY, f.meetY + FEED_DIVE) - c.h * c.spec.mouth.y
      : swimY(c);
    const move = (goalY - c.y) * Math.min(1, (arc ? FEED_EASE : FEED_HOME) * dt);
    c.y = clamp(c.y + clamp(move, -FEED_VY * dt, FEED_VY * dt), 6, Math.max(6, tank.H - c.h - 6));
  }

  // ---- main loop ---------------------------------------------------------

  function step(c, dt) {
    if (c.mode === 'feed' && c.feed) {
      stepFeed(c, dt);
    } else if (c.mode === 'exit') {
      c.x += c.speed * c.dir * dt;
      // A guest leaves from wherever it ate, on the same heading — the band it
      // was nominally assigned only reels its depth back in as it goes.
      c.returnT += dt;
      c.y = swimY(c) + c.yOff * (1 - easeOut(Math.min(1, c.returnT / c.returnS)));
      if (c.x > tank.W + 80 || c.x + c.w < -80) { tank.remove(c); return; }
    } else {
      // swim / return
      const margin = Math.min(EDGE, Math.max(10, (tank.W - c.w) / 2 - 6));
      if (c.dir < 0 && c.x < margin) c.dir = 1;
      else if (c.dir > 0 && c.x + c.w > tank.W - margin) c.dir = -1;
      c.x += c.speed * c.dir * c.speedMul * (1 + c.speedBias) * dt;
      if (c.mode === 'return') {
        c.returnT += dt;
        const p = Math.min(1, c.returnT / c.returnS);
        c.y = swimY(c) + c.yOff * (1 - easeOut(p));
        if (p >= 1) c.mode = 'swim';
      } else {
        c.y = swimY(c);
      }
    }

    const tgt = -c.dir;
    if (c.face !== tgt) {
      const stepv = (dt / (TURN_MS / 1000)) * 2;
      const diff = tgt - c.face;
      c.face += Math.sign(diff) * Math.min(stepv, Math.abs(diff));
    }
    draw(c);
  }

  let last = performance.now();
  let raf = 0;
  let dead = false;
  let sepFrame = 0, sepDt = 0;
  function loop(now) {
    if (dead) return;
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    tank.time += dt;
    if (!reduced) {
      sepDt += dt;
      if (++sepFrame % 3 === 0) { separate(sepDt); sepDt = 0; }   // ~20 Hz is plenty
      for (let i = tank.list.length - 1; i >= 0; i--) step(tank.list[i], dt);
    }
    for (const fn of frameCbs) fn(dt, tank.time);
    placeChip();
  }

  // ---- resize ------------------------------------------------------------

  function measure({ resettle = false } = {}) {
    tank.W = root.clientWidth;
    tank.H = root.clientHeight;
    for (const c of tank.list) {
      resize(c);
      layout(c);
      c.x = holdX(c, c.x);
      if (c.mode !== 'feed') c.y = clamp(c.y, 6, Math.max(6, tank.H - c.h - 6));
      draw(c);
    }
    // widths changed, so the big silhouettes may have collided again — but a
    // relaxation pass reseats everyone, which would tear a performance apart
    if (resettle && !tank.list.some((c) => c.mode === 'feed' || c.mode === 'return')) settle(40);
  }
  let rTimer = 0;
  const onResize = () => {
    clearTimeout(rTimer);
    rTimer = setTimeout(() => measure({ resettle: true }), 120);
  };
  window.addEventListener('resize', onResize);

  // ---- ambient: marine snow, jellyfish, bubbles ---------------------------

  for (let i = 0; i < 22; i++) {
    const s = document.createElement('div');
    s.className = 'snow';
    s.style.left = rand(0, 100).toFixed(2) + '%';
    s.style.width = s.style.height = rand(2, 4).toFixed(1) + 'px';
    s.style.animationDuration = rand(26, 52).toFixed(1) + 's';
    s.style.animationDelay = (-rand(0, 40)).toFixed(1) + 's';
    s.style.opacity = rand(0.12, 0.4).toFixed(2);
    ambient.appendChild(s);
  }

  for (const [left, top, dur, scale] of [[86, 52, 10, 1], [12, 66, 13, 0.7]]) {
    const j = document.createElement('div');
    j.className = 'jelly';
    j.style.left = left + '%';
    j.style.top = top + '%';
    j.style.animationDuration = dur + 's';
    j.style.setProperty('--s', scale);
    j.innerHTML = JELLY_HTML;
    ambient.appendChild(j);
  }

  let bubbleTimer = 0;
  function bubbles() {
    if (dead) return;
    const n = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const b = document.createElement('div');
      b.className = 'bubble';
      const size = rand(4, 10);
      b.style.width = b.style.height = size.toFixed(1) + 'px';
      b.style.left = rand(4, 96).toFixed(2) + '%';
      b.style.bottom = rand(6, 60).toFixed(0) + 'px';
      b.style.setProperty('--drift', rand(-28, 28).toFixed(0) + 'px');
      b.style.animationDelay = rand(0, 1.2).toFixed(2) + 's';
      b.addEventListener('animationend', () => b.remove());
      ambient.appendChild(b);
    }
    bubbleTimer = setTimeout(bubbles, rand(3000, 6000));
  }

  // ---- lifecycle ---------------------------------------------------------

  roster.forEach((d) => build(d));
  measure();
  settle();

  if (reduced) {
    raf = requestAnimationFrame(loop); // still needed for FX callbacks
  } else {
    raf = requestAnimationFrame(loop);
    bubbles();
  }

  const onVisibility = () => {
    if (dead) return;
    if (document.hidden) {
      cancelAnimationFrame(raf);
      clearTimeout(bubbleTimer);
    } else {
      last = performance.now();
      raf = requestAnimationFrame(loop);
      if (!reduced) bubbleTimer = setTimeout(bubbles, 1500);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  /**
   * Empties the tank and unhooks everything it owns, so another chain's roster
   * can be poured into the same #tank element. Anything mid-performance is torn
   * down with it — the replay that drives it is stopped first by the caller.
   */
  tank.destroy = () => {
    if (dead) return;
    dead = true;
    cancelAnimationFrame(raf);
    clearTimeout(bubbleTimer);
    clearTimeout(rTimer);
    frameCbs.clear();
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    root.removeEventListener('pointerover', onPointerOver);
    root.removeEventListener('pointerout', onPointerOut);
    clearHover();
    for (const c of tank.list) c.el.remove();
    tank.list.length = 0;
    ambient.remove();
    // coins, sparkles, trails and amount pops are parented straight to #tank
    for (const el of [...root.children]) el.remove();
  };

  return tank;
}
