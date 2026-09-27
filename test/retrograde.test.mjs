// The reconciliation. This repo's whole claim is that the closed form in `js/core/bouton.js`
// is not the only voice in the room: a *complete* retrograde analysis over a bounded game
// graph re-derives the same verdicts by enumerating every state, with no theorem involved.
//
// Here that is done exhaustively — every position with k <= 3 heaps and n_i <= 7 stones,
// both win conventions, every one of the 512 states classified, and the two answers compared
// state by state. Zero disagreements is not a wish here, it is the assertion.
//
// Three writings of the same question are compared, not two:
//   * `bouton.js`    the closed form (xor, plus the misère endgame split)
//   * `retro.js`     bottom-up retrograde analysis over the graph, buckets ordered by depth
//   * `minimax.mjs`  top-down minimax by the raw definition, memoised, no ordering argument
// so a shared mistake in the depth logic would have to be a mistake in all three.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NORMAL, MISERE, RULES, isTerminal, successors } from '../js/core/heaps.js';
import { outcome, winningMoves, winMoveCount } from '../js/core/bouton.js';
import {
  RetroCap, gridOf, retrograde, resolveState, winningMoveSet, measure, positionScores, engineInfo,
} from '../js/core/retro.js';
import { naive, closedFormOutcome, NaiveCap } from './minimax.mjs';

// The spec's reconciliation box: k <= 3, n_i <= 7. Positions with fewer heaps are the same
// box with trailing zeros (a 0-heap has no moves and contributes nothing to an xor), so this
// one grid covers k = 1, 2 and 3 at once.
const BOX = [7, 7, 7];
const g = gridOf(BOX);
const an = {
  normal: retrograde(g, NORMAL),
  misere: retrograde(g, MISERE),
};

// Every position of the box, in grid order, without allocating per query.
function eachPosition(fn) {
  const dig = new Array(g.k);
  for (let id = 0; id < g.size; id++) {
    g.digits(id, dig);
    fn(id, dig.slice());
  }
}

test('the box is what it claims to be: 512 states, k<=3, n_i<=7, every one labelled', () => {
  eq(g.size, 512, '8 * 8 * 8 positions');
  eq(g.maxVec, BOX);
  eq(g.maxTokens, 21, 'the longest play on this box is 21 plies, so the depth buckets span 0..21');
  ok(an.normal.edges > 4000, `forward edges counted: ${an.normal.edges}`);
  let nStates = 0;
  let pStates = 0;
  eachPosition((id, pos) => {
    const o = an.normal.outcomeOf(id);
    ok(o === 'N' || o === 'P', `${pos} got no verdict`);
    if (o === 'N') nStates++;
    else pStates++;
  });
  eq(nStates + pStates, 512, 'nothing left unlabelled — retrograde itself throws otherwise');
  // The P-count is hand-derivable on this box, which is a fifth check nobody coded for: the
  // losing positions are exactly the (a, b, a^b) triples, and a^b <= 7 whenever a, b <= 7, so
  // there is one per pair — 64 of them. If the graph mislabelled a single state this would move.
  eq(pStates, 64, `the graph found ${pStates} P-positions in a box holding exactly 64`);
  eq(nStates, 448, 'and every other state is a first-player win');
});

test('normal play: all 512 states agree with the closed form, with the naive minimax, and on depth', () => {
  const memo = new Map();
  const nodes = { n: 0 };
  let outcomeDiff = 0;
  let depthDiff = 0;
  let winDiff = 0;
  let setDiff = 0;
  let checked = 0;
  eachPosition((id, pos) => {
    checked++;
    const retro = resolveState(an.normal, pos);
    const byDef = naive(pos, NORMAL, { memo, nodes, maxNodes: 200000 });
    if (retro.outcome !== outcome(pos, NORMAL) || retro.outcome !== closedFormOutcome(pos, NORMAL)) {
      outcomeDiff++;
    }
    if (retro.plies !== byDef.plies) depthDiff++;
    if (retro.outcome !== byDef.outcome) outcomeDiff++;
    const cf = winningMoves(pos, NORMAL);
    if (retro.winMoves !== cf.length) winDiff++;
    const asRetro = winningMoveSet(an.normal, pos).map((m) => `${m.i}>${m.to}`);
    const asClosed = cf.map((m) => `${m.i}>${m.to}`);
    if (asRetro.join(' ') !== asClosed.join(' ')) setDiff++;
  });
  eq(checked, 512, 'this is a full sweep, not a sample');
  eq(outcomeDiff, 0, 'N/P verdicts: graph vs closed form vs definition, zero disagreements');
  eq(depthDiff, 0, 'par (shortest forced win under maximal resistance) matches on every state');
  eq(winDiff, 0, 'the graph counts its own P-successors; the closed form lists them');
  eq(setDiff, 0, 'not just the count: the winning move *sets* are identical, state by state');
});

