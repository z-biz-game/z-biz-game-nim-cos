// The save file: one localStorage key, plain JSON, a versioned shape so an old save is
// recognised rather than mistaken for a new one.
//
// Records are keyed by lot id; `best` is the fewest total plies you have needed to win that
// lot, `unlocked` is the campaign pointer, `daily` logs one entry per calendar day.
// Everything degrades to a memory-only session when localStorage is refused — under file://
// (where this build cannot run at all, see README), in a private window, and in every
// `node --test` process, which has no window to begin with.

const KEY = 'nim.save.v1';

function backend() {
  try {
    return window.localStorage;
  } catch (err) {
    // ReferenceError under Node, SecurityError in a blocked third-party context.
    return null;
  }
}

// A hand-edited or half-written save can carry anything in a numeric field. Coerce instead of
// trusting: `undefined + 1` is NaN, and NaN serialises to `null`, which then reads back as a
// record that plays forever without ever counting.
function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function blank() {
  return {
    records: {},
    daily: {},
    unlocked: 1,
    stats: { plays: 0, wins: 0, losses: 0, plies: 0 },
  };
}

let cache = null;

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = ls ? ls.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        const base = blank();
        cache = {
          records: p.records && typeof p.records === 'object' ? p.records : base.records,
          daily: p.daily && typeof p.daily === 'object' ? p.daily : base.daily,
          unlocked: count(p.unlocked) || base.unlocked,
          stats: {
            plays: count((p.stats || {}).plays),
            wins: count((p.stats || {}).wins),
            losses: count((p.stats || {}).losses),
            plies: count((p.stats || {}).plies),
          },
        };
        return cache;
      }
    } catch (err) {
      // A corrupt save is not worth keeping: start clean rather than crash the shell.
    }
  }
  cache = blank();
  return cache;
}

function persist() {
  const ls = backend();
  if (!ls) return false;
  try {
    ls.setItem(KEY, JSON.stringify(cache));
    return true;
  } catch (err) {
    return false; // quota or a blocked store: the session simply stays in memory
  }
}

export const store = {
  get records() { return load().records; },
  get stats() { return load().stats; },
  get daily() { return load().daily; },
  get unlocked() { return load().unlocked; },

  record(id) {
    return load().records[id] || null;
  },

  // A finished game. `plies` counts both sides, the same unit `par` is printed in, so the
  // two are directly comparable and "perfect" stays a fact rather than a feeling.
  // A loss never rewrites an earlier win's record, and `best` only ever moves down.
  finish(id, { won, plies, par }) {
    const s = load();
    const prev = s.records[id] || null;
    const took = count(plies);
    // A loss leaves the record exactly as it found it — including leaving no `best` at all for
    // a player who has never won, so the file cannot claim a time it never saw.
    const was = count(prev && prev.best);
    const best = won ? (was ? Math.min(was, took) : took) : was;
    const cur = {
      plays: count(prev && prev.plays) + 1,
      won: !!(prev && prev.won) || !!won,
      ...(best ? { best } : {}),
      perfect: !!(prev && prev.perfect) || !!(won && par !== null && par !== undefined && took <= Number(par)),
      lastWon: !!won,
      lastPlies: took,
      par: par === undefined ? null : par,
    };
    s.records[id] = cur;
    s.stats.plays = count(s.stats.plays) + 1;
    s.stats.plies = count(s.stats.plies) + took;
    s.stats.wins = count(s.stats.wins) + (won ? 1 : 0);
    s.stats.losses = count(s.stats.losses) + (won ? 0 : 1);
    persist();
    return cur;
  },

  // Unlocking is monotone: re-playing an early lot must never hide a later one.
  unlock(n) {
    const s = load();
    if (count(n) > s.unlocked) s.unlocked = count(n);
    persist();
    return s.unlocked;
  },

  markDaily(dateKey, id) {
    const s = load();
    s.daily[dateKey] = { id, at: Date.now() };
    persist();
  },

  dailyDone(dateKey) {
    return load().daily[dateKey] || null;
  },

  reset() {
    cache = blank();
    const ls = backend();
    if (ls) {
      try {
        ls.removeItem(KEY);
      } catch (err) {
        /* nothing was ever persisted */
      }
    }
  },
};
