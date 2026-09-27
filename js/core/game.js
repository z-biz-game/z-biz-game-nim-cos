// A game in progress: the position, whose turn it is, and the two rules that touch it.
// No DOM in here, which is what lets `node --test` and the CDP playtest drive the same
// object the screen does.
//
// One round is "you take, then the machine answers", so `plies` counts both sides: that is
// the unit `par` is printed in and the unit the save file keeps. Undo therefore rewinds a
// whole round — landing back on your own turn, never on the machine's.

import { NORMAL, isRule, validate, legalMove, isTerminal, total } from './heaps.js';
import { outcome, winMoveCount } from './bouton.js';
import { aiMove } from './ai.js';

export function createGame(lot, rule) {
  const active = rule || lot.rule;
  if (!isRule(active)) throw new Error(`unknown rule: ${active}`);
  const err = validate(lot.heaps);
  if (err) throw new Error(err);
  const heaps = lot.heaps.slice();
  return {
    id: lot.id,
    band: lot.band,
    index: lot.index,
    rule: active,
    heaps,
    start: heaps.slice(),
    plies: 0,
    history: [],
    done: false,
    winner: null,
    tookLast: null,
    scores: lot.scores,
  };
}

function other(side) {
  return side === 'you' ? 'ai' : 'you';
}

// The only place the two win conventions differ inside the shell: taking the last stone
// wins under normal play and loses under misère. Everything else — the move rules, the
// closed form, the machine — is shared.
function settle(game, mover) {
  game.done = true;
  game.tookLast = mover;
  game.winner = game.rule === NORMAL ? mover : other(mover);
}

function step(game, side, i, to) {
  const was = game.heaps[i];
  const next = game.heaps.slice();
  next[i] = to;
  game.heaps = next;
  game.history.push({ side, i, was, to });
  game.plies++;
  return { side, i, was, to };
}

// play(game, move) -> { ok, reason? } plus the two plies, or { ok: false, reason }
// An illegal ask (a heap that is not there, taking nothing, reaching across heaps) returns
// false and changes nothing at all: no ply billed, no history entry, no reply from the
// machine. That is the "跨堆点击不动、取 0 枚不计数" requirement, decided here rather than
// in the view so a stray pixel can never disagree with a test.
export function play(game, move) {
  if (game.done) return { ok: false, reason: '这一局已经结束了' };
  if (!legalMove(game.heaps, move)) {
    return { ok: false, reason: '一次只能动一堆，而且至少取走一枚' };
  }
  const you = step(game, 'you', move.i, move.to);
  if (isTerminal(game.heaps)) {
    settle(game, 'you');
    return { ok: true, you, ai: null, terminal: true, kind: null };
  }
  const reply = aiMove(game.heaps, game.rule);
  const ai = step(game, 'ai', reply.move.i, reply.move.to);
  if (isTerminal(game.heaps)) settle(game, 'ai');
  return { ok: true, you, ai, terminal: game.done, kind: reply.kind };
}

// Rewind to before the last move you made. False on an empty history, so the button can
// disable itself instead of claiming to have undone something.
export function undo(game) {
  if (!game.history.length) return false;
  for (;;) {
    const last = game.history.pop();
    const back = game.heaps.slice();
    back[last.i] = last.was;
    game.heaps = back;
    game.plies--;
    if (last.side === 'you') break;
  }
  game.done = false;
  game.winner = null;
  game.tookLast = null;
  return true;
}

export function reset(game) {
  game.heaps = game.start.slice();
  game.plies = 0;
  game.history = [];
  game.done = false;
  game.winner = null;
  game.tookLast = null;
}

// Switch the win convention mid-lot. The stones stay exactly where they are; only who wins
// at the end changes, and the printed numbers come from the row's other column, measured at
// bake time rather than guessed here.
export function setRule(game, rule) {
  if (!isRule(rule)) throw new Error(`unknown rule: ${rule}`);
  game.rule = rule;
  if (game.done) {
    // Whoever took the last stone is a fact about the past; only its meaning changes.
    settle(game, game.tookLast);
  }
  return game.rule;
}

// What the panel prints on your turn: is this position won, and how many moves win it.
// Both are Bouton's closed form — O(k) for k <= 6 heaps, no graph, no table, no search.
export function status(game) {
  const out = outcome(game.heaps, game.rule);
  return {
    outcome: out,
    winMoves: winMoveCount(game.heaps, game.rule),
    winning: out === 'N' && !game.done && total(game.heaps) > 0,
    plies: game.plies,
    stones: total(game.heaps),
    heaps: game.heaps.length,
  };
}

// The verdict on the win card. `perfect` is not an opinion either way: it says you finished
// within the minimax length the bake measured for this lot under the rule you played.
export function grade(game) {
  if (!game.done || !game.winner) return null;
  const score = game.scores && game.scores[game.rule];
  if (game.winner !== 'you') return { key: 'lost', stars: 0, label: '完美玩家赢了' };
  if (score && game.plies <= score.par) return { key: 'perfect', stars: 3, label: '不多一手地赢了' };
  return { key: 'won', stars: 2, label: '赢了，但绕了路' };
}
