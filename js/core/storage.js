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
    // Safari 的隐私窗口与某些被限制的第三方上下文里，`window.localStorage` 取得到、
    // `setItem` 却当场抛配额错。与其每次落盘都静默失败，先探针一次，决定这一轮的载体。
    const ls = window.localStorage;
    if (ls !== probed) {
      ls.setItem(PROBE, '1');
      ls.removeItem(PROBE);
      probed = ls;
    }
    return ls;
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

function flag(v) {
  return v === true;
}

// 第二段解码：records 里一条一条过。`null`、数组、数字、字符串都不是"一条成绩"；字段类型
// 错或越界（plays 为负、best 为文本）也只作废那一条。坏一条丢一条，其余照常读出来 —— 让
// 一条垃圾记录把整局冻死，是玩家最不能接受的那种 bug。
function decodeRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  for (const k of ['plays', 'best', 'lastPlies']) {
    if (!(k in raw)) continue;
    const v = raw[k];
    if (v === null || v === undefined) continue;   // 缺的那一格交给读取方补默认
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return null; // 越界或"best: 一堆字"就是脏记录
  }
  for (const k of ['won', 'perfect', 'lastWon']) {
    if (k in raw && typeof raw[k] !== 'boolean') return null;
  }
  return { ...raw };
}

function decodeRecords(obj) {
  const out = {};
  let dropped = 0;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { records: out, dropped: 1 };
  for (const id of Object.keys(obj)) {
    const rec = decodeRecord(obj[id]);
    if (rec) out[id] = rec;
    else dropped++;
  }
  return { records: out, dropped };
}

function decodeDaily(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const day of Object.keys(obj)) {
    const e = obj[day];
    if (e && typeof e === 'object' && typeof e.id === 'string') {
      out[day] = { id: e.id, at: count(e.at) };
    }
  }
  return out;
}

const SETTINGS_KEYS = { muted: flag, seenTutorial: flag };

function decodeSettings(obj) {
  // 缺字段回默认，多字段丢掉：设置这一层坏了不该影响成绩。
  const out = { muted: false, seenTutorial: false };
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(SETTINGS_KEYS)) {
    if (k in obj) out[k] = SETTINGS_KEYS[k](obj[k]);
  }
  return out;
}

function blank() {
  return {
    v: SAVE_VERSION,
    records: {},
    daily: {},
    unlocked: 1,
    stats: { plays: 0, wins: 0, losses: 0, plies: 0 },
    settings: { muted: false, seenTutorial: false },
  };
}

let cache = null;
let droppedRecords = 0;

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
        const dec = decodeRecords(p.records);
        droppedRecords = dec.dropped;
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
          settings: decodeSettings(p.settings),
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
  get settings() { return load().settings; },

  // 这一次解码丢掉的坏记录条数：面板把它印出来，"存档没丢"就成了可核对的数字而不是承诺。
  droppedBadRecords() { load(); return droppedRecords; },

  // 只认白名单里的键；值一律走该键自己的解码器，写进来的垃圾进不了盘。
  setSetting(key, value) {
    const guard = SETTINGS_KEYS[key];
    if (!guard) return load().settings[key];
    const s = load();
    s.settings[key] = guard(value);
    persist();
    return s.settings[key];
  },

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
    droppedRecords = 0;
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