test('misere: the same full sweep, same zero', () => {
  const memo = new Map();
  const nodes = { n: 0 };
  let outcomeDiff = 0;
  let depthDiff = 0;
  let setDiff = 0;
  let checked = 0;
  eachPosition((id, pos) => {
    checked++;
    const retro = resolveState(an.misere, pos);
    const byDef = naive(pos, MISERE, { memo, nodes, maxNodes: 200000 });
    const cf = winningMoves(pos, MISERE);
    if (retro.outcome !== outcome(pos, MISERE) || retro.outcome !== closedFormOutcome(pos, MISERE)) outcomeDiff++;
    if (retro.outcome !== byDef.outcome || retro.plies !== byDef.plies) depthDiff++;
    const asRetro = winningMoveSet(an.misere, pos).map((m) => `${m.i}>${m.to}`).join(' ');
    const asClosed = cf.map((m) => `${m.i}>${m.to}`).join(' ');
    if (asRetro !== asClosed) setDiff++;
  });
  eq(checked, 512);
  eq(outcomeDiff, 0, 'misere verdicts reconcile everywhere, including the all-small region');
  eq(depthDiff, 0, 'misere depths reconcile too — the endgame split does not break the ordering');
  eq(setDiff, 0, 'and the one-big-heap move the closed form derives by hand is the move the graph finds');
});

test('the two rules do disagree, and the disagreement is exactly the all-heaps-<=1 region', () => {
  let differs = 0;
  let differsOutsideSmall = 0;
  let agreesInsideSmall = 0;
  const samples = [];
  eachPosition((id, pos) => {
    const a = an.normal.outcomeOf(id);
    const b = an.misere.outcomeOf(id);
    const allSmall = pos.every((n) => n <= 1);
    if (a !== b) {
      differs++;
      if (!allSmall) {
        differsOutsideSmall++;
        samples.push(pos);
      }
    } else if (allSmall) {
      agreesInsideSmall++;
    }
  });
  ok(differs > 0, 'misere must not be a cosmetic flag: the verdicts have to split somewhere');
  eq(differs, 8, 'exactly the 2^3 all-small positions of this box');
  eq(differsOutsideSmall, 0, `not one position with a heap of two or more differs: ${samples.join(' | ')}`);
  eq(agreesInsideSmall, 0, 'and not one all-small position agrees — the split is total, so it is a region');
  // The strongest reading of the same sweep: outside that region the two analyses are the
  // same analysis, so the `rule` field only ever matters in the endgame.
  eq(measure([1, 1, 1]).normal.outcome, 'N', 'three single stones under normal: take one, hand over the pair, win');
  eq(measure([1, 1, 1]).misere.outcome, 'P', 'the same board under misere loses: an odd pile count is the losing one');
});

test('the base case is the only rule-dependent line, and it inverts the empty board', () => {
  const empty = [0, 0, 0];
  ok(isTerminal(empty), 'nothing to take');
  eq(successors(empty).length, 0, 'no legal move at all');
  eq(resolveState(an.normal, empty).outcome, 'P', 'normal: the player to move has no move and loses');
  eq(resolveState(an.misere, empty).outcome, 'N', 'misere: the player to move has already won');
  eq(resolveState(an.normal, empty).plies, 0);
  eq(resolveState(an.misere, empty).plies, 0);
  eq(resolveState(an.misere, empty).winMoves, 0, 'the documented exception: N with no move to make');
  eq(outcome(empty, MISERE), 'N', 'and the closed form says the same, from the other direction');
});

