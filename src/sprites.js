// Creature art. The bodies are painted sprites (public/sprites/*.webp, baked
// from the masters by scripts/prepare_sprites.py); the small chrome — crown,
// coin, feed-row icons, brand mark — stays SVG, which is sharper at 16-40px
// and tintable. All creatures face LEFT; tank.js mirrors with scaleX.
//
// `vw`/`vh` are the sprite's own pixel dimensions: they only ever set the
// element's aspect ratio, so they must match the files on disk. One entry
// covers every colourway of a species — the colourways are repaints of the
// same pose, and prepare_sprites.py bakes them to within a percent of each
// other — so `vw`/`vh`, `hull` and `mouth` are all shared.
//
// `hull` is the ellipse that covers the painted *body* — no tail, no fins, no
// glow halo — as a fraction of the sprite box. Separation steering keeps hulls
// apart rather than bounding boxes, so a minnow may tuck under a whale's tail
// (where the box is only halo anyway) but never swims through its belly.
// `mouth` is where a coin is caught and the gulp sparkles fire. Both are given
// for the sprite as authored, facing left, and are measured off the trimmed
// art — run `python3 scripts/prepare_sprites.py --debug` to redraw the grid +
// hull overlays these numbers came from.

const DIR = './public/sprites/';

export const SPECIES = {
  whale: {
    vw: 800, vh: 597, baseW: 268, speed: 8, glow: '#4FD8FF', band: [0.15, 0.35],
    hull: { cx: 0.40, cy: 0.57, rx: 0.36, ry: 0.29 },
    mouth: { x: 0.09, y: 0.51 },
  },
  shark: {
    vw: 620, vh: 345, baseW: 215, speed: 14, glow: '#4FD8FF', band: [0.35, 0.55],
    hull: { cx: 0.42, cy: 0.51, rx: 0.39, ry: 0.22 },
    mouth: { x: 0.05, y: 0.62 },
  },
  dolphin: {
    // the art is a mid-leap pose, levelled off by TILT below; hull and mouth
    // are given in the rotated frame, which is what the tank actually shows.
    // Its glow is cyan, not mint: mint now means "this wallet is up on the
    // day", so the plain dolphin — the one with no PnL — must not wear it.
    vw: 480, vh: 500, baseW: 150, speed: 18, glow: '#4FD8FF', band: [0.50, 0.70],
    hull: { cx: 0.47, cy: 0.47, rx: 0.33, ry: 0.33 },
    mouth: { x: 0.05, y: 0.46 },
  },
  fish: {
    vw: 260, vh: 203, baseW: 80, speed: 24, glow: '#6FF7D1', band: [0.25, 0.75],
    hull: { cx: 0.38, cy: 0.51, rx: 0.33, ry: 0.35 },
    mouth: { x: 0.06, y: 0.54 },
  },
};

// ---- colourways: the bioluminescence is the wallet's realized PnL --------
//
// Every species is painted several times over — same navy animal, different
// light. Mint means the wallet is up, the pink end means it is down, and the
// cool neutrals are for the ones with no PnL to report (guest walk-ons
// included, since they arrive with no wallet at all). Whales are exempt: their
// gold/blue split is already spoken for by the crown.

const MINT = '#6FF7D1';

// Cycled by index so a shoal of unknowns still has some variety to it.
export const FISH_NEUTRAL = [
  { sprite: 'fish_cyan', glow: '#4FD8FF' },
  { sprite: 'fish_lavender', glow: '#C77DFF' },
  { sprite: 'fish_pearl', glow: '#A5CEF8' },
];

const PNL_VARIANTS = {
  dolphin: { up: { sprite: 'dolphin_mint', glow: MINT }, down: { sprite: 'dolphin_rose', glow: '#FF8ED4' } },
  shark: { up: { sprite: 'shark_mint', glow: MINT }, down: { sprite: 'shark_magenta', glow: '#FF6FD8' } },
  fish: { up: { sprite: 'fish_mint', glow: MINT }, down: { sprite: 'fish_pink', glow: '#FF8ED4' } },
};

/**
 * A picker over the colourways, holding the neutral fish cursor. The cursor
 * only advances on a fish that actually wears a neutral colour, so three
 * unknowns in a shoal of hundreds still come out cyan / lavender / pearl
 * rather than landing on the same one by accident.
 * @returns {(species: string, data: object) => ({sprite: string, glow: string}|null)}
 *   null means "the species' own art" — a whale, or a dolphin/shark that has
 *   no PnL to colour it by.
 */
export function variantPicker() {
  let neutral = 0;
  return (species, data) => {
    const pnl = data && data.realized_pnl_usd;
    const set = PNL_VARIANTS[species];
    if (set && Number.isFinite(pnl) && pnl !== 0) return pnl > 0 ? set.up : set.down;
    if (species === 'fish') return FISH_NEUTRAL[neutral++ % FISH_NEUTRAL.length];
    return null;
  };
}

// The dolphin master leaps at ~35 deg; this brings it near horizontal while
// keeping a little lift. It rides on the <img>, never the .creature element,
// so it composes with the scaleX turn instead of fighting it.
const TILT = { dolphin: -22 };

