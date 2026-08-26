import { SPECIES, variantPicker, creatureHTML, JELLY_HTML } from './sprites.js';
import { fmtUsd } from './feed.js';

const TURN_MS = 400;   // scaleX flip duration
const EDGE = 100;      // turn this far inside the viewport
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const easeOut = (p) => 1 - Math.pow(1 - p, 3);

const GLOW_BASE = 0.9;     // brightness() at glow 0
const GLOW_SPAN = 0.25;    // added at glow 1
const GLOW_BREATH = 0.08;  // +/- of the level, over the 4s glowPulse cycle

/**
 * Writes a creature's bioluminescence onto its element as the two ends of the
 * brightness breath. legend.js copies both custom properties straight off the
 * element, so a portrait is lit exactly like the creature it was opened from.
 * @param {HTMLElement} el
 * @param {number} glow 0..1, the wallet's win rate
 */
function setGlow(el, glow) {
  const level = GLOW_BASE + GLOW_SPAN * clamp(glow, 0, 1);
  el.style.setProperty('--b0', (level * (1 - GLOW_BREATH)).toFixed(3));
  el.style.setProperty('--b1', (level * (1 + GLOW_BREATH)).toFixed(3));
}

/**
 * Owns every living thing in #tank plus the ambient layer, and runs the single
 * rAF loop that everything else piggybacks on via onFrame().
 */
