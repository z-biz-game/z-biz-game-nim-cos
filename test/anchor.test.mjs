// The anchors. Every expected value below was typed by hand from the theorem statement in
// the spec (and from /tmp/puzzle-brief/probe2.mjs, which measured them independently of this
// repo), never read back out of `bouton.js`. That is the only reason this file is evidence:
// a test that asks the code what it thinks is a transcript.
//
// One of them is a correction. The opening position (3,4,5) was first hand-derived as a
// P-position — it looks like one, three consecutive numbers — and the probe measured xor = 2,
// i.e. a first-player win with exactly one move to a P-position. The wrong version is in
// deliverable.md's change table, because the whole claim of this repo is that the numbers
// come from computing and not from feeling.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { xorOf, validate, legalMove, applyMove, bigHeaps, oneHeaps, NORMAL, MISERE } from '../js/core/heaps.js';
import { outcome, winningMoves, winMoveCount, isP, verdict } from '../js/core/bouton.js';

const asRows = (pos, moves) => moves.map((m) => applyMove(pos, m).join(','));

test('xor(3,5,7) is 1, so the position is a first-player win', () => {
  eq(xorOf([3, 5, 7]), 1, 'hand-derived: 3 xor 5 = 6, 6 xor 7 = 1');
  eq(outcome([3, 5, 7], NORMAL), 'N');
  eq(isP([3, 5, 7], NORMAL), false, 'and it is not a P-position');
});

test('(3,5,7) has exactly three winning moves, and they are these three', () => {
  const ms = winningMoves([3, 5, 7], NORMAL);
  eq(ms.length, 3, 'measured: 2,5,7 | 3,4,7 | 3,5,6 — no more, no fewer');
  eq(asRows([3, 5, 7], ms), ['2,5,7', '3,4,7', '3,5,6']);
  // Hand-check why there cannot be a fourth: to zero an xor of 1 you must flip the last
  // bit of exactly one heap, and only a heap already ending in 1 gets smaller when you do.
  for (const m of ms) eq(xorOf(applyMove([3, 5, 7], m)), 0, 'every one of them zeroes the xor');
});

test('(3,4,5) is an N-position, not the P-position it looks like', () => {
  eq(xorOf([3, 4, 5]), 2, 'measured by probe2.mjs after a hand derivation said 0');
  eq(outcome([3, 4, 5], NORMAL), 'N');
  eq(asRows([3, 4, 5], winningMoves([3, 4, 5], NORMAL)), ['1,4,5'], 'one way out, and it is this one');
  eq(winMoveCount([3, 4, 5], NORMAL), 1, 'the hardest kind of easy-looking opening: a single road');
});

test('a P-position has no move to a P-position, and (1,2,3) is one', () => {
  eq(xorOf([1, 2, 3]), 0);
  eq(outcome([1, 2, 3], NORMAL), 'P');
  eq(winningMoves([1, 2, 3], NORMAL), [], 'zero winning moves is the definition, not a search failure');
  eq(verdict([1, 2, 3], NORMAL), { outcome: 'P', winning: false, winMoves: 0, over: false });
});

test('the misere anchor pair: (1,1) inverts, (3,5,7) does not', () => {
  // Two single stones: taking one hands your opponent the last stone. Under normal play the
  // same position is lost for the mover (xor 0), so the verdict really does flip.
  eq(outcome([1, 1], NORMAL), 'P');
  eq(outcome([1, 1], MISERE), 'N');
  eq(asRows([1, 1], winningMoves([1, 1], MISERE)), ['0,1', '1,0']);
  // Three big heaps are out of the all-small region, so the P/N verdict is the same under
  // both conventions — the difference is how long the win takes, which is 15 vs 14 plies.
  eq(outcome([3, 5, 7], MISERE), 'N');
  eq(winMoveCount([3, 5, 7], MISERE), 3, 'same three moves here; the split is in the one-big-heap region');
});

