// Complete retrograde analysis over a bounded Nim graph. This file exists for one
// reason: so that the closed form in `bouton.js` is not the only voice in the room.
//
// The graph: every position with 0 <= n_i <= maxVec[i], for a fixed k. Edges are single
// moves, so the graph is a DAG (each move strictly lowers the stone count) and its
// longest play is `sum(maxVec)` plies.
//
// The algorithm is textbook retrograde, not a re-statement of the theorem:
//
//   1. build every position and its *reverse* edge list (CSR arrays, no per-state objects)
//   2. the terminal position gets its label from the win convention alone —
//      `normal`: the player to move has no move and loses  -> P
//      `misere`: the player to move has already won, the other one took the last stone -> N
//      This is the single line where the two rules differ. Everything below is shared.
//   3. walk outwards in increasing ply depth. A position whose successor is P is itself N
//      (take that move); a position whose successors are *all* N is itself P.
//
// Depth comes along for the same ride, which is what `par` is made of. For a winning
// position, plies = 1 + plies-to-end of the *best* P-successor (the winner wants it
// short), and for a losing position, plies = 1 + plies of the *worst* successor for them
// (the loser wants it long). Because buckets are drained in increasing depth order, the
// first time a position is labelled N is already its minimum, and the running maximum is
// final the moment its last successor closes. No second pass, no iteration to a fixpoint.
//
// So `par` on screen means: the number of moves the game lasts if the winner plays for
// length and the loser plays for delay. It is measured by enumerating the graph, and it
// is re-derived from scratch by an independent top-down minimax in test/minimax.mjs.
//
// Cost, measured on this repo's own grid (node, v26, one cold process): the shared
// 9x9x9x9 grid — 10,000 positions, 180,000 reverse edges — plus both rule passes takes
// about 20 ms; the widest own reachable box in the shipped pool (6+7+7+8, 4,032 positions,
// both rules) takes about 6 ms, and the whole 54-lot bake finishes in 0.14 s wall. None of
// it ever runs while you tap: the tap path is `bouton.js`, a few dozen nanoseconds.

import { NORMAL, MISERE } from './heaps.js';

const N_LABEL = 1;
const P_LABEL = 2;

export class RetroCap extends Error {}

// How big a graph this file is allowed to build. A Nim lot's whole reachable box is the
// product of (n_i + 1), which grows fast: five heaps of nine stones already need 100,000
// positions. Both entry points below take the cap as an option and *throw* rather than
// quietly answering with a truncated table, so a too-wide request is a visible refusal
// (tools/bake.mjs counts it as a reject reason) and never a wrong number on screen.
const MAX_STATES = 60000;

// Mixed-radix grid over the box [0..maxVec[0]] x ... . Positions with fewer heaps are the
// same box with trailing zeros, which is exactly why one grid serves every k <= maxVec.length:
// a 0-heap has no moves and contributes 0 to the xor.
export function gridOf(maxVec, opts = {}) {
  const maxStates = opts.maxStates || 400000;
  const k = maxVec.length;
  if (!k) throw new RetroCap('gridOf needs at least one heap bound');
  const dims = maxVec.map((v) => v + 1);
  const stride = new Array(k);
  let size = 1;
  for (let i = 0; i < k; i++) { stride[i] = size; size *= dims[i]; }
  if (size > maxStates) {
    throw new RetroCap(`grid ${maxVec.join('x')} needs ${size} states, cap is ${maxStates}`);
  }
  const tokens = new Uint16Array(size);
  const groups = [];
  let maxTokens = 0;
  const dig = new Array(k);
  for (let id = 0; id < size; id++) {
    let rest = id;
    let t = 0;
    for (let i = 0; i < k; i++) {
      dig[i] = rest % dims[i];
      rest = (rest - dig[i]) / dims[i];
      t += dig[i];
    }
    tokens[id] = t;
    if (t > maxTokens) maxTokens = t;
    (groups[t] || (groups[t] = [])).push(id);
  }
  const g = {
    maxVec: maxVec.slice(),
    k,
    dims,
    stride,
    size,
    tokens,
    groups,
    maxTokens,
    // Reverse of `digitOf`: a position to its integer id. Shorter positions are
    // zero-padded, matching the doc comment above.
    idx(pos) {
      let s = 0;
      for (let i = 0; i < pos.length && i < k; i++) s += pos[i] * stride[i];
      return s;
    },
    // ...and forwards again, without allocating.
    digits(id, into) {
      const out = into || new Array(k);
      let rest = id;
      for (let i = 0; i < k; i++) {
        out[i] = rest % dims[i];
        rest = (rest - out[i]) / dims[i];
      }
      return out;
    },
  };
  return g;
}

