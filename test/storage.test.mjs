// The save file, exercised against every kind of storage a browser can hand back: a working
// localStorage, a refused one (private window, blocked third-party context), a corrupt one,
// a half-valid one, and no window at all — which is what every `node` process in this repo
// is. A shell that throws on one of those five is a shell with no players.
//
// The monotonicity rules below are the promises a player would notice first, so they are
// tested as promises rather than as implementation details:
//   * `best` only ever goes down, and a loss never touches it
//   * `won` and `perfect` stay earned
//   * `unlocked` only ever goes up, so replaying an early lot cannot hide a later one
//
// Each case installs its own `window` before touching its own module instance, because
// storage.js looks the global up lazily: one instance driven under two shims would prove
// nothing about either.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const KEY = 'nim.save.v1';
const url = pathToFileURL(join(root, 'js', 'core', 'storage.js')).href;

function makeLS(initial) {
  const data = new Map();
  if (initial !== undefined) data.set(KEY, initial);
  const ls = {
    data,
    sets: 0,
    removes: 0,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { ls.sets++; data.set(k, String(v)); },
    removeItem: (k) => { ls.removes++; data.delete(k); },
  };
  return ls;
}

const lsDisk = makeLS();
const lsJunk = makeLS('{not even json');
const lsHalf = makeLS(JSON.stringify({
  records: { 'knife-01': { won: true } }, unlocked: '0', stats: null, daily: 'no',
}));
const lsHostile = makeLS(JSON.stringify(['x', 'y']));
const lsNeverGiven = makeLS();
let blockedAsks = 0;

function useShim(kind) {
  if (kind === 'none') { delete globalThis.window; return; }
  if (kind === 'blocked') {
    globalThis.window = {
      get localStorage() { blockedAsks++; throw new Error('SecurityError: storage is blocked'); },
    };
    return;
  }
  const ls = { disk: lsDisk, junk: lsJunk, half: lsHalf, hostile: lsHostile }[kind];
  globalThis.window = { localStorage: ls };
}

let instance = 0;
// Six independent copies of the module — each is "a page load", and none of them shares a
// cache with another. The window shim itself is installed per test by `useShim` above.
async function again() {
  const mod = await import(`${url}?case=${++instance}`);
  return mod.store;
}

const memory = await again();
const writing = await again();
const reading = await again();
const blocked = await again();
const junked = await again();
const hostile = await again();
const halved = await again();

test('with no window at all the store still plays the game, in memory', () => {
  useShim('none');
  eq(Object.keys(memory.records), [], 'nothing recorded yet');
  eq(memory.stats, { plays: 0, wins: 0, losses: 0, plies: 0 });
  eq(memory.unlocked, 1, 'the campaign starts at one');
  eq(memory.daily, {});
  eq(memory.record('spark-01'), null, 'no attempt on spark-01');
  const r = memory.finish('spark-01', { won: true, plies: 5, par: 5 });
  eq(r, { plays: 1, won: true, best: 5, perfect: true, lastWon: true, lastPlies: 5, par: 5 });
  eq(memory.record('spark-01'), r, 'and it reads back out of the same session');
  eq(memory.stats, { plays: 1, wins: 1, losses: 0, plies: 5 });
  eq(memory.reset(), undefined, 'reset is a statement, not a value');
  eq(memory.record('spark-01'), null, 'reset really did clear the session');
  eq(memory.stats.plays, 0);
});

test('a working localStorage is written through and read back by a fresh page', () => {
  useShim('disk');
  writing.unlock(7);
  writing.finish('nerve-03', { won: true, plies: 12, par: 11 });
  writing.markDaily('2026-09-27', 'knife-05');
  const raw = lsDisk.data.get(KEY);
  ok(raw, 'one key, plain JSON');
  eq(lsDisk.data.size, 1, 'the save lives in exactly one key, no scratch data beside it');
  ok(lsDisk.sets >= 3, `${lsDisk.sets} writes went through to disk`);
  const parsed = JSON.parse(raw);
  eq(Object.keys(parsed).sort(), ['daily', 'records', 'stats', 'unlocked', 'v'], 'the versioned shape');
  eq(parsed.records['nerve-03'].best, 12);
  eq(parsed.unlocked, 7);
  eq(parsed.stats, { plays: 1, wins: 1, losses: 0, plies: 12 });
  eq(parsed.daily['2026-09-27'].id, 'knife-05');
  // ...and a *different* module instance — the next page load — sees the same numbers.
  eq(reading.unlocked, 7, 'the campaign pointer survived the reload');
  eq(reading.record('nerve-03').best, 12, 'so did the record');
  eq(reading.dailyDone('2026-09-27').id, 'knife-05', 'and the daily log');
  eq(reading.stats.wins, 1);
  ok(reading.dailyDone('2026-09-27').at > 0, 'with a timestamp on it');
});