const img = (name, species) => `<img class="sprite" src="${DIR}${name}.webp" alt="" draggable="false"`
  + (TILT[species] ? ` style="transform:rotate(${TILT[species]}deg)"` : '') + '>';

// The gold whale's art has no crown, so the top-volume wallet gets one pinned
// above its head. Percentages are of the sprite box, and it lives inside
// .body so the legend modal picks it up with the rest of the creature.
const CROWN = '<svg class="crown" viewBox="76 4 40 30" fill="none" aria-hidden="true">'
  + '<path d="M78 8 L86 24 L96 10 L106 24 L114 8 L112 32 L80 32 Z" fill="#FFD166"></path></svg>';

/**
 * The inner markup of a creature's `.body`.
 * @param {'whale'|'shark'|'dolphin'|'fish'} species
 * @param {{ variant?: object, crown?: boolean }} opts variant as returned by
 *   variantPicker(); absent or null falls back to the species' own art
 */
export function creatureHTML(species, opts = {}) {
  const { variant, crown } = opts;
  if (species === 'whale') return img(crown ? 'whale_gold' : 'whale_blue', 'whale') + (crown ? CROWN : '');
  if (variant) return img(variant.sprite, species);
  if (species === 'fish') return img(FISH_NEUTRAL[0].sprite, 'fish');
  return img(SPECIES[species] ? species : 'fish_cyan', species);
}

// ---- small decorative sprites -------------------------------------------

export const JELLY_HTML = `<img class="sprite" src="${DIR}jelly.webp" alt="" draggable="false">`;

export const COIN_SVG = `<svg viewBox="0 0 40 40">
<circle cx="20" cy="20" r="18" fill="#3A2E0E" stroke="#FFD166" stroke-width="2"></circle>
<path d="M20 8 L28 20 L20 32 L12 20 Z" fill="#FFD166"></path></svg>`;

export const BRAND_SVG = `<svg width="40" height="26" viewBox="0 0 300 150" fill="none">
<path d="M18 78 C22 44 66 24 122 26 C176 28 224 50 236 72 C240 80 236 88 224 92 C180 104 90 106 46 96 C28 92 16 86 18 78 Z" fill="#2A5C94"></path>
<path d="M234 66 C246 50 250 34 246 16 C256 32 266 40 278 42 C268 52 262 66 262 82 C252 92 240 84 234 66 Z" fill="#2A5C94"></path>
<circle cx="52" cy="64" r="7" fill="#04070F"></circle></svg>`;

// Feed-row icons: flat silhouettes tinted with the species colour. Still SVG —
// at 20px a vector silhouette stays crisp where a downscaled painting muddies.
const MINI = {
  whale: (c) => `<svg width="22" height="14" viewBox="0 0 300 150" fill="none"><path d="M18 78 C22 44 66 24 122 26 C176 28 224 50 236 72 C240 80 236 88 224 92 C180 104 90 106 46 96 C28 92 16 86 18 78 Z" fill="${c}"></path><path d="M234 66 C246 50 250 34 246 16 C256 32 266 40 278 42 C268 52 262 66 262 82 C252 92 240 84 234 66 Z" fill="${c}"></path></svg>`,
  shark: (c) => `<svg width="22" height="12" viewBox="0 0 280 130" fill="none"><path d="M124 40 C128 22 140 12 156 10 C148 24 146 34 148 42 Z" fill="${c}"></path><path d="M14 70 C34 46 78 34 128 36 C176 38 214 50 236 66 C218 80 178 94 128 96 C80 98 36 90 14 70 Z" fill="${c}"></path><path d="M228 62 C240 50 246 38 246 24 C254 38 260 46 268 50 C258 56 250 66 246 78 C240 72 232 68 228 62 Z" fill="${c}"></path></svg>`,
  dolphin: (c) => `<svg width="20" height="13" viewBox="0 0 220 140" fill="none"><path d="M108 26 C112 12 122 6 134 4 C128 14 126 22 128 30 Z" fill="${c}"></path><path d="M20 96 C28 56 66 26 116 22 C156 20 186 34 198 54 C186 56 176 62 170 72 C160 92 132 108 96 110 C64 112 36 106 20 96 Z" fill="${c}"></path><path d="M188 60 C198 52 206 42 208 30 C214 42 222 50 230 52 C222 60 216 70 214 80 Z" fill="${c}"></path></svg>`,
  fish: (c) => `<svg width="20" height="13" viewBox="0 0 90 60" fill="none"><ellipse cx="38" cy="30" rx="26" ry="18" fill="${c}"></ellipse><path d="M62 30 L84 14 C80 24 80 36 84 46 Z" fill="${c}"></path></svg>`,
};

const MINI_COLOR = { whale: '#4FD8FF', shark: '#6FF7D1', dolphin: '#C77DFF', fish: '#4FD8FF' };

export function miniIcon(kind) {
  const c = MINI_COLOR[kind] || MINI_COLOR.fish;
  return { svg: (MINI[kind] || MINI.fish)(c), color: c };
}
