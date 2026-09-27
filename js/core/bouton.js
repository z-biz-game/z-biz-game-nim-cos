// Bouton's closed form (1902): the whole theory of this game in a handful of lines, and
// the only thing the browser runs while you play. No search, no table, no randomness —
// O(k) per question, so "is this move winning?" is answered in the same time it takes to
// draw a frame.
//
//   normal   P-position  <=>  xor(all heaps) === 0
//   misere   the same test while any heap still holds two or more stones; once every
//            heap is 0 or 1 the goal inverts and P becomes "an odd number of 1-heaps"
//
// The move generator is where the two rules really part company, and it is derived here
// rather than looked up:
//
//   normal   to zero the xor you must replace heap i with (heap_i xor X). It is a legal
//            move exactly when that value is smaller, so the winning set is *exactly*
//            the heaps where (h_i xor X) < h_i. For (3,5,7), X = 1, so 3->2, 5->4, 7->6:
//            three winning moves and no fourth. Measured, not felt — see
//            test/anchor.test.mjs, and `retro.js` re-derives the same set by exhaustive
//            retrograde analysis over the whole bounded game graph.
//   misere   with two or more big heaps the same argument holds (you cannot make every
//            heap small in one move, so the xor-0 target is automatically a P-position).
//            With exactly one big heap v and c single-stone heaps the xor-0 target is
//            v xor (v xor c&1) = c&1, i.e. 0 or 1 — which lands in the all-small region,
//            where xor 0 means an *even* number of 1-heaps and that is a win for the next
//            player. So the ordinary move is the losing one and the winning move is the
//            opposite: leave an odd number of 1-heaps, i.e. v -> 1 when c is even and
//            v -> 0 when c is odd. Exactly one winning move exists in that region.
//
// Everything in this file is checked state-by-state against `retro.js` in
// test/retrograde.test.mjs, for every position with k <= 3 and n_i <= 7, both rules.

import { NORMAL, MISERE, xorOf, bigHeaps, oneHeaps } from './heaps.js';

// outcome(pos, rule) -> 'N' (the player to move wins with best play) or 'P' (they lose).
export function outcome(pos, rule) {
  if (rule === MISERE) {
    if (bigHeaps(pos) === 0) return oneHeaps(pos) % 2 === 1 ? 'P' : 'N';
    return xorOf(pos) === 0 ? 'P' : 'N';
  }
  if (rule !== NORMAL) throw new Error(`unknown rule: ${rule}`);
  return xorOf(pos) === 0 ? 'P' : 'N';
}

export function isP(pos, rule) {
  return outcome(pos, rule) === 'P';
}

// The winning moves, in the same deterministic order `heaps.eachSuccessor` enumerates in.
// Returns [] for a P-position — there are none, that is what P means — and also [] for
// the misère terminal, which is the one N-position with no move to make: the player to
// move has already won, because their opponent was forced to take the last stone. That
// exception is asserted on purpose in test/anchor.test.mjs.
export function winningMoves(pos, rule) {
  const out = [];
  if (rule === MISERE) {
    const big = bigHeaps(pos);
    if (big === 0) {
      // All heaps are 0 or 1: hand back an even number of single stones.
      if (oneHeaps(pos) % 2 === 1) return out;
      for (let i = 0; i < pos.length; i++) if (pos[i] === 1) out.push({ i, to: 0 });
      return out;
    }
    if (big === 1) {
      const ones = oneHeaps(pos);
      for (let i = 0; i < pos.length; i++) {
        if (pos[i] < 2) continue;
        out.push({ i, to: ones % 2 === 0 ? 1 : 0 });
        return out;
      }
    }
    // Two or more big heaps: identical to normal play.
  } else if (rule !== NORMAL) {
    throw new Error(`unknown rule: ${rule}`);
  }
  const x = xorOf(pos);
  for (let i = 0; i < pos.length; i++) {
    const to = pos[i] ^ x;
    if (to < pos[i]) out.push({ i, to });
  }
  return out;
}

export function winMoveCount(pos, rule) {
  return winningMoves(pos, rule).length;
}

// The one number the panel prints next to "本步是否必胜". `winning` is false for a
// P-position, where every move loses, and also for the misère terminal, where there is
// nothing left to move and the player to move has already won; `over` separates them.
export function verdict(pos, rule) {
  const win = winningMoves(pos, rule);
  return {
    outcome: outcome(pos, rule),
    winning: win.length > 0,
    winMoves: win.length,
    over: xorOf(pos) === 0 && pos.every((n) => n === 0),
  };
}