// Every edge, backwards: list[X] holds the positions that can move *into* X, i.e. the
// ones with exactly one heap larger. Retrograde walks those, forwards would not solve.
function reverseEdges(g) {
  const { size, k, maxVec, dims, stride } = g;
  const count = new Uint32Array(size);
  const dig = new Array(k);
  for (let id = 0; id < size; id++) {
    g.digits(id, dig);
    let c = 0;
    for (let i = 0; i < k; i++) c += maxVec[i] - dig[i];
    count[id] = c;
  }
  const offset = new Uint32Array(size + 1);
  for (let id = 0; id < size; id++) offset[id + 1] = offset[id] + count[id];
  const cursor = offset.slice(0, size);
  const pred = new Uint32Array(offset[size]);
  for (let id = 0; id < size; id++) {
    g.digits(id, dig);
    for (let i = 0; i < k; i++) {
      for (let v = dig[i] + 1; v <= maxVec[i]; v++) {
        pred[cursor[id]++] = id + (v - dig[i]) * stride[i];
      }
    }
  }
  return { offset, pred, edges: pred.length };
}

// retrograde(g, rule) -> { rule, size, edges, label, plies, outcomeOf, unresolved }
export function retrograde(g, rule, opts = {}) {
  if (rule !== NORMAL && rule !== MISERE) throw new Error(`unknown rule: ${rule}`);
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : 0;
  const tick = () => {
    if (deadline && Date.now() > deadline) throw new RetroCap('retrograde ran past its deadline');
  };
  const { offset, pred, edges } = reverseEdges(g);
  const size = g.size;
  const label = new Uint8Array(size);
  const plies = new Uint32Array(size);
  const left = new Uint16Array(size); // unexplored successors, still to be seen
  const { tokens, maxTokens } = g;
  for (let id = 0; id < size; id++) left[id] = tokens[id];

  const buckets = new Array(maxTokens + 1);
  for (let d = 0; d <= maxTokens; d++) buckets[d] = [];
  const put = (id, d) => { (buckets[d] || (buckets[d] = [])).push(id); };

  const terminal = g.idx(new Array(g.k).fill(0));
  // The one line that is different for the two win conventions.
  label[terminal] = rule === NORMAL ? P_LABEL : N_LABEL;
  put(terminal, 0);

  let visited = 0;
  for (let d = 0; d <= maxTokens; d++) {
    const bucket = buckets[d];
    if (!bucket) continue;
    for (let b = 0; b < bucket.length; b++) {
      const id = bucket[b];
      const l = label[id];
      if ((++visited & 8191) === 0) tick();
      for (let e = offset[id]; e < offset[id + 1]; e++) {
        const p = pred[e];
        if (label[p]) continue; // already resolved: N found its shortest win, P its last successor
        // A successor labelled P is one where the *next* player loses, whatever the win
        // convention: the two rules differ only in the base case above, never here.
        if (l === P_LABEL) {
          label[p] = N_LABEL;
          plies[p] = d + 1;
          put(p, d + 1);
        } else {
          left[p] -= 1;
          if (plies[p] < d + 1) plies[p] = d + 1;
          if (left[p] === 0) {
            label[p] = P_LABEL;
            put(p, plies[p]);
          }
        }
      }
    }
  }
  let unresolved = 0;
  for (let id = 0; id < size; id++) if (!label[id]) unresolved++;
  if (unresolved) throw new Error(`retrograde left ${unresolved} of ${size} positions unlabelled`);

  return {
    rule,
    grid: g,
    size,
    edges,
    label,
    plies,
    outcomeOf(id) { return label[id] === N_LABEL ? 'N' : 'P'; },
  };
}

