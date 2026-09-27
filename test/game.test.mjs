// The shell: a game in progress, the machine that answers it, and the two things the player
// is actually promised.
//
//   1. an illegal ask changes *nothing* — no ply billed, no history entry, no reply
//   2. when the machine is winning it never lets go: every one of its replies is a P-position,
//      checked state by state over a whole grid rather than asserted in a comment
//
// The opponent here is perfect, not "strong". There is no difficulty setting to weaken it
// with, and `bouton.js` is why: one xor answers the whole question, so a weaker engine would
// have to be a deliberately blind one.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NORMAL, MISERE, RULES, isTerminal, legalMove, applyMove, total, moveCount } from '../js/core/heaps.js';
import { outcome, winningMoves, winMoveCount, isP } from '../js/core/bouton.js';
import { aiMove, rationale } from '../js/core/ai.js';
import { createGame, play, undo, reset, setRule, status, grade } from '../js/core/game.js';
import { ALL, byId, campaign } from '../js/core/library.js';
import { gridOf, retrograde, resolveState } from '../js/core/retro.js';
import { naive } from './minimax.mjs';

// The human side of a losing game still has to be able to move: take one stone, the same
// stall the machine uses. `optimal` alone cannot express "you already lost", and that is
// precisely the case the test below cares about.
const stall = (pos) => {
  let i = 0;
  for (let j = 1; j < pos.length; j++) if (pos[j] > pos[i]) i = j;
  return pos[i] > 0 ? { i, to: pos[i] - 1 } : null;
};

const optimal = (pos, rule) => winningMoves(pos, rule)[0] || null;
const perfectLine = (pos, rule) => winningMoves(pos, rule)[0] || stall(pos);

// Play a lot to its end. `subject` is a baked row (heaps + scores) or a bare {heaps}.
function runGame(subject, rule, policy, limit = 200) {
  const heaps = subject.heaps;
  const g = createGame({
    id: subject.id || 'probe',
    band: subject.band || 'probe',
    index: 0,
    heaps,
    rule,
    scores: subject.scores || { [rule]: { par: 0 } },
  }, rule);
  const roads = [];
  while (!g.done) {
    if (roads.length > limit) throw new Error(`${subject.id}: a game that never ends is a bug`);
    const move = policy(g.heaps, rule);
    if (!move) break;
    const r = play(g, move);
    if (!r.ok) throw new Error(`${subject.id}: the policy asked for an illegal move ${JSON.stringify(move)}`);
    roads.push({ you: move, ai: r.ai });
  }
  return { game: g, roads };
}

test('a cross-heap click and a zero-stone take are refused without touching the game', () => {
  const g = createGame(byId('spark-01'), NORMAL);
  const start = g.heaps.slice();
  const asks = [
    { i: 0, to: g.heaps[1] },        // "reach across" expressed the only way the shape allows
    { i: 0, to: g.heaps[0] },        // take nothing
    { i: 0, to: g.heaps[0] + 1 },    // put a stone back
    { i: 9, to: 0 },                 // a heap that is not there
    { i: -1, to: 0 },
    { i: 0, to: -3 },                // below empty
    { i: 0.5, to: 0 },               // a pixel, not an index
    { i: '0', to: 0 },               // a route parameter, not an index
    { to: 0 },                       // no heap named at all
    null,
    'spark-01',
  ];
  for (const ask of asks) {
    const r = play(g, ask);
    eq(r.ok, false, `${JSON.stringify(ask)} must be refused`);
    eq(r.reason, '一次只能动一堆，而且至少取走一枚', 'and it says why, in the words the UI prints');
    eq(g.heaps, start, 'the board did not move');
    eq(g.plies, 0, 'no ply was billed');
    eq(g.history.length, 0, 'nothing to undo');
    eq(g.done, false, 'and the game is still running');
  }
  eq(legalMove([3, 5], { i: 0, to: 5 }), false, 'a target above the heap it names is not a move');
  eq(legalMove([3, 5], { i: 1, to: 3 }), true, 'the same numbers on the right heap are');
  eq(applyMove([3, 5], { i: 0, to: 3 }), null, 'and applying an illegal one returns nothing, not a fake board');
});