test('hand-checked depths: the small end of the graph, computed by nobody but the definition', () => {
  const cases = [
    // [position, rule, outcome, plies, winMoves] — each derived by hand above, not read out
    // of the engine: a single heap is the whole game in miniature.
    [[1, 0, 0], NORMAL, 'N', 1, 1],   // take it, you took the last stone, you win
    [[1, 0, 0], MISERE, 'P', 1, 0],   // the same move loses; there is no other
    [[2, 0, 0], MISERE, 'N', 2, 1],   // leave exactly one stone: 2 -> 1, opponent must take it
    [[3, 1, 0], MISERE, 'N', 2, 1],   // one big heap and one single: emptying the big one is the only road
    [[3, 1, 0], NORMAL, 'N', 3, 1],   // xor 2 -> heap 0 to 1: (1,1) is a P-position, then two more plies
    [[2, 2, 0], NORMAL, 'P', 4, 0],   // mirror image, lost whatever you do; the loser drags to 4
    [[0, 0, 0], NORMAL, 'P', 0, 0],
  ];
  for (const [pos, rule, o, plies, wins] of cases) {
    const r = resolveState(an[rule === NORMAL ? 'normal' : 'misere'], pos);
    eq(r.outcome, o, `${pos.join(',')} under ${rule}`);
    eq(r.plies, plies, `${pos.join(',')} under ${rule} lasts this many plies`);
    eq(r.winMoves, wins, `${pos.join(',')} under ${rule} winning roads`);
    eq(naive(pos, rule, {}).plies, plies, 'the top-down definition agrees');
  }
});

test('a second, wider reconciliation on the grid the pool is baked from: 10,000 states', () => {
  const info = engineInfo();
  eq(info.states, 10000, 'the shipped grid is 9x9x9x9');
  eq(info.edges, 180000);
  const wide = gridOf(info.maxVec, { maxStates: info.states });
  const n = retrograde(wide, NORMAL);
  const m = retrograde(wide, MISERE);
  let checked = 0;
  let diff = 0;
  let evenWins = 0;
  let oddWins = 0;
  const dig = new Array(4);
  for (let id = 0; id < wide.size; id++) {
    wide.digits(id, dig);
    const pos = dig.slice();
    checked++;
    const a = resolveState(n, pos);
    const b = resolveState(m, pos);
    if (a.outcome !== outcome(pos, NORMAL) || a.winMoves !== winMoveCount(pos, NORMAL)) diff++;
    if (b.outcome !== outcome(pos, MISERE) || b.winMoves !== winMoveCount(pos, MISERE)) diff++;
    // A theorem nobody stated in the spec, found in this sweep and worth pinning down: under
    // normal play the number of winning moves is the number of heaps carrying the top set bit
    // of the xor, so it is always odd. "winMoves = 2" simply does not exist outside misere.
    if (a.outcome === 'N' && !isTerminal(pos)) {
      if (a.winMoves % 2 === 0) evenWins++;
      else oddWins++;
    }
  }
  eq(checked, 10000, 'all of it, both rules, four heaps up to nine stones');
  eq(diff, 0, 'zero disagreements on the grid every shipped number came from');
  eq(evenWins, 0, 'an even number of normal-play winning moves never happens');
  ok(oddWins > 4000, `${oddWins} normal-play N-positions, every one with an odd number of roads out`);
});

test('the grid trick: a short position and its zero-padded twin get the same answer', () => {
  // The pool's rows are stored as 3- and 4-heap arrays and looked up on a 4-dim grid, while
  // this file's box is 3-dim. If padding were wrong the two would diverge on the same heaps.
  for (const heaps of [[3, 5, 7], [2, 2, 2], [1, 1], [4], [1, 2, 3]]) {
    const onThree = measure(heaps);
    const padded = heaps.concat([0, 0, 0]);
    const onOwnBox = positionScores(padded);
    for (const rule of RULES) {
      eq(onThree[rule].outcome, onOwnBox[rule].outcome, `${heaps} ${rule}: a 0-heap must be invisible`);
      eq(onThree[rule].par, onOwnBox[rule].par, `${heaps} ${rule} depth`);
      eq(onThree[rule].winMoves, onOwnBox[rule].winMoves, `${heaps} ${rule} winning roads`);
    }
  }
});