test('a blocked store degrades to memory instead of throwing on the first tap', () => {
  useShim('blocked');
  const asked = blockedAsks;
  eq(blocked.record('spark-01'), null);
  const r = blocked.finish('spark-01', { won: true, plies: 6, par: 5 });
  eq(r.won, true, 'the session still records, it just cannot promise to keep it');
  eq(blocked.unlock(4), 4);
  blocked.markDaily('2026-09-28', 'deep-01');
  eq(blocked.dailyDone('2026-09-28').id, 'deep-01');
  eq(blocked.record('spark-01').best, 6, 'every read of the board still works');
  blocked.reset();
  eq(blocked.record('spark-01'), null, 'and reset works with no disk under it');
  ok(blockedAsks > asked + 4, `the store was asked for ${blockedAsks - asked} times and threw every time`);
  eq(lsNeverGiven.sets, 0, 'nothing was ever written, because nothing could be');
});

test('a corrupt save is dropped rather than trusted', () => {
  useShim('junk');
  eq(Object.keys(junked.records), [], 'unparseable JSON is not a save');
  eq(junked.unlocked, 1);
  eq(junked.stats, { plays: 0, wins: 0, losses: 0, plies: 0 });
  eq(lsJunk.data.get(KEY), '{not even json', 'nothing rewrites the disk just for reading it');
  const r = junked.finish('deep-02', { won: false, plies: 30, par: 27 });
  eq(r.plays, 1);
  eq(r.won, false);
  eq(r.perfect, false);
  eq(r.par, 27);
  eq('best' in r, false, 'a loss carries no best time, so the file cannot claim one');
  eq(junked.record('deep-02').best, undefined);
  const written = JSON.parse(lsJunk.data.get(KEY));
  eq(written.records['deep-02'].plays, 1, 'the first write replaces the garbage outright');
  eq(written.stats, { plays: 1, wins: 0, losses: 1, plies: 30 }, 'and the counters start from zero, not from the junk');
  junked.finish('deep-02', { won: true, plies: 28, par: 27 });
  const again = JSON.parse(lsJunk.data.get(KEY));
  eq(again.records['deep-02'].plays, 2);
  eq(again.records['deep-02'].best, 28);
  eq(again.records['deep-02'].won, true, 'and the earlier loss left no stale won:false behind');
});

test('a hostile save shape is refused the same way, and then rewritten cleanly', () => {
  useShim('hostile');
  eq(Object.keys(hostile.records), [], 'a top-level array is valid JSON and still not a save');
  eq(hostile.unlocked, 1);
  eq(hostile.stats.plays, 0);
  eq(hostile.daily, {});
  hostile.finish('oddball-01', { won: true, plies: 2, par: 2 });
  const after = JSON.parse(lsHostile.data.get(KEY));
  eq(Array.isArray(after), false, 'the replacement payload is an object');
  eq(after.records['oddball-01'].best, 2, 'and it is the shape the shell expects');
});

test('a half-valid save falls back field by field, not all or nothing', () => {
  useShim('half');
  eq(Object.keys(halved.records), ['knife-01'], 'the one real record was kept');
  eq(halved.unlocked, 1, '"0" is not an unlock count');
  eq(halved.stats, { plays: 0, wins: 0, losses: 0, plies: 0 }, 'stats: null became the blank shape');
  eq(halved.daily, {}, 'daily: "no" became an empty log');
  eq(halved.record('knife-01'), { plays: 0, won: true, lastWon: false, lastPlies: 0, best: null, perfect: false, par: null },
    'a half-written record is normalised field by field to the blank shape, not passed through');
  const fixed = halved.finish('knife-01', { won: true, plies: 13, par: 11 });
  eq(fixed.plays, 1, 'a record with no plays field restarts at 1 instead of going NaN');
  eq(fixed.won, true, 'and the half-truth that was in the file is still honoured');
  eq(halved.record('knife-01').best, 13, 'the missing best is filled by this win, not by a guess');
});

test('best only ever moves down, and a loss never touches it', () => {
  useShim('half');
  const s = halved;
  s.reset();
  eq(s.finish('spark-06', { won: true, plies: 9, par: 9 }).best, 9, 'the first win sets the record');
  eq(s.finish('spark-06', { won: true, plies: 7, par: 9 }).best, 7, 'seven beats nine');
  eq(s.finish('spark-06', { won: true, plies: 11, par: 9 }).best, 7, 'and eleven does not take it away');
  const afterLoss = s.finish('spark-06', { won: false, plies: 40, par: 9 });
  eq(afterLoss.won, true, 'the win is still on the board');
  eq(afterLoss.perfect, true, 'so is the perfect clear');
  eq(afterLoss.best, 7, 'and the record stands');
  eq(afterLoss.lastWon, false, 'while the *last* attempt is reported honestly');
  eq(afterLoss.plays, 4);
  eq(s.stats, { plays: 4, wins: 3, losses: 1, plies: 67 });
});

