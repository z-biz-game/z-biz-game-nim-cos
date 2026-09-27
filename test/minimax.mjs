// A second, deliberately stupid implementation of the same two numbers.
//
// `retro.js` solves the game graph bottom-up: it starts at the empty board and pushes
// labels outwards through buckets ordered by ply depth, and the ordering is what makes the
// winner's "shortest" and the loser's "longest" come out right. That is easy to get subtly
// wrong and hard to notice, because a wrong depth still looks like a number.
//
// This file answers the same question top-down, by the definition, with a memo and nothing
// else:
//
//   win(heaps)  = 0 moves to go, if this is the position where the mover has already won
//                 otherwise 1 + min over the positions this move hands to a *losing* opponent
//   lose(heaps) = 1 + max over everything the mover can try            (they stall; stalling
//                                                                  is their best option)
//
// There is no queue, no bucket, no reverse edge list, and no ordering argument anywhere.
// When the two agree on every position of a bounded grid — which is what
// test/retrograde.test.mjs checks, along with Bouton's closed form — then the number
// printed on screen has been computed twice by two different algorithms.
//
// Exponential in a naive search, but Nim positions shrink: every move strictly lowers the
// stone count, so the memo keeps it to the reachable box. Call it with a `maxNodes` budget.

import { NORMAL, MISERE, isTerminal, successors, xorOf, bigHeaps, oneHeaps } from '../js/core/heaps.js';

export class NaiveCap extends Error {}

// The base case of the whole exercise, stated in words rather than derived: the empty
// board is a win for whoever is asked to move under misère (the other player just took the
// last stone and lost) and a loss under normal play (they have no move).
function alreadyWon(pos, rule) {
  return rule === MISERE && isTerminal(pos);
}

// naive(pos, rule, { maxNodes, memo, nodes }) — pass a shared `memo` (plus `nodes: {n:0}`)
// to sweep a whole box: each position is then solved once instead of once per query, which
// is what keeps the reconciliation test able to cover all 46,656 positions of a 6x6 grid.
export function naive(pos, rule, opts = {}) {
  const budget = opts.maxNodes || 200000;
  const memo = opts.memo || new Map();
  const counter = opts.nodes || { n: 0 };

  function solve(p) {
    const key = rule + '|' + p.join(',');
    const hit = memo.get(key);
    if (hit) return hit;
    if (++counter.n > budget) throw new NaiveCap(`naive minimax passed ${budget} positions`);
    const out = work(p);
    memo.set(key, out);
    return out;
  }

  function work(p) {
    if (alreadyWon(p, rule)) return { outcome: 'N', plies: 0, winMoves: 0 };
    if (isTerminal(p)) return { outcome: 'P', plies: 0, winMoves: 0 };
    const kids = successors(p).map((s) => ({ move: s.move, ...solve(s.next) }));
    // The classification itself is the definition of the game, not Bouton's theorem: this
    // is why it counts as independent evidence about the closed form.
    const won = kids.filter((k) => k.outcome === 'P');
    if (!won.length) {
      let longest = 0;
      for (const k of kids) if (k.plies + 1 > longest) longest = k.plies + 1;
      return { outcome: 'P', plies: longest, winMoves: 0 };
    }
    let shortest = Infinity;
    for (const k of won) if (k.plies + 1 < shortest) shortest = k.plies + 1;
    return { outcome: 'N', plies: shortest, winMoves: won.length };
  }

  return solve(pos.slice());
}

// The same verdict as a one-line formula, for the reconciliation to be against. Kept here
// rather than in bouton.js so the test compares three independent writings of it.
export function closedFormOutcome(pos, rule) {
  if (rule === NORMAL) return xorOf(pos) === 0 ? 'P' : 'N';
  if (bigHeaps(pos) === 0) return oneHeaps(pos) % 2 === 1 ? 'P' : 'N';
  return xorOf(pos) === 0 ? 'P' : 'N';
}