test('the machine always has an answer, and never an illegal one', () => {
  const g = gridOf([7, 7, 7]);
  const an = { normal: retrograde(g, NORMAL), misere: retrograde(g, MISERE) };
  let checked = 0;
  let terminals = 0;
  const dig = new Array(3);
  for (let id = 0; id < g.size; id++) {
    g.digits(id, dig);
    const pos = dig.slice();
    for (const rule of RULES) {
      const reply = aiMove(pos, rule);
      if (isTerminal(pos)) {
        eq(reply, null, `${pos} under ${rule}: nothing to take, so no move`);
        terminals++;
        continue;
      }
      checked++;
      ok(reply && reply.move, `${pos} under ${rule} produced no reply at all`);
      ok(legalMove(pos, reply.move), `${pos} under ${rule}: the reply ${JSON.stringify(reply.move)} is illegal`);
      ok(reply.kind === 'winning' || reply.kind === 'delaying', `kind ${reply.kind} is not a kind`);
      // The verdict the *graph* put on the position decides which kind of reply is correct,
      // so this row compares the machine against the search rather than against the formula.
      const won = resolveState(an[rule], pos).outcome === 'N';
      eq(reply.kind, won ? 'winning' : 'delaying', `${pos} under ${rule} is a ${won ? 'win' : 'loss'} for the mover`);
    }
  }
  eq(terminals, 2, 'one empty board per rule');
  eq(checked, 1022, 'every non-terminal state of the box, under both conventions');
});

test('when the machine is winning it lands on a P-position every single move', () => {
  // The "perfect opponent" claim, stated as something a test can falsify: after the machine's
  // reply, the board the human is left holding has no winning move at all.
  const memo = new Map();
  let replies = 0;
  let missed = 0;
  const offenders = [];
  const g = gridOf([6, 6, 6, 6], { maxStates: 20000 });
  const dig = new Array(4);
  for (let id = 0; id < g.size; id++) {
    g.digits(id, dig);
    const pos = dig.slice();
    for (const rule of RULES) {
      if (isTerminal(pos) || outcome(pos, rule) !== 'N') continue;
      const reply = aiMove(pos, rule);
      const after = applyMove(pos, reply.move);
      replies++;
      if (!isP(after, rule) || winMoveCount(after, rule) !== 0) missed++;
      // The definition, not the theorem, says the same thing about that reply.
      if (naive(after, rule, { memo }).outcome !== 'P') missed++;
      if (missed && offenders.length < 5) offenders.push(`${pos.join(',')} ${rule}`);
    }
  }
  ok(replies > 4000, `${replies} winning replies examined across four heaps of six, not a handful`);
  eq(missed, 0, `every one of them leaves zero winning moves for the human (${offenders.join(', ')})`);
});

