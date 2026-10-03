// The save file: one localStorage key, plain JSON, a versioned shape so an old save is
// recognised rather than mistaken for a new one.
//
// Records are keyed by lot id; `best` is the fewest total plies you have needed to win that
// lot, `unlocked` is the campaign pointer, `daily` logs one entry per calendar day.
// Everything degrades to a memory-only session when localStorage is refused — under file://
// (where this build cannot run at all, see README), in a private window, and in every
// `node --test` process, which has no window to begin with.

const KEY = 'nim.save.v1';
// 存档格式版本号。写档带上、读档校验：将来改形状时旧档宁可整档丢弃，也不能被误读。
export const SAVE_VERSION = 1;

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
    v: SAVE_VERSION,
    records: {},
    daily: {},
    unlocked: 1,
    stats: { plays: 0, wins: 0, losses: 0, plies: 0 },
  };
}

let cache = null;

// 数字字段的归一自带一份，不依赖仓里有没有 count() —— 少一层隐式耦合。
function recordNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// 存档两段式解码的第一段：整档 JSON 落到这里之后，**逐字段**归一。
// 一条记录不是"能用/不能用"二选一 —— 类型错的字段自己退成默认值，整条照样留下。
// 第二段（sanitizeRecords）在下面：它只丢掉归一后彻底没意义的记录，别的记录不受牵连。
function sanitizeRecord(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out = {};
  out.plays = recordNum(r.plays);
  out.won = !!r.won;
  out.lastWon = !!r.lastWon;
  out.lastPlies = recordNum(r.lastPlies);
  out.best = r.best === null || r.best === undefined ? null : recordNum(r.best);
  out.perfect = !!r.perfect;
  out.par = r.par === null || r.par === undefined ? null : recordNum(r.par);
  return out;
}

// 逐条隔离：坏的那条丢掉，好的那些原样留下，绝不因为一条把整份存档作废。
function sanitizeRecords(p) {
  const out = {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return out;
  for (const [id, rec] of Object.entries(p)) {
    const clean = sanitizeRecord(rec);
    if (clean) out[id] = clean;
  }
  return out;
}

function load() {
  if (cache) return cache;
  const ls = backend();
  const raw = ls ? window.localStorage.getItem(KEY) : null;
  if (raw) {
    try {
      const p = JSON.parse(raw);
      // 版本门：只认本仓写出去的版本。将来升 v2 时，旧档宁可整档丢弃也不能被误读成新档。
      if (p && typeof p === 'object' && !Array.isArray(p)
          && (p.v === undefined || p.v === SAVE_VERSION)) {
        const base = blank();
        cache = {
          records: sanitizeRecords(p.records),
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
    window.localStorage.setItem(KEY, JSON.stringify(cache));
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