test('perfect is a measured claim, not a mood', () => {
  useShim('half');
  const s = halved;
  s.reset();
  eq(s.finish('knife-04', { won: false, plies: 21, par: 15 }).perfect, false);
  eq(s.finish('knife-04', { won: true, plies: 16, par: 15 }).perfect, false, 'one stone over par is a detour');
  eq(s.finish('knife-04', { won: true, plies: 15, par: 15 }).perfect, true, 'exactly par is perfect');
  eq(s.finish('knife-04', { won: true, plies: 20, par: 15 }).perfect, true, 'and it stays earned');
  eq(s.record('knife-04').best, 15, 'with the best time beside it');
  eq(s.finish('twitch-02', { won: true, plies: 4, par: null }).perfect, false,
    'no par means no perfect claim, rather than a free one');
  eq(s.finish('twitch-02', { won: true, plies: 4 }).par, null, 'and a missing par stores as null, not undefined');
  s.reset();
  eq(Object.keys(s.records).length, 0);
});

test('unlocking is monotone: replaying level one never hides level nine', () => {
  useShim('disk');
  const s = reading;
  eq(s.unlocked, 7, 'the reload above left the pointer at 7');
  eq(s.unlock(3), 7, 'a smaller unlock is ignored, not subtracted');
  eq(s.unlock(1), 7);
  eq(s.unlock(0), 7);
  eq(s.unlock(-5), 7);
  eq(s.unlock(Number.NaN), 7, 'NaN is not a progress report');
  eq(s.unlock(8), 8, 'and a bigger one moves the pointer');
  eq(s.unlock(30), 30);
  eq(s.unlocked, 30);
  eq(JSON.parse(lsDisk.data.get(KEY)).unlocked, 30, 'persisted, not just remembered');
});

test('one daily entry per calendar day, and an untouched day reads as empty', () => {
  useShim('disk');
  const s = writing;
  s.reset();
  eq(s.dailyDone('2026-09-27'), null, 'nobody has played today yet');
  s.markDaily('2026-09-27', 'twitch-03');
  eq(s.dailyDone('2026-09-27').id, 'twitch-03');
  s.markDaily('2026-09-28', 'oddball-02');
  eq(Object.keys(s.daily).sort(), ['2026-09-27', '2026-09-28'], 'two days, two entries');
  s.markDaily('2026-09-27', 'spark-02');
  eq(Object.keys(s.daily).length, 2, 'replaying yesterday overwrites it, it does not add a day');
  eq(s.dailyDone('2026-09-27').id, 'spark-02');
  eq(s.dailyDone('1999-01-01'), null);
  eq(Object.keys(JSON.parse(lsDisk.data.get(KEY)).daily).sort(), ['2026-09-27', '2026-09-28']);
});

test('reset clears the disk as well as the memory, and the shell survives it', () => {
  useShim('disk');
  const s = writing;
  s.finish('deep-05', { won: true, plies: 23, par: 23 });
  ok(lsDisk.data.get(KEY), 'written');
  const before = lsDisk.removes;
  s.reset();
  eq(lsDisk.removes, before + 1, 'the key really was removed');
  eq(lsDisk.data.has(KEY), false);
  eq(s.record('deep-05'), null);
  eq(s.stats.plays, 0);
  eq(s.unlocked, 1, 'and the pointer came back down with it, the only way it ever moves down');
  eq(s.finish('deep-05', { won: true, plies: 24, par: 23 }).best, 24,
    'a new session starts from nothing rather than from a stale record');
  s.reset();
  useShim('none');
});

test('only storage.js names a browser global, and it guards every use', () => {
  const coreDir = join(root, 'js', 'core');
  const files = readdirSync(coreDir).filter((f) => f.endsWith('.js')).sort();
  eq(files, ['ai.js', 'bouton.js', 'game.js', 'heaps.js', 'library.js', 'make.js', 'retro.js', 'rng.js', 'storage.js']);
  const reachers = [];
  for (const f of files) {
    if (f === 'storage.js') continue;
    const code = readFileSync(join(coreDir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
    if (/window\.|document\.|localStorage|navigator\.|require\(/.test(code)) reachers.push(f);
  }
  eq(reachers, [], 'the rest of the core is plain JavaScript, which is what lets node run it');
  const src = readFileSync(join(coreDir, 'storage.js'), 'utf8');
  const body = src.slice(src.indexOf('function backend()'), src.indexOf('function blank()'));
  ok(/try \{[\s\S]*window\.localStorage[\s\S]*\} catch/.test(body), 'every access goes through one guarded function');
  ok(/try \{[\s\S]*setItem[\s\S]*\} catch/.test(src.slice(src.indexOf('function persist()'))),
    'and so does the write, which is the one that can hit a quota');
  const code = src.replace(/\/\/[^\n]*/g, '');
  ok(!/window\.(?!localStorage)/.test(code), 'it never reaches for any other window member');
  eq(/'nim\.save\.v1'/.test(src), true, 'one versioned key, so an old save is recognised rather than misread');
  ok(!/eval|innerHTML|new Function/.test(code), 'and the parsed save is data, never code');
});

run();