test('play the perfect line and you win; slip once and the machine takes the win away', () => {
  let checked = 0;
  for (const row of campaign()) {
    const perfect = runGame(row, row.rule, perfectLine);
    ok(perfect.game.done, `${row.id} never finished`);
    eq(perfect.game.winner, 'you', `${row.id}: the winning side of an N-position keeps winning`);
    ok(perfect.game.plies >= 2, `${row.id} ended without the machine ever answering`);
    checked++;
    // One slip: the first legal move the closed form does not recommend. Every shipped lot has
    // one, because an N-position with a single road out still has more stones than that road.
    const recommended = winningMoves(row.heaps, row.rule);
    let giveAway = null;
    for (let i = 0; i < row.heaps.length && !giveAway; i++) {
      for (let to = row.heaps[i] - 1; to >= 0 && !giveAway; to--) {
        const m = { i, to };
        if (isP(applyMove(row.heaps, m), row.rule)) continue;
        if (recommended.some((r) => r.i === i && r.to === to)) continue;
        giveAway = m;
      }
    }
    if (!giveAway) {
      // The two all-small misere lots: with an even number of single stones *any* take is
      // right, so there is no way to lose them and nothing to check here. Said out loud,
      // rather than skipped in silence.
      eq(recommended.length, moveCount(row.heaps), `${row.id}: every legal move is a winning one`);
      eq(row.heaps.every((n) => n === 1), true, `${row.id}: and they are all single stones`);
    } else {
      let first = true;
      const bad = runGame(row, row.rule, (pos, rule) => {
        if (first) { first = false; return giveAway; }
        return stall(pos);
      });
      eq(bad.game.winner, 'ai', `${row.id}: one wrong stone, then perfect resistance, and it is still lost`);
      eq(grade(bad.game), { key: 'lost', stars: 0, label: '完美玩家赢了' });
    }
  }
  eq(checked, ALL.length, 'every lot on the shelf, both directions, no sampling');
});

test('undo rewinds a whole round, never lands you on the machine\'s turn, and revives a loss', () => {
  const row = byId('nerve-05');
  const g = createGame(row, row.rule);
  eq(undo(g), false, 'nothing has been played yet, so there is nothing to claim to undo');
  eq(g.heaps, row.heaps);
  const before = g.heaps.slice();
  const played = play(g, winningMoves(before, row.rule)[0]);
  ok(played.ok && played.ai, 'the machine answered');
  eq(g.plies, 2, 'one round is two plies and is counted as two');
  ok(undo(g), 'and undoing it works');
  eq(g.plies, 0, 'the whole round went back, not one ply of it');
  eq(g.heaps, before, 'the board is the board');
  eq(g.history.length, 0);
  for (let n = 0; n < 4; n++) {
    ok(play(g, winningMoves(g.heaps, g.rule)[0]).ok, `round ${n + 1} played`);
  }
  eq(g.plies, 8);
  ok(undo(g));
  eq(g.plies, 6, 'again exactly one round');
  eq(outcome(g.heaps, g.rule), 'N', 'and it is your turn again, as it must be');
  ok(undo(g) && undo(g) && undo(g));
  eq(g.plies, 0);
  eq(undo(g), false, 'undo is honest about running out');
  // A finished game can be stepped back into: the win card offers 回退一手 for exactly this.
  const done = runGame({ heaps: [3, 5, 7] }, NORMAL, perfectLine);
  ok(done.game.done && done.game.winner === 'you');
  ok(undo(done.game), 'undo after the last stone');
  eq(done.game.done, false, 'the game is live again');
  eq(done.game.winner, null, 'and the verdict is withdrawn, not left on screen');
  eq(done.game.tookLast, null, 'including who took the last stone');
});

test('the rule toggle keeps the stones where they are and changes only who wins at the end', () => {
  // (1,1) is the shipped oddball: lost under normal play, won under misère, same two stones.
  const row = byId('oddball-01');
  eq(row.heaps, [1, 1]);
  eq(row.scores.normal.outcome, 'P');
  eq(row.scores.misere.outcome, 'N');
  const g = createGame(row, MISERE);
  const r = play(g, { i: 0, to: 0 });
  ok(r.ok && r.ai, 'the machine answered with the last stone');
  eq(g.heaps, [0, 0], 'and the board is empty');
  eq(g.plies, 2);
  ok(g.done);
  eq(g.tookLast, 'ai', 'the machine took the last stone');
  eq(g.winner, 'you', 'misere: taking the last stone is losing, so the win is yours');
  eq(grade(g), { key: 'perfect', stars: 3, label: '不多一手地赢了' }, 'two plies against a two-ply par');
  const heaps = g.heaps.slice();
  setRule(g, NORMAL);
  eq(g.heaps, heaps, 'the stones did not move');
  eq(g.winner, 'ai', 'the same finished board, read under normal play, is the other result');
  eq(grade(g), { key: 'lost', stars: 0, label: '完美玩家赢了' });
  setRule(g, MISERE);
  eq(g.winner, 'you', 'and back again — the past is fixed, only its meaning moved');
  let threw = null;
  try {
    setRule(g, 'normal-ish');
  } catch (err) {
    threw = err;
  }
  ok(threw && /unknown rule/.test(threw.message), `an unknown rule is a refusal, not a silent normal game: ${threw}`);
  eq(createGame(row).rule, MISERE, 'a game with no explicit rule takes the lot\'s own');
  eq(createGame(row, NORMAL).rule, NORMAL, 'and the panel can still override it');
});