export function createTank(root, roster, { reduced = false } = {}) {
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
    // shift the horizontal slot half a deck so bands and lanes don't correlate
    return { band: at(n), lane: at((n + Math.ceil(count / 2)) % count) };
  };

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

  function build(data, { guest = false } = {}) {
    const spec = SPECIES[data.species] || SPECIES.fish;
    // which colourway it wears — mint when the wallet is up, pink when down
    const variant = pickVariant(data.species, data);
    const wUnit = spec.baseW * (0.6 + 0.7 * (data.size ?? 0.5));
    const w = Math.max(24, Math.round(wUnit * sizeScale()));
    const h = Math.round(w * spec.vh / spec.vw);
    const glowColor = variant ? variant.glow : spec.glow;

    const el = document.createElement('div');
    el.className = 'creature' + (guest ? ' guest' : '');
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
      crown: !guest && topWhale && data.address === topWhale.address,
    });
    body.querySelector('img').style.animationDelay = (-rand(0, 4)).toFixed(2) + 's';
    el.appendChild(body);
    root.appendChild(el);

    const place = guest ? { band: Math.random(), lane: Math.random() } : slot(data.species);
    const bandPos = place.band;
    const c = {
      data, guest, species: data.species, el, body, w, h, wUnit,
      spec, bandPos, bandHome: bandPos,
      speed: spec.speed * rand(0.8, 1.2),
      amp: rand(10, 16), period: rand(6, 9), phase: rand(0, Math.PI * 2),
      dir: Math.random() < 0.5 ? -1 : 1,
      speedMul: 1, mode: 'swim', returnT: 0, yOff: 0,
      seekFn: null, x: 0, y: 0, baseY: 0, sx: 0, sy: 0, speedBias: 0,
      yieldT: 0, turnCool: rand(0, 2),
    };
    c.face = -c.dir;
    layout(c);
    const runway = Math.max(0, tank.W - w - EDGE * 2);
    c.x = guest ? (c.dir > 0 ? -w - 40 : tank.W + 40) : EDGE + runway * place.lane;
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

      c.x = clamp(c.x + sx * SEP_PUSH * agi * dt, -c.w * 0.3, tank.W - c.w * 0.7);
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
        c.x = clamp(c.x + clamp(c.sx, -1, 1) * c.w * 0.35, EDGE * 0.4, Math.max(EDGE * 0.4, tank.W - c.w - EDGE * 0.4));
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

  tank.spawnGuest = (species, amountUsd) => {
    const c = build({ address: '', species, size: 0.5, glow: 0.6, trades_24h_usd: amountUsd || 0, win_rate: null }, { guest: true });
    return c;
  };

  tank.release = (c) => {
    if (c.guest) c.mode = 'exit';
    else { c.mode = 'return'; c.returnT = 0; c.yOff = c.y - swimY(c); }
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

  root.addEventListener('pointerover', (e) => {
    const el = e.target.closest?.('.creature');
    if (!el || !el.__creature || el.__creature === hovered) return;
    if (hovered) hovered.speedMul = 1;
    hovered = el.__creature;
    hovered.speedMul = 0.2;
    const d = hovered.data;
    const line2 = [d.win_rate != null ? `Win rate ${Math.round(d.win_rate * 100)}%` : null,
      `${fmtUsd(d.trades_24h_usd || 0)} today`].filter(Boolean).join(' · ');
    const loves = (d.top_tokens || []).slice(0, 3).filter(Boolean);
    chip.innerHTML = `<div class="chip-1">${short(d.address)} · ${cap(hovered.species)}</div>`
      + `<div class="chip-2">${line2}</div>`
      + (loves.length ? `<div class="chip-3">Loves: ${loves.map(esc).join(', ')}</div>` : '');
    chip.hidden = false;
  });

  // also called from outside when a modal takes over — a chip left hanging
  // under the overlay would otherwise wait for the next pointer move
  function clearHover() {
    if (hovered) hovered.speedMul = 1;
    hovered = null;
    chip.hidden = true;
  }
  tank.clearHover = clearHover;

  root.addEventListener('pointerout', (e) => {
    const el = e.target.closest?.('.creature');
    if (!el || el.__creature !== hovered) return;
    if (el.contains(e.relatedTarget)) return;
    clearHover();
  });

  function placeChip() {
    if (!hovered) return;
    const cx = hovered.x + hovered.w / 2;
    const x = clamp(cx - chip.offsetWidth / 2, 8, tank.W - chip.offsetWidth - 8);
    const y = Math.max(8, hovered.y - chip.offsetHeight - 14);
    chip.style.transform = `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0)`;
  }

  // ---- main loop ---------------------------------------------------------

  function step(c, dt) {
    if (c.mode === 'seek' && c.seekFn) {
      const d = c.seekFn(c);
      let vx = d.dx * 2.5, vy = d.dy * 2.5;
      const max = c.spec.speed * 8, m = Math.hypot(vx, vy);
      if (m > max) { vx *= max / m; vy *= max / m; }
      c.x += vx * dt;
      c.y += vy * dt;
      if (Math.abs(vx) > 6) c.dir = vx > 0 ? 1 : -1;
      c.y = clamp(c.y, 6, Math.max(6, tank.H - c.h - 6));
      c.x = clamp(c.x, -c.w * 0.3, tank.W - c.w * 0.7);
    } else if (c.mode === 'exit') {
      c.x += c.spec.speed * 2 * c.dir * dt;
      c.y = swimY(c);
      if (c.x > tank.W + 80 || c.x + c.w < -80) { tank.remove(c); return; }
    } else {
      // swim / return
      const margin = Math.min(EDGE, Math.max(10, (tank.W - c.w) / 2 - 6));
      if (c.dir < 0 && c.x < margin) c.dir = 1;
      else if (c.dir > 0 && c.x + c.w > tank.W - margin) c.dir = -1;
      c.x += c.speed * c.dir * c.speedMul * (1 + c.speedBias) * dt;
      if (c.mode === 'return') {
        c.returnT += dt;
        const p = Math.min(1, c.returnT / 2);
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
  let sepFrame = 0, sepDt = 0;
  function loop(now) {
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
      c.x = clamp(c.x, -c.w * 0.3, Math.max(0, tank.W - c.w * 0.7));
      if (c.mode !== 'seek') c.y = clamp(c.y, 6, Math.max(6, tank.H - c.h - 6));
      draw(c);
    }
    // widths changed, so the big silhouettes may have collided again
    if (resettle && !tank.list.some((c) => c.mode === 'seek')) settle(40);
  }
  let rTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rTimer);
    rTimer = setTimeout(() => measure({ resettle: true }), 120);
  });

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

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      clearTimeout(bubbleTimer);
    } else {
      last = performance.now();
      raf = requestAnimationFrame(loop);
      if (!reduced) bubbleTimer = setTimeout(bubbles, 1500);
    }
  });

  return tank;
}