test('the one-big-heap split: misere never plays normal move here', () => {
  // Exactly one heap of two or more stones. Normal wants the xor gone; misère wants an odd
  // number of single stones left, so the two answers are different moves every time.
  const cases = [
    [[5, 1, 1], ['0,1,1'], ['1,1,1']], // normal empties the big heap (xor 5); misere leaves one stone
    [[4], ['0'], ['1']],                 // one heap of four: misere must hand back a single stone
    [[2, 1], ['1,1'], ['0,1']],         // normal mirrors to (1,1); misere empties to (1)
  ];
  for (const [pos, normal, misere] of cases) {
    eq(asRows(pos, winningMoves(pos, NORMAL)), normal, `normal from ${pos}`);
    eq(asRows(pos, winningMoves(pos, MISERE)), misere, `misere from ${pos}`);
  }
});

test('the documented exception: the misere terminal is won with no move to make', () => {
  eq(outcome([0, 0], MISERE), 'N', 'the other player took the last stone and lost');
  eq(winningMoves([0, 0], MISERE), [], 'yet there is nothing to play: outcome N, winMoves 0');
  eq(verdict([0, 0], MISERE).over, true, 'and `over` is what separates that from a real win');
  eq(outcome([0, 0], NORMAL), 'P', 'the same board under normal play is a loss');
});

test('hand-derived P-positions from the theorem statement', () => {
  // Each one is a zero xor worked out in the margin, not a query to the code: 2^4=6 so
  // 2^4^6=0; a doubled heap cancels itself; (1,4,5) and (3,5,6) and (2,5,7) are the
  // three-term ones the eye gets wrong.
  for (const pos of [[1, 1], [2, 2], [7, 7], [1, 2, 3], [2, 4, 6], [1, 4, 5], [3, 5, 6], [2, 5, 7], [4, 4, 4, 4]]) {
    eq(xorOf(pos), 0, `${pos.join(',')} has a zero xor`);
    eq(outcome(pos, NORMAL), 'P');
    eq(winMoveCount(pos, NORMAL), 0, 'no move out of a P-position');
  }
});

test('all-small misere verdicts follow the parity of the single-stone heaps', () => {
  eq(oneHeaps([1, 1, 1, 0]), 3);
  eq(oneHeaps([1, 1, 1, 1]), 4);
  for (const [pos, want] of [[[1], 'P'], [[1, 1, 1], 'P'], [[1, 1, 1, 1], 'N'], [[0], 'N']]) {
    eq(bigHeaps(pos), 0, `${pos.join(',')} is in the all-small region`);
    eq(outcome(pos, MISERE), want);
  }
});

test('the closed form is pure: no expectation leaks into the caller array', () => {
  const pos = [3, 5, 7];
  const before = pos.slice();
  outcome(pos, NORMAL);
  winningMoves(pos, MISERE);
  winMoveCount(pos, NORMAL);
  verdict(pos, MISERE);
  eq(pos, before, 'the array came back unchanged');
});

test('the model validator says no to the shapes this game must never see', () => {
  eq(validate([]), 'a position needs at least one heap');
  ok(validate([1, 2, 3]) === null, 'a plain three-heap position is fine');
  ok(validate([0, 0]) === null, 'an empty board is a legal position, it is simply over');
  ok(/negative/.test(validate([1, -1])), 'a heap cannot be below empty');
  ok(/whole number/.test(validate([1, 1.5])), 'half a stone is not a thing');
  ok(/heaps/.test(validate([1, 1, 1, 1, 1, 1, 1])), 'six heaps is the guard rail');
  ok(/63|exceeds/.test(validate([90])), 'and a heap is capped');
  for (const bad of [[null, { i: 0, to: 0 }], [[0], { i: 0, to: 0 }], [[3], { i: 5, to: 1 }],
    [[3], { i: 0, to: 4 }], [[3], { i: 0, to: 3 }], [[3], { i: 0, to: -1 }]]) {
    eq(legalMove(bad[0], bad[1]), false, `${JSON.stringify(bad)} must be refused`);
  }
  eq(legalMove([3], { i: 0, to: 2 }), true, 'taking one stone from a heap of three is legal');
  eq(applyMove([3, 1], { i: 0, to: 3 }), null, 'taking nothing is not a move');
});

run();

run();