test('status prints closed-form numbers, and prints them the same way for every lot', () => {
  const mirror = createGame({ heaps: [2, 2], rule: NORMAL, id: 'm', band: 'm', index: 0, scores: {} }, NORMAL);
  eq(status(mirror), { outcome: 'P', winMoves: 0, winning: false, plies: 0, stones: 4, heaps: 2 },
    'a pair is a loss for the mover, and the panel says 本步不胜');
  play(mirror, { i: 0, to: 1 });
  eq(mirror.heaps, [1, 1], 'the machine handed back the other pair');
  eq(status(mirror), { outcome: 'P', winMoves: 0, winning: false, plies: 2, stones: 2, heaps: 2 });
  const win = createGame({ heaps: [3, 5, 7], rule: NORMAL, id: 'w', band: 'w', index: 0, scores: {} }, NORMAL);
  eq(status(win), { outcome: 'N', winMoves: 3, winning: true, plies: 0, stones: 15, heaps: 3 });
  play(win, { i: 0, to: 2 });
  eq(status(win).plies, 2, 'two plies billed: yours and the reply');
  eq(status(win).stones, total(win.heaps));
  ok(win.heaps.reduce((a, b) => a + b, 0) < 15, 'the board only ever shrinks');
  for (const row of ALL) {
    const s = status(createGame(row, row.rule));
    eq(s.outcome, row.outcome, `${row.id} outcome`);
    eq(s.winMoves, row.winMoves, `${row.id} winning moves`);
    eq(s.stones, total(row.heaps));
    eq(s.heaps, row.heaps.length);
    eq(s.winning, true, `${row.id}: every shipped lot is a first-player win, so the first panel is 必胜`);
  }
});

test('grade is measured against the certified par, and par is a real measured number', () => {
  const row = byId('knife-01');
  eq(row.scores[row.rule].par, row.par, 'the row and its own-rule score agree');
  const won = runGame(row, row.rule, perfectLine);
  ok(won.game.done && won.game.winner === 'you');
  const at = (plies) => {
    won.game.plies = plies;
    return grade(won.game);
  };
  eq(at(row.par), { key: 'perfect', stars: 3, label: '不多一手地赢了' }, 'exactly par is perfect');
  eq(at(row.par - 1), { key: 'perfect', stars: 3, label: '不多一手地赢了' },
    'better than par grades the same: par is a floor, not a target');
  eq(at(row.par + 1), { key: 'won', stars: 2, label: '赢了，但绕了路' }, 'one stone over par is a detour, said plainly');
  eq(at(999).key, 'won', 'however long the detour, the hero still won');
  won.game.winner = 'ai';
  eq(grade(won.game).key, 'lost', 'and a loss is never dressed up as a near miss');
  eq(grade(createGame(row, row.rule)), null, 'no verdict before the game is over');
  // par itself: the shortest forced win under maximal resistance, re-derived from the raw
  // definition rather than from the engine that printed it, on four shipped lots.
  for (const id of ['spark-01', 'deep-01', 'twitch-01', 'oddball-02']) {
    const r = byId(id);
    for (const rule of RULES) {
      eq(naive(r.heaps, rule, {}).plies, r.scores[rule].par, `${id} ${rule} par, by definition`);
    }
  }
});

