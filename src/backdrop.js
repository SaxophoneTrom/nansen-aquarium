// The water each chain swims in.
//
// Two layers sit between the god rays and the seabed, both well under the
// creatures: a colour wash that tips the whole tank towards a chain's palette,
// and a faint motif drawn in the app's own neon-line hand. They are meant to
// be noticed second — the fish read first, always — but they are meant to be
// noticed. The motif carries a wide outer glow so it lands as something
// bioluminescent a long way off rather than a watermark laid over the glass.
//
// Everything a chain needs is in BACKDROPS below, keyed by the ids in
// chains.js. A chain with no entry falls through to BASE: plain blue water and
// no motif. That is the whole reason the lookup exists — adding a tank to
// chains.js must never be able to break the background.
//
// The art is original. It abstracts what a chain *feels* like — a feather
// drifting down through the column, three shafts of light crossing it — and
// deliberately traces no brand mark. Colours borrow from each chain's palette
// and stop there.

// A feather, falling. Stroke-only so it reads as a sketch in the water rather
// than a cut-out: outline, rachis, and ten barbs a side swept back the way a
// feather's are when it is sinking. The viewBox is cropped to the art — give
// it slack on either side and the whole thing renders narrow enough to be
// mistaken for a blade of weed.
const FEATHER = `<svg class="motif-art motif-feather" viewBox="55 0 310 790" fill="none" aria-hidden="true">
<g stroke="currentColor" stroke-linecap="round" fill="none">
<!-- broken, not drawn: a continuous margin is what makes a shape this size read
     as a leaf. Interrupted, it reads as the ends of the barbs instead. -->
<path stroke-width="3" stroke-opacity=".55" stroke-dasharray="34 26" d="M210 26 C312.6 150 361.2 320 331.5 452 C311.3 546 258.6 612 210 660 C161.4 612 108.8 546 88.5 452 C58.8 320 107.4 150 210 26 Z"></path>
<path stroke-width="5.5" d="M210 26 C201.9 200 199.2 420 210 660 C212.7 700 215.4 730 218.1 762"></path>
<!-- Every barb runs past the outline rather than stopping at it: a vein stops
     at a leaf's margin, a barb does not, and that overshoot is the whole
     difference between the two readings at this size. -->
<g stroke-width="2.4" stroke-opacity=".85">
<path d="M210 95 C237.1 99.5 265.6 113.9 285.2 140"></path>
<path d="M210 150 C246.6 155 285.3 171 311.8 200"></path>
<path d="M210 210 C253.7 215.5 299.8 233.1 331.4 265"></path>
<path d="M210 270 C257.5 276 307.7 295.2 342.2 330"></path>
<path d="M210 330 C257.8 336.5 308.1 357.3 342.6 395"></path>
<path d="M210 390 C255.1 396.5 302.7 417.3 335.4 455"></path>
<path d="M210 450 C247.8 456.5 287.8 477.3 315.2 515"></path>
<path d="M210 505 C238.4 511 268.2 530.2 288.6 565"></path>
<path d="M210 550 C229 555.2 249.2 571.8 262.9 602"></path>
<path d="M210 580 C220.7 585 232 601 239.7 630"></path>
<path d="M210 95 C182.9 99.5 154.4 113.9 134.8 140"></path>
<path d="M210 150 C173.4 155 134.7 171 108.2 200"></path>
<path d="M210 210 C166.3 215.5 120.2 233.1 88.6 265"></path>
<path d="M210 270 C162.5 276 112.3 295.2 77.8 330"></path>
<path d="M210 330 C162.2 336.5 111.9 357.3 77.4 395"></path>
<path d="M210 390 C164.9 396.5 117.3 417.3 84.6 455"></path>
<path d="M210 450 C172.2 456.5 132.2 477.3 104.8 515"></path>
<path d="M210 505 C181.6 511 151.8 530.2 131.4 565"></path>
<path d="M210 550 C191 555.2 170.8 571.8 157.1 602"></path>
<path d="M210 580 C199.3 585 188 601 180.3 630"></path>
</g>
</g>
</svg>`;

