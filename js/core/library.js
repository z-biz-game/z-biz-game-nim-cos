// The shipped pool. The game reads levels from here and never generates them — the
// generator (`make.js`) and the solver (`retro.js`) are not imported by anything the
// browser loads, which is the structural reason a tap cannot start a search.
//
// Everything below is a lookup over js/data/lots.js, so the daily puzzle and a shared
// #/lot/<id> link resolve to the same piles on any device: the pool is fixed, the seed only
// chooses an index.

import { LOTS, BANDS_META, ENGINE } from '../data/lots.js';
import { validate } from './heaps.js';
import { hashSeed } from './rng.js';

// Display-side bands, measured off the lots that actually shipped (the generation-side
// windows live in make.js and are not needed once the pool is baked).
export const BANDS = BANDS_META;
export const ENGINE_META = ENGINE;

const prepared = LOTS.map((row) => {
  const err = validate(row.heaps);
  if (err) throw new Error(`${row.id}: ${err}`);
  return row;
});

export const ALL = prepared;

export const BAND_INDEX = {};
BANDS.forEach((b, i) => { BAND_INDEX[b.key] = i; });

// The seed each pick is a function of. `hashSeed` is the same two-round UTF-16 mixer the
// generator is seeded with (see rng.js for why it is *not* textbook FNV-1a and why no public
// vector is quoted anywhere in this repo), so a daily date or a shared band token resolves
// to one and the same lot on every device, with no state carried across.
function pick(list, seed, salt) {
  if (!list.length) return null;
  return list[hashSeed(`${salt}|${seed}`) % list.length];
}

export function bandByKey(key) {
  return BANDS.find((b) => b.key === key) || BANDS[0];
}

export function lotsIn(key) {
  return prepared.filter((l) => l.band === key);
}

export function byId(id) {
  return prepared.find((l) => l.id === id) || null;
}

export function levelAt(index) {
  if (!prepared.length) return null;
  const n = prepared.length;
  return prepared[((index % n) + n) % n];
}

// The campaign: every baked lot, easiest band first and inside a band by measured par —
// exactly the order tools/bake.mjs wrote them in.
export function campaign() {
  return prepared;
}

// Endless play inside one band. A seed picks, so a shared link stays honest.
export function randomLot(seed, bandKey) {
  // An unknown band is a refusal, not a silent substitution: quietly handing back a random
  // lot from the whole pool would let a typo'd band key ship the wrong difficulty and look
  // like a working endless mode.
  const list = bandKey ? lotsIn(bandKey) : prepared;
  return pick(list, seed, 'random');
}

// One puzzle per calendar day, the same for everyone.
export function dailyLot(dateKey) {
  return pick(prepared, dateKey, 'daily');
}

// What the shipped pool actually contains, measured rather than claimed: bake.mjs prints
// this and README copies it, so a re-bake that quietly lands lighter shows up as a changed
// line instead of a stale document.
function median(sorted) {
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m] : Math.round((sorted[m - 1] + sorted[m]) / 2);
}

export function stats() {
  const byBand = {};
  for (const l of prepared) {
    const s = byBand[l.band] || (byBand[l.band] = {
      n: 0, rule: l.rule, parMin: Infinity, parMax: 0, parMed: 0, pars: [],
      win: {}, stonesMin: Infinity, stonesMax: 0, heapsMin: Infinity, heapsMax: 0,
      differs: 0, invert: 0, cellsMax: 0,
    });
    s.n++;
    if (l.cells > s.cellsMax) s.cellsMax = l.cells;
    s.pars.push(l.par);
    if (l.par < s.parMin) s.parMin = l.par;
    if (l.par > s.parMax) s.parMax = l.par;
    s.win[l.winMoves] = (s.win[l.winMoves] || 0) + 1;
    const stones = l.heaps.reduce((a, b) => a + b, 0);
    if (stones < s.stonesMin) s.stonesMin = stones;
    if (stones > s.stonesMax) s.stonesMax = stones;
    if (l.heaps.length < s.heapsMin) s.heapsMin = l.heaps.length;
    if (l.heaps.length > s.heapsMax) s.heapsMax = l.heaps.length;
    // Two different claims, counted separately: `differs` only says one of the three
    // printed numbers moved (usually par), `invert` says the two conventions disagree about
    // *who wins* the opening position, which is the strong one and only happens where every
    // heap holds a single stone.
    if (l.scores.normal.outcome !== l.scores.misere.outcome
      || l.scores.normal.par !== l.scores.misere.par
      || l.scores.normal.winMoves !== l.scores.misere.winMoves) s.differs++;
    if (l.scores.normal.outcome !== l.scores.misere.outcome) s.invert++;
  }
  for (const s of Object.values(byBand)) {
    s.pars.sort((a, b) => a - b);
    s.parMed = median(s.pars);
    delete s.pars;
  }
  return { lots: prepared.length, engine: ENGINE, byBand };
}