test('the machine is a function of the position: no dice, no memory, no difficulty knob', () => {
  const src = readFileSync(fileURLToPath(new URL('../js/core/ai.js', import.meta.url)), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/Math\.random/.test(src), 'ai.js contains no randomness at all');
  ok(!/Date\.now|new Date/.test(src), 'nor any clock to be noisy with');
  ok(!/^(let|var)\s/m.test(src), 'and no module-level state to carry between moves');
  const seen = new Map();
  const g = gridOf([5, 5, 5], { maxStates: 20000 });
  const dig = new Array(3);
  for (let id = 0; id < g.size; id++) {
    g.digits(id, dig);
    const pos = dig.slice();
    for (const rule of RULES) {
      if (isTerminal(pos)) continue;
      const first = JSON.stringify(aiMove(pos, rule));
      for (let n = 0; n < 3; n++) {
        eq(JSON.stringify(aiMove(pos, rule)), first, `${rule} ${pos} answered differently on run ${n + 1}`);
      }
      seen.set(`${rule}|${pos}`, first);
    }
  }
  eq(seen.size, 430, 'the whole box, both rules, each one answered identically six times over');
  eq(rationale('winning'), '把局面交成一个 P 位（必败位）给你');
  eq(rationale('delaying'), '它也已经赢不了：一次只取一枚，尽量拖');
  eq(rationale('nothing'), '无子可取');
});

test('a lost game is still a legal game: the machine\'s stall never outlasts par', () => {
  // The stall is a heuristic, not the minimax maximiser, and the honest statement of it is
  // that it can lose *faster* than the printed par, never slower — because par already takes
  // the maximum over every move the losing side could try.
  const memo = new Map();
  let stalls = 0;
  let over = 0;
  const g = gridOf([5, 5, 5], { maxStates: 20000 });
  const dig = new Array(3);
  for (let id = 0; id < g.size; id++) {
    g.digits(id, dig);
    const pos = dig.slice();
    for (const rule of RULES) {
      if (isTerminal(pos) || outcome(pos, rule) !== 'P') continue;
      const reply = aiMove(pos, rule);
      eq(reply.kind, 'delaying', `${pos} ${rule}: a lost position must not claim a winning move`);
      const after = applyMove(pos, reply.move);
      eq(total(pos) - total(after), 1, 'a stall takes exactly one stone');
      ok(total(pos) > 0, 'and there was a stone to take');
      const par = naive(pos, rule, { memo }).plies;
      const byStall = 1 + naive(after, rule, { memo }).plies;
      if (byStall > par) over++;
      stalls++;
    }
  }
  eq(stalls, 55, 'every P-position of that box under both conventions, counted');
  eq(over, 0, 'no stall ever outlasts the measured par, so the number on screen stays honest');
});

test('reset brings the lot back exactly, and a game never shares an array with the pool', () => {
  const row = byId('nerve-01');
  const frozen = JSON.stringify(row.heaps);
  const g = createGame(row, row.rule);
  eq(g.heaps, row.heaps, 'same numbers');
  ok(g.heaps !== row.heaps, 'different array: playing a lot must not mutate the pool');
  ok(g.start !== g.heaps, 'and the snapshot is a snapshot');
  for (let n = 0; n < 3; n++) ok(play(g, perfectLine(g.heaps, g.rule)).ok);
  reset(g);
  eq(g.heaps, row.heaps, 'reset is exact');
  eq(g.plies, 0);
  eq(g.history.length, 0);
  eq(g.done, false);
  eq(g.winner, null);
  eq(JSON.stringify(row.heaps), frozen, 'and the pool itself is untouched by all of that');
  eq(moveCount(row.heaps), total(row.heaps), 'the branching factor the docs quote is the stone count');
});

run();
