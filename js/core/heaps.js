// The Nim model — the whole game in one plain array.
//
//   position = [n1, n2, ...]      k heaps, n_i stones in heap i
//   move     = { i, to }          take n_i - to stones from heap i, with to < n_i
//
// One move touches exactly one heap, must take at least one stone, and may never reach
// across heaps. That is the entire rule book; everything else in this repo is either a
// theorem about this array (`bouton.js`), a search over it (`retro.js`), or pixels.
//
// Two win conventions share this model and every function below:
//
//   normal   the player who takes the last stone wins
//   misere   the player who takes the last stone loses
//
// They are passed as a `rule` field on the same engine rather than as a second engine —
// the same shape the ferry game uses for its boat rule. A zero-size heap is a legal part
// of a position (it just cannot be played with), which is what lets a fixed-k grid stand
// for every smaller k as well: a 0-heap is invisible to the xor and to the move list.

export const NORMAL = 'normal';
export const MISERE = 'misere';
export const RULES = [NORMAL, MISERE];

// Structural ceilings. They are not theorems, they are the guard rails that keep a
// malformed save file or a bad route parameter from allocating a game graph.
export const MAX_HEAPS = 6;
export const MAX_HEAP = 63;

export function isRule(rule) {
  return rule === NORMAL || rule === MISERE;
}

export function xorOf(pos) {
  let x = 0;
  for (let i = 0; i < pos.length; i++) x ^= pos[i];
  return x;
}

export function total(pos) {
  let t = 0;
  for (let i = 0; i < pos.length; i++) t += pos[i];
  return t;
}

// Heaps of two or more stones: the region where Bouton's closed form behaves the same
// under both rules, and the reason `misere` is not just a label on the same game.
export function bigHeaps(pos) {
  let n = 0;
  for (let i = 0; i < pos.length; i++) if (pos[i] >= 2) n++;
  return n;
}

export function oneHeaps(pos) {
  let n = 0;
  for (let i = 0; i < pos.length; i++) if (pos[i] === 1) n++;
  return n;
}

export function isTerminal(pos) {
  return total(pos) === 0;
}

// Structural sanity. Returns null when the position is playable, a sentence when not.
export function validate(pos) {
  if (!Array.isArray(pos)) return 'position must be an array of heap sizes';
  if (pos.length === 0) return 'a position needs at least one heap';
  if (pos.length > MAX_HEAPS) return `too many heaps (max ${MAX_HEAPS})`;
  for (let i = 0; i < pos.length; i++) {
    const n = pos[i];
    if (!Number.isInteger(n)) return `heap ${i} is not a whole number`;
    if (n < 0) return `heap ${i} is negative`;
    if (n > MAX_HEAP) return `heap ${i} exceeds ${MAX_HEAP} stones`;
  }
  return null;
}

// Is this a legal move *in general*? Size-independent: an index and a lower target.
// Anything the board actually allows is checked by `legalMove` below.
export function isMoveShape(move) {
  return !!move
    && Number.isInteger(move.i)
    && Number.isInteger(move.to)
    && move.to >= 0;
}

export function legalMove(pos, move) {
  // A position that is not an array of sizes is a malformed save file or a bad route
  // parameter, not a move request: refuse it the same way instead of throwing inside the UI.
  if (!Array.isArray(pos)) return false;
  if (!isMoveShape(move)) return false;
  if (move.i < 0 || move.i >= pos.length) return false;
  // `to < pos[i]` is "takes at least one stone"; `to >= 0` is "never digs below empty".
  // Cross-heap moves cannot be expressed, which is the point of the {i, to} shape.
  return move.to < pos[move.i];
}

// Apply a move without touching the input. The core is pure end to end: a test can hand
// the same array to the classifier, the AI and the renderer and compare it afterwards.
export function applyMove(pos, move) {
  if (!legalMove(pos, move)) return null;
  const next = pos.slice();
  next[move.i] = move.to;
  return next;
}

// cb(move, nextPosition) for every legal move. Heap order, then descending target, so a
// full enumeration has a deterministic order — the AI relies on that.
export function eachSuccessor(pos, cb) {
  for (let i = 0; i < pos.length; i++) {
    for (let to = pos[i] - 1; to >= 0; to--) {
      const next = pos.slice();
      next[i] = to;
      cb({ i, to }, next);
    }
  }
}

export function successors(pos) {
  const out = [];
  eachSuccessor(pos, (move, next) => out.push({ move, next }));
  return out;
}

// Number of legal moves = number of stones on the board: every stone is a distinct
// "take this many from this heap" choice. Used as the branching factor in the docs.
export function moveCount(pos) {
  return total(pos);
}