// { outcome, plies, winMoves } for one position, read off the completed analysis.
// `winMoves` here is a *count of successors the retrograde itself labelled P* — it shares
// no line of code with `bouton.winMoveCount`, which is the whole point of the pairing.
export function resolveState(an, pos) {
  const g = an.grid;
  const id = g.idx(pos);
  const dig = g.digits(id);
  let winMoves = 0;
  for (let i = 0; i < g.k; i++) {
    for (let v = 0; v < dig[i]; v++) {
      if (an.label[id + (v - dig[i]) * g.stride[i]] === P_LABEL) winMoves++;
    }
  }
  return { outcome: an.outcomeOf(id), plies: an.plies[id], winMoves, states: an.size };
}

// The box the shared engine sits on: four heaps of up to nine stones, i.e. every shape the
// generator is allowed to draw (`BANDS` in make.js keeps k <= 4 and n_i <= 9). One grid then
// answers every candidate in the pool — 10,000 positions, 180,000 edges, one pass per rule —
// which is what keeps the bake a fraction of a second instead of a minute.
export const MAX_VEC = [9, 9, 9, 9];

let shared = null;

function engine() {
  if (!shared) {
    const g = gridOf(MAX_VEC, { maxStates: MAX_STATES });
    shared = { grid: g, normal: retrograde(g, NORMAL), misere: retrograde(g, MISERE) };
  }
  return shared;
}

// What the shared grid actually is, so the bake and the docs can print the box the numbers
// came out of instead of asserting a size nobody checked.
export function engineInfo() {
  const e = engine();
  return {
    maxVec: MAX_VEC.slice(),
    states: e.normal.size,
    edges: e.normal.edges,
    rules: ['normal', 'misere'],
  };
}

// measure(heaps) -> { normal: {...}, misere: {...}, states } — both conventions off the
// same completed graph, which is what lets a row carry a number for each rule.
//
// The lookup is only meaningful inside the box the graph covers, and an out-of-range id
// would not fail — it would land on some *other* position's label and return a confident
// wrong number. So the range is checked and refused here rather than trusted.
export function measure(heaps) {
  if (heaps.length > MAX_VEC.length || heaps.some((n, i) => n > MAX_VEC[i])) {
    throw new RetroCap(
      `measure() only answers inside ${MAX_VEC.join('x')}, got ${heaps.join(',')} — use positionScores()`,
    );
  }
  const e = engine();
  const normal = resolveState(e.normal, heaps);
  const misere = resolveState(e.misere, heaps);
  return {
    normal: { outcome: normal.outcome, winMoves: normal.winMoves, par: normal.plies },
    misere: { outcome: misere.outcome, winMoves: misere.winMoves, par: misere.plies },
    states: e.normal.size,
  };
}

// The same two answers, but computed from a graph built *only* out of this position's own
// reachable box (every heap bounded by its own starting size). tools/bake.mjs and
// test/library.test.mjs use it to confirm that the shared grid above did not smuggle in an
// answer from a neighbouring position: a smaller graph, the same three numbers.
export function positionScores(heaps, opts = {}) {
  const g = gridOf(heaps, { maxStates: opts.maxStates || MAX_STATES, deadlineMs: opts.deadlineMs });
  const normal = resolveState(retrograde(g, NORMAL, opts), heaps);
  const misere = resolveState(retrograde(g, MISERE, opts), heaps);
  return {
    normal: { outcome: normal.outcome, winMoves: normal.winMoves, par: normal.plies },
    misere: { outcome: misere.outcome, winMoves: misere.winMoves, par: misere.plies },
    states: g.size,
  };
}

// The winning move set, as the graph sees it: every successor labelled P. Ordered by heap
// then by descending target, i.e. `heaps.eachSuccessor` order, so the test can compare it
// with the closed form after normalising.
export function winningMoveSet(an, pos) {
  const g = an.grid;
  const id = g.idx(pos);
  const dig = g.digits(id);
  const out = [];
  for (let i = 0; i < g.k; i++) {
    for (let v = dig[i] - 1; v >= 0; v--) {
      if (an.label[id + (v - dig[i]) * g.stride[i]] === P_LABEL) out.push({ i, to: v });
    }
  }
  return out;
}