// Three shafts of light, slanting across the column. The bodies are blurred in
// CSS and the leading edges left sharp, which is what makes them read as light
// through water instead of three painted bars. One gradient runs along all
// three so the colour travels with the beam, violet where it enters to teal
// where it dies out.
const BEAMS = `<svg class="motif-art motif-beams" viewBox="0 0 1200 700" fill="none" aria-hidden="true" preserveAspectRatio="xMidYMid meet">
<defs>
<linearGradient id="aqua-beam" gradientUnits="userSpaceOnUse" x1="0" y1="640" x2="1200" y2="60">
<stop offset="0" stop-color="#9945FF" stop-opacity="0"></stop>
<stop offset="0.18" stop-color="#9945FF" stop-opacity="1"></stop>
<stop offset="0.52" stop-color="#7A6BFF" stop-opacity="0.95"></stop>
<stop offset="0.82" stop-color="#14F195" stop-opacity="0.9"></stop>
<stop offset="1" stop-color="#14F195" stop-opacity="0"></stop>
</linearGradient>
</defs>
<g class="beam-body" fill="url(#aqua-beam)">
<path d="M0 600 L1200 336 L1200 402 L0 666 Z"></path>
<path d="M0 450 L1200 186 L1200 236 L0 500 Z"></path>
<path d="M0 300 L1200 36 L1200 74 L0 338 Z"></path>
</g>
<g class="beam-edge" stroke="url(#aqua-beam)" stroke-width="2.5" fill="none">
<path d="M0 600 L1200 336"></path>
<path d="M0 450 L1200 186"></path>
<path d="M0 300 L1200 36"></path>
</g>
</svg>`;

/**
 * Base blue: what an unknown chain gets. `shallow`/`deep` are the two wash
 * colours, `ink` tints the motif and its glow, `alpha` is how present the
 * motif is allowed to be. All four land on #stage as custom properties.
 */
const BASE = { shallow: 'transparent', deep: 'transparent', ink: '#4FD8FF', alpha: '.06', art: '' };

const BACKDROPS = {
  // Robin Neon: the electric yellow-green Robinhood moved to in 2025, dropped
  // several stops for depth. The hue is held around 75–80° on purpose — warmer
  // and it starts arguing with the gold the app already spends on the crown and
  // the hatch button, cooler and it is just the old green back again. The floor
  // stays greener than the surface because a yellow that dark reads as silt.
  robinhood: { shallow: 'rgba(202, 244, 62, .115)', deep: 'rgba(88, 132, 24, .21)', ink: '#C6F04C', alpha: '.13', art: FEATHER },
  // Violet at the surface, the same violet gone almost black on the floor. The
  // beams carry the violet→teal gradient themselves and lose a lot of it to the
  // blur, so their ink is only ever the glow — and the glow is what pulls the
  // tint up into the water they are crossing.
  solana: { shallow: 'rgba(153, 69, 255, .105)', deep: 'rgba(76, 30, 150, .25)', ink: '#C79BFF', alpha: '.14', art: BEAMS },
};

/**
 * Takes over the #backdrop element that index.html ships empty. One node, for
 * the life of the page: a chain switch rewrites the motif in place rather than
 * appending another layer, so nothing accumulates behind the tank.
 *
 * @param {HTMLElement} stage the #stage element — it carries `data-chain` and
 *        the custom properties the two layers read
 */
export function createBackdrop(stage) {
  const root = stage.querySelector('#backdrop');
  const motif = root ? root.querySelector('.motif') : null;

  return {
    /** Repaints the water for one chain. Unknown ids get BASE, never an error. */
    set(id) {
      const cfg = BACKDROPS[id] || BASE;
      stage.dataset.chain = id;
      stage.style.setProperty('--water-shallow', cfg.shallow);
      stage.style.setProperty('--water-deep', cfg.deep);
      stage.style.setProperty('--motif-ink', cfg.ink);
      stage.style.setProperty('--motif-alpha', cfg.alpha);
      if (motif) motif.innerHTML = cfg.art;
    },
  };
}
