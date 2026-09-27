// The perfect player. No search, no randomness, no difficulty knob: the closed form in
// `bouton.js` *is* the strongest possible play, so there is nothing to tune. Weakening it
// would be a coin flip dressed up as a setting, which is why this repo has no such option.
//
// Every reply is deterministic and re-derivable: run this file over the position you see
// on screen and you get the move that was played, every time.

import { bigHeaps, isTerminal, legalMove } from './heaps.js';
import { winningMoves } from './bouton.js';

// When the position is won, take *the* winning move — the first heap that has one. Any
// move into a P-position is perfect play; which one is irrelevant to the result. (It is
// not irrelevant to `par`, which assumes the winner also plays for the shortest game, so
// a player who wins may take more plies than the printed par. README says so.)
//
// When the position is lost, stall: take exactly one stone, from the largest heap, so the
// board shrinks as slowly as the rules allow. This is a heuristic, not the minimax
// maximiser the `par` number uses — and it can only ever make a lost game end *sooner*,
// never later, because the engine's `par` already takes the maximum over every stall.
export function aiMove(pos, rule) {
  if (isTerminal(pos)) return null;
  const win = winningMoves(pos, rule).filter((m) => legalMove(pos, m));
  if (win.length) return { move: win[0], kind: 'winning' };
  let i = 0;
  for (let j = 1; j < pos.length; j++) if (pos[j] > pos[i]) i = j;
  if (pos[i] === 0) return null; // unreachable: a terminal board was handled above
  return { move: { i, to: pos[i] - 1 }, kind: 'delaying' };
}

// Why the machine moved the way it did — the panel prints this instead of pretending the
// opponent is merely "good". Note that a misère winning move need not zero the xor: with
// one big heap left the correct move is to hand back an odd number of single stones, so
// the sentence below stays at the level of what is actually guaranteed (P 位), not of how
// it was computed. `bouton.js` has the derivation.
export function rationale(kind) {
  if (kind === 'winning') return '把局面交成一个 P 位（必败位）给你';
  if (kind === 'delaying') return '它也已经赢不了：一次只取一枚，尽量拖';
  return '无子可取';
}