test('state cap and deadline both throw RetroCap rather than returning a wrong number', () => {
  let cap = null;
  try {
    gridOf([31, 31, 31], { maxStates: 1000 });
  } catch (err) {
    cap = err;
  }
  ok(cap instanceof RetroCap, 'a 32,768-state box against a 1,000 cap must refuse');
  ok(/needs 32768 states, cap is 1000/.test(cap.message), `the refusal names both numbers: ${cap.message}`);
  let overEngine = null;
  try {
    measure([63, 63, 63]);
  } catch (err) {
    overEngine = err;
  }
  ok(overEngine instanceof RetroCap, 'the same cap protects the call sites: 262,144 states is not this engine\'s box');
  let late = null;
  try {
    retrograde(gridOf([31, 31, 31]), NORMAL, { deadlineMs: 1 });
  } catch (err) {
    late = err;
  }
  ok(late instanceof RetroCap, `a search past its deadline must abort instead of trailing off: ${late}`);
  ok(/deadline/.test(late.message), 'and it says so');
  // ...and the same box, unsqueezed, does finish — so the throws above are about the budget
  // and not about a broken walk.
  const big = retrograde(gridOf([31, 31, 31]), NORMAL);
  eq(big.size, 32768, 'the third grid in this file, 64 times the spec box, solved completely');
  eq(resolveState(big, [31, 31, 0]).outcome, 'P', 'a pair is a pair at any size');
  eq(resolveState(big, [31, 31, 31]).outcome, 'N', 'three equal heaps: xor 31, so one road exists');
  eq(winMoveCount([31, 31, 31], NORMAL), 3, 'and the closed form finds three of them');
  let naiveCap = null;
  try {
    naive([7, 7, 7, 7], NORMAL, { maxNodes: 10 });
  } catch (err) {
    naiveCap = err;
  }
  ok(naiveCap instanceof NaiveCap, 'the naive minimax has its own budget and refuses to overrun it');
});

test('the engine is independent of the theorem it is checking', () => {
  const src = readFileSync(fileURLToPath(new URL('../js/core/retro.js', import.meta.url)), 'utf8');
  // Strip the prose before searching it: the comments in retro.js discuss the xor openly,
  // and the claim under test is about its *reasoning*, not about its vocabulary.
  const code = src.replace(/^\s*\/\/.*$/gm, '');
  ok(!/bouton/i.test(code), 'retro.js never imports the closed form it is being compared with');
  ok(!/\bxor\b/i.test(code), 'and never computes one');
  ok(!/Math\.random/.test(code), 'no randomness anywhere in the engine');
  ok(/from '\.\/heaps\.js'/.test(code), 'it reads only the model: heaps, moves, and the rule label');
  ok(!/require\(|window|document/.test(code), 'pure Node-side code, usable by the bake and by tests alike');
});

test('nothing in this file mutates a position, the engine or its caller', () => {
  const pos = [3, 5, 7];
  const before = pos.slice();
  const g2 = gridOf([7, 7, 7]);
  const a2 = retrograde(g2, NORMAL);
  resolveState(a2, pos);
  winningMoveSet(a2, pos);
  measure(pos);
  positionScores(pos);
  eq(pos, before, 'the caller array is untouched by four reads');
  eq(a2.outcomeOf(g2.idx(pos)), 'N', 'the completed analysis still answers afterwards');
  eq(g2.size, 512, 'and the grid it was read out of is still the same grid');
  // Two independent builds of the same box must produce identical tables: no hidden state,
  // no memo that leaks between runs.
  const a3 = retrograde(gridOf([7, 7, 7]), MISERE);
  const b3 = retrograde(gridOf([7, 7, 7]), MISERE);
  for (let id = 0; id < a3.size; id++) {
    eq(a3.label[id], b3.label[id], `state ${id} classified twice, differently`);
    eq(a3.plies[id], b3.plies[id], `state ${id} measured twice, differently`);
  }
});

run();
