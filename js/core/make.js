// The generator. Like the solver next door (`retro.js`) it is a build-time file: nothing
// in js/main.js or js/view.js imports it, which is the structural reason the browser never
// searches while you tap.
//
// Two rules decide what ships:
//
//   1. A lot must be a first-player win (`outcome === 'N'`) under its own rule. A P-position
//      is not a hard level, it is a level you cannot beat: the opponent here is the closed
//      form, and from a P-position every move you make loses. Publishing one would be a fake
//      level with a difficulty label stuck on it.
//   2. The band is a pair of *measured* numbers, never an opinion: `par` (how many moves the
//      whole game lasts when the winner plays for the shortest game and the loser for the
//      longest) and `winMoves` (how many winning moves the opening position has). Fewer
//      winning moves means a narrower road, so a band can be "long game" or "exactly one
//      move survives", and both are read off the graph rather than felt.
//
// Every candidate is measured under both conventions, because the panel lets you switch
// mid-lot and both numbers must already be certified. That is also why the oddball band
// exists: those lots are provably lost under one convention and won under the other, which
// is the evidence that `misere` is not a cosmetic flag.

import { bigHeaps, validate, MAX_HEAPS, MAX_HEAP } from './heaps.js';
import { measure } from './retro.js';
import { rngFrom } from './rng.js';

// Multiset identity: Nim heaps have no order, so 3,5,7 and 7,3,5 are one puzzle. The heap
// indices the UI shows are the sorted order, which is also how the rows are serialised.
export function signature(heaps) {
  return heaps.slice().sort((a, b) => a - b).join('+');
}

function sum(heaps) {
  let t = 0;
  for (const h of heaps) t += h;
  return t;
}

// Draw one candidate shape for the band. Every heap holds at least one stone: an empty heap
// in an opening position is the same game wearing a decoration, and it would make
// `winMoves` and the heap count mean two different things in one table.
function sample(rng, band) {
  const k = rng.range(band.k[0], band.k[1]);
  const heaps = [];
  for (let i = 0; i < k; i++) heaps.push(rng.range(1, band.nMax));
  heaps.sort((a, b) => a - b);
  return heaps;
}

// The band's structural demand beyond the two measured axes, as a named predicate so
// bake.mjs can print *why* a candidate was refused rather than just "tried 900, kept 12".
// 'singleBig' is the interesting one: exactly one heap of two or more stones is precisely
// the region where the misère winning move and the normal winning move are different
// moves, so a misère lot from it teaches something the normal band cannot.
function shapeProblem(heaps, band) {
  const big = bigHeaps(heaps);
  if (band.shape === 'singleBig' && big !== 1) return 'shape';
  if (band.shape === 'manyBig' && big < 2) return 'shape';
  if (band.shape === 'allSmall' && big !== 0) return 'shape';
  return null;
}

// makeLot(seed, band, stats?) -> row | null. Deterministic in the seed: the same seed and
// band always produce, or always refuse, the same lot.
export function makeLot(seed, band, stats) {
  const rng = rngFrom(`${band.key}|${seed}`);
  const hit = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
  const other = band.rule === 'normal' ? 'misere' : 'normal';
  for (let t = 0; t < band.tries; t++) {
    hit('probe');
    const heaps = sample(rng, band);
    if (validate(heaps) || heaps.length > MAX_HEAPS || heaps.some((h) => h > MAX_HEAP)) {
      hit('invalid');
      continue;
    }
    if (sum(heaps) < band.sum[0]) { hit('sumLow'); continue; }
    if (sum(heaps) > band.sum[1]) { hit('sumHigh'); continue; }
    if (shapeProblem(heaps, band)) { hit('shape'); continue; }
    if (stats && stats.sigs && stats.sigs.has(signature(heaps))) { hit('dup'); continue; }
    const scores = measure(heaps);
    const mine = scores[band.rule];
    if (mine.outcome !== 'N') { hit('notN'); continue; }
    if (mine.par < band.par[0]) { hit('parLow'); continue; }
    if (mine.par > band.par[1]) { hit('parHigh'); continue; }
    if (mine.winMoves < band.win[0]) { hit('winLow'); continue; }
    if (mine.winMoves > band.win[1]) { hit('winHigh'); continue; }
    if (band.other && scores[other].outcome !== band.other) { hit('otherRule'); continue; }
    if (stats && stats.sigs) stats.sigs.add(signature(heaps));
    if (stats) stats.found = (stats.found || 0) + 1;
    return {
      heaps,
      rule: band.rule,
      band: band.key,
      index: BANDS.indexOf(band),
      outcome: mine.outcome,
      par: mine.par,
      winMoves: mine.winMoves,
      scores,
    };
  }
  if (stats) stats.gaveUp = (stats.gaveUp || 0) + 1;
  return null;
}

// The ladder the pool is baked against. `par`/`win` are the acceptance windows, `per` how
// many distinct lots bake.mjs asks for, `tries` the sample budget per lot, `shape` the
// structural demand from `shapeProblem`, `other` the required verdict under the *other* win
// convention.
//
// The windows are not guesses: they are read off the measured distribution of the shared
// grid (`node tools/bake.mjs` prints the counts again on every run). Two facts from that
// table shape the ladder:
//
//   * Under normal play `winMoves` is always **odd** — it counts the heaps holding the top
//     set bit of the xor, and that bit being set means an odd number of heaps carry it
//     (asserted for every position of the grid in test/anchor.test.mjs). So "several ways to
//     win" is a win = 3 band, and the only even counts in the game live where every heap
//     holds a single stone — which is the oddball band.
//   * Under misere play, a position with exactly one heap of two or more stones always has
//     par 2 or 4 and exactly one winning move, and that move is never the move normal play
//     would make. That is the whole content of the twitch band.
export const BANDS = [
  {
    key: 'spark', label: '火花', rule: 'normal', blurb: '三堆小石子，赢法不止一条',
    k: [3, 3], nMax: 8, sum: [4, 14], par: [3, 9], win: [3, 3], shape: 'any', tries: 600, per: 8,
  },
  {
    key: 'nerve', label: '神经', rule: 'normal', blurb: '棋到中盘，异或要算准',
    k: [3, 4], nMax: 9, sum: [7, 17], par: [9, 13], win: [3, 3], shape: 'any', tries: 900, per: 12,
  },
  {
    key: 'knife', label: '刀口', rule: 'normal', blurb: '只剩一条活路，走错就回不来',
    k: [4, 4], nMax: 9, sum: [10, 24], par: [11, 19], win: [1, 1], shape: 'manyBig', tries: 1500, per: 12,
  },
  {
    key: 'deep', label: '深水', rule: 'normal', blurb: '四堆长局，对手一次也不会松手',
    k: [4, 4], nMax: 9, sum: [22, 32], par: [23, 31], win: [1, 3], shape: 'manyBig', tries: 2500, per: 10,
  },
  {
    key: 'twitch', label: '歧途', rule: 'misere', blurb: '取走最后一枚者负：正常规则的最优着在这里正好输',
    k: [3, 4], nMax: 9, sum: [5, 20], par: [2, 4], win: [1, 1], shape: 'singleBig', tries: 1500, per: 10,
    other: 'N',
  },
  {
    key: 'oddball', label: '反面', rule: 'misere', blurb: '全是单石堆：这一条线上两种规则给出相反的结论',
    k: [2, 4], nMax: 1, sum: [2, 4], par: [1, 4], win: [2, 9], shape: 'allSmall', tries: 200, per: 2,
    other: 'P',
  },
];

export function bandByKey(key) {
  return BANDS.find((b) => b.key === key) || BANDS[0];
}
