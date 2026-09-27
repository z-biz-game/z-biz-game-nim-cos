// The shipped pool, re-solved. js/data/lots.js is a generated file: one row per lot, each
// carrying the three numbers the screen prints (`outcome`, `par`, `winMoves`) plus a `scores`
// object with both win conventions. This file does not trust a single one of them: it
// recomputes every row from scratch, twice, on two different graphs, and fails if a line and
// its numbers disagree.
//
// That is also the regression gate on tools/bake.mjs. Hand-edit a par, or let the generator
// ship a position the classifier calls a loss, and this file goes red.

import { test, run, ok, eq } from '../tools/harness.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  ALL, BANDS, BAND_INDEX, ENGINE_META, bandByKey, byId, campaign, dailyLot, levelAt, lotsIn,
  randomLot, stats,
} from '../js/core/library.js';
import { LOTS, BANDS_META, ENGINE } from '../js/data/lots.js';
import { BANDS as GEN_BANDS, bandByKey as genBandByKey } from '../js/core/make.js';
import { MISERE, NORMAL, RULES, bigHeaps, oneHeaps, total, validate, isTerminal } from '../js/core/heaps.js';
import { outcome, winMoveCount, verdict } from '../js/core/bouton.js';
import { engineInfo, measure, positionScores } from '../js/core/retro.js';
import { naive } from './minimax.mjs';
import { hashSeed, mulberry32, rngFrom, todayKey } from '../js/core/rng.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cellsOf = (heaps) => heaps.reduce((a, h) => a * (h + 1), 1);
const sumOf = (heaps) => heaps.reduce((a, h) => a + h, 0);

test('the generated file exports three things and every row in it is a valid board', () => {
  ok(existsSync(join(root, 'js', 'data', 'lots.js')), 'run node tools/bake.mjs first');
  eq(LOTS, ALL, 'the library republishes the file as it stands, row for row');
  ok(ALL.length >= 40, `${ALL.length} lots is too thin a shelf to call a game`);
  const ids = new Set();
  for (const row of ALL) {
    eq(Object.keys(row).sort(), ['band', 'cells', 'heaps', 'id', 'index', 'outcome', 'par', 'rule', 'scores', 'winMoves'],
      `${row.id} carries exactly these fields`);
    eq(validate(row.heaps), null, `${row.id} is not a board`);
    ok(!isTerminal(row.heaps), `${row.id} ships already finished`);
    ok(row.heaps.length >= 2 && row.heaps.length <= 4, `${row.id} has ${row.heaps.length} heaps`);
    ok(row.heaps.every((n) => n >= 1), `${row.id} shows an empty heap to the player`);
    eq(row.heaps, row.heaps.slice().sort((a, b) => a - b), `${row.id} must be sorted: heap index is screen position`);
    eq(row.cells, cellsOf(row.heaps), `${row.id} cells is its own reachable box`);
    ok(row.par >= 1 && row.par <= sumOf(row.heaps), `${row.id} par ${row.par} is outside the board`);
    ok(row.winMoves >= 1 && row.winMoves <= sumOf(row.heaps), `${row.id} winMoves ${row.winMoves}`);
    ok(!ids.has(row.id), `${row.id} appears twice`);
    ids.add(row.id);
  }
  eq(ids.size, ALL.length);
  eq(BANDS.length, BANDS_META.length);
  eq(BANDS.length, GEN_BANDS.length, 'one band list for the generator and the display, not two');
  eq(RULES, ['normal', 'misere'], 'two win conventions, no more');
  eq(ENGINE_META, ENGINE, 'the engine the file names is the engine the library republishes');
  eq(ENGINE.states, 10000, 'the grid the numbers came from: 9x9x9x9');
  eq(ENGINE.edges, 180000);
  eq(engineInfo(), { maxVec: [9, 9, 9, 9], states: 10000, edges: 180000, rules: ['normal', 'misere'] },
    'and the engine still is exactly that grid');
});

test('every shipped number solves again from scratch, on its own box and on the shared grid', () => {
  let checked = 0;
  const mismatch = [];
  let expanded = 0;
  for (const row of ALL) {
    // (1) a complete retrograde analysis over this lot's own reachable box, built fresh here;
    const own = positionScores(row.heaps);
    // (2) the shared grid the generator sampled from.
    const shared = measure(row.heaps);
    for (const rule of RULES) {
      checked++;
      const label = `${row.id} ${rule}`;
      eq(row.scores[rule].outcome, own[rule].outcome, `${label}: re-solved outcome`);
      eq(row.scores[rule].par, own[rule].par, `${label}: re-solved par`);
      eq(row.scores[rule].winMoves, own[rule].winMoves, `${label}: re-solved winMoves`);
      eq(own[rule].outcome, shared[rule].outcome, `${label}: own box and shared grid disagree`);
      eq(own[rule].par, shared[rule].par, `${label}: own box and shared grid disagree on depth`);
      eq(own[rule].winMoves, shared[rule].winMoves, `${label}: own box and shared grid disagree on roads`);
    }
    expanded += own.states;
    if (row.outcome !== row.scores[row.rule].outcome
      || row.par !== row.scores[row.rule].par
      || row.winMoves !== row.scores[row.rule].winMoves) mismatch.push(row.id);
    if (own.states !== row.cells) mismatch.push(`${row.id} cells`);
    if (shared.states !== 10000) mismatch.push(`${row.id} shared grid size`);
  }
  eq(checked, ALL.length * 2, 'both conventions, on two graphs, for every shipped row');
  eq(mismatch, [], 'the headline numbers are the scores, not a copy of them');
  ok(expanded > 20000, `${expanded} positions re-expanded in total, so this was not a lookup`);
});

test('a third opinion: the closed form and the raw definition, with no engine at all', () => {
  const seen = new Map();
  for (const row of ALL) {
    for (const rule of RULES) {
      const key = `${rule}|${row.heaps.join(',')}`;
      if (!seen.has(key)) seen.set(key, naive(row.heaps, rule, { maxNodes: 500000 }));
      const byDef = seen.get(key);
      eq(byDef.outcome, row.scores[rule].outcome, `${row.id} ${rule}: definition vs row`);
      eq(byDef.plies, row.scores[rule].par, `${row.id} ${rule}: definition depth vs row par`);
      eq(byDef.winMoves, row.scores[rule].winMoves, `${row.id} ${rule}: definition roads vs row`);
      eq(outcome(row.heaps, rule), row.scores[rule].outcome, `${row.id} ${rule}: closed form vs row`);
      eq(winMoveCount(row.heaps, rule), row.scores[rule].winMoves, `${row.id} ${rule}: closed-form roads vs row`);
    }
    eq(verdict(row.heaps, row.rule), {
      outcome: row.outcome, winning: true, winMoves: row.winMoves, over: false,
    }, `${row.id} is what the panel says on the first frame`);
  }
  eq(seen.size, ALL.length * 2, 'three independent writings of the answer, one per row and rule');
});

test('nothing unfair ships: every lot is a first-player win, and the inversion is a region', () => {
  const against = [];
  const outsideSmall = [];
  let allSmall = 0;
  for (const row of ALL) {
    if (row.outcome !== 'N') against.push(`${row.id} ${row.rule} is ${row.outcome}`);
    // A misere lot must not be a normal lot with a label stuck on it: where the two
    // conventions disagree about *who wins*, that has to be the all-small region, because
    // that is the theorem. Checked on the pool, not asserted in prose.
    const flip = row.scores.normal.outcome !== row.scores.misere.outcome;
    const small = bigHeaps(row.heaps) === 0;
    if (flip && !small) outsideSmall.push(`${row.id} ${row.heaps.join(',')}`);
    if (small) {
      allSmall++;
      eq(row.heaps.every((n) => n === 1), true, `${row.id} all-small lots are made of single stones`);
      eq(oneHeaps(row.heaps) % 2, 0, 'and an even count, which is the misere win');
      eq(row.scores.normal.outcome, 'P', 'so the same row is provably lost under normal play');
      eq(row.winMoves, total(row.heaps), 'every take wins here, which is why the count is even');
      eq(row.scores.misere.par, total(row.heaps), 'and the game lasts exactly one ply per stone');
    } else {
      eq(flip, false, `${row.id} outside the region the two verdicts agree`);
      eq(row.winMoves % 2, 1, `${row.id}: a normal-play road count is always odd`);
    }
  }
  eq(against, [], 'a P-position on the shelf would be a level you cannot beat');
  eq(outsideSmall, [], 'no verdict flipped outside the all-small region');
  eq(allSmall, 2, `the all-small lots on the shelf: ${allSmall}`);
});

test('the bands are a ladder, and the windows the generator demanded still hold', () => {
  for (const band of GEN_BANDS) {
    const rows = lotsIn(band.key);
    ok(rows.length > 0, `${band.key} shipped nothing`);
    eq(genBandByKey(band.key), band, `${band.key} is findable by key on the generation side`);
    eq(BAND_INDEX[band.key], BANDS.findIndex((b) => b.key === band.key));
    ok(BANDS.length === GEN_BANDS.length && BANDS.every((b) => GEN_BANDS.some((g) => g.key === b.key)),
      'the shipped shelf has exactly the bands the generator knows, no more and no less');
    for (const row of rows) {
      const why = `${row.id} ${row.heaps.join(',')} vs band ${band.key}`;
      eq(row.rule, band.rule, `${why}: the wrong convention shipped in this band`);
      eq(row.index, GEN_BANDS.indexOf(band), `${why}: index does not point back at the band`);
      ok(row.heaps.length >= band.k[0] && row.heaps.length <= band.k[1], `${why}: heap count ${row.heaps.length}`);
      ok(Math.max(...row.heaps) <= band.nMax, `${why}: a heap of ${Math.max(...row.heaps)} over nMax ${band.nMax}`);
      ok(sumOf(row.heaps) >= band.sum[0] && sumOf(row.heaps) <= band.sum[1], `${why}: sum ${sumOf(row.heaps)}`);
      ok(row.par >= band.par[0] && row.par <= band.par[1], `${why}: par ${row.par} outside ${band.par}`);
      ok(row.winMoves >= band.win[0] && row.winMoves <= band.win[1], `${why}: winMoves ${row.winMoves} outside ${band.win}`);
      const big = bigHeaps(row.heaps);
      if (band.shape === 'singleBig') eq(big, 1, `${why}: shape`);
      if (band.shape === 'manyBig') ok(big >= 2, `${why}: shape`);
      if (band.shape === 'allSmall') eq(big, 0, `${why}: shape`);
      if (band.other) {
        const other = band.rule === NORMAL ? MISERE : NORMAL;
        eq(row.scores[other].outcome, band.other, `${why}: the other convention must say ${band.other}`);
      }
      ok(row.id.startsWith(`${band.key}-`), `${row.id} is mislabelled for ${band.key}`);
    }
    eq(rows.map((r) => r.id), rows.map((r, i) => `${band.key}-${String(i + 1).padStart(2, '0')}`),
      `${band.key} ids are sequential from 01`);
    const pars = rows.map((r) => r.par);
    eq(pars, pars.slice().sort((a, b) => a - b), `${band.key} ships in measured-par order`);
    const meta = BANDS_META.find((b) => b.key === band.key);
    eq([meta.label, meta.blurb, meta.rule], [band.label, band.blurb, band.rule],
      `${band.key} display meta drifted from the generator spec`);
    eq(meta.n, rows.length, `${band.key} meta count is stale`);
    eq(meta.parMin, Math.min(...pars), `${band.key} meta parMin is stale`);
    eq(meta.parMax, Math.max(...pars), `${band.key} meta parMax is stale`);
    eq(meta.rule, band.rule);
    ok(meta.label.length > 0, `${band.key} has a Chinese label for the shelf`);
    ok(meta.blurb.length > 0, `${band.key} has a blurb`);
  }
  eq(bandByKey('no-such-band'), BANDS[0], 'an unknown band key falls back to the easiest one');
  // The ordering is a claim about measured depths, so it is tested as one. The normal bands
  // have to climb; the misere bands are a separate ladder, and the fact that their par
  // numbers are lower at all is measured rather than assumed.
  const normalPars = GEN_BANDS.filter((b) => b.rule === NORMAL)
    .map((b) => Math.min(...lotsIn(b.key).map((r) => r.par)));
  eq(normalPars, normalPars.slice().sort((a, b) => a - b), `the normal ladder descends: ${normalPars.join(' -> ')}`);
  const deep = lotsIn('deep');
  ok(deep[deep.length - 1].par >= lotsIn('spark')[0].par * 2,
    'the hardest normal lot outshines the easiest by more than a double');
  const misPar = GEN_BANDS.filter((b) => b.rule === MISERE).map((b) => Math.max(...lotsIn(b.key).map((r) => r.par)));
  ok(Math.max(...misPar) < Math.min(...normalPars.slice(1)),
    `the misere ladder is genuinely shorter: ${misPar.join('/')} against ${normalPars.join('/')}`);
});

test('the campaign runs one way and the lookups wrap instead of crashing', () => {
  eq(campaign(), ALL, 'the campaign is the whole pool, in file order');
  eq(campaign().map((r) => r.index), campaign().map((r) => BANDS.findIndex((b) => b.key === r.band)),
    'easiest band first, hardest last');
  eq(byId('spark-01').id, 'spark-01');
  eq(byId('nope-99'), null, 'a bad #/lot/ link resolves to nothing, not to a random level');
  eq(byId(''), null);
  eq(byId(null), null);
  eq(levelAt(0), ALL[0]);
  eq(levelAt(ALL.length), ALL[0], 'the pointer wraps');
  eq(levelAt(-1), ALL[ALL.length - 1], 'including backwards');
  eq(levelAt(100000), ALL[100000 % ALL.length]);
  eq(campaign().every((r) => r.outcome === 'N'), true, 'and nothing unfair slipped into the order');
  const first = campaign()[0];
  const last = campaign()[campaign().length - 1];
  eq([first.band, last.band], ['spark', 'oddball'], 'the all-small inversion band closes the shelf');
  const order = campaign().map((r) => [r.index, r.par, r.id]);
  const sorted = order.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  eq(order, sorted, 'the whole shelf is sorted by band, then by measured par, then by id');
  ok(campaign().every((r, i) => i === 0 || r.index >= campaign()[i - 1].index), 'band index never goes backwards');
});

test('the daily puzzle and a seeded pick are the same piles on every device', () => {
  const keys = [];
  for (let y = 2024; y <= 2031; y++) {
    for (let m = 1; m <= 12; m++) keys.push(`${y}-${String(m).padStart(2, '0')}-17`);
  }
  keys.push('2026-09-27', 'today', '', '今天');
  eq(keys.length, 100);
  for (const k of keys) {
    const a = dailyLot(k);
    const b = dailyLot(k);
    ok(a && byId(a.id) === a, `dailyLot('${k}') invented a lot`);
    eq(a.id, b.id, `dailyLot('${k}') is not a function of its key alone`);
    eq(a.heaps, b.heaps, `dailyLot('${k}') shuffled the piles`);
    eq(a.outcome, 'N', `dailyLot('${k}') picked a board that cannot be won`);
  }
  const distinct = new Set(keys.map((k) => dailyLot(k).id));
  ok(distinct.size >= 24, `the daily pick landed on only ${distinct.size} boards across ${keys.length} keys`);
  for (const band of GEN_BANDS) {
    const one = randomLot('seed-a', band.key);
    eq(one.band, band.key, `randomLot('seed-a', ${band.key}) came from another band`);
    eq(one.id, randomLot('seed-a', band.key).id, 'same seed, same lot, forever');
    eq(one.outcome, 'N');
    ok(new Set(Array.from({ length: 40 }, (_, i) => randomLot(`s${i}`, band.key).id)).size > 1,
      `${band.key}: forty seeds, one answer - the picker is decorative`);
  }
  eq(randomLot('s', 'no-such-band'), null, 'an unknown band has nothing to pick from');
  eq(todayKey(new Date(2026, 8, 27)), '2026-09-27', 'the daily key is local and zero-padded');
  eq(todayKey(new Date(2026, 0, 1)), '2026-01-01');
});

test('rng.js is the determinism those picks lean on, and it is stable', () => {
  eq(hashSeed(''), 2166136261, 'the FNV-1a offset basis, straight from the constants');
  eq(hashSeed('3,5,7'), hashSeed('3,5,7'));
  ok(hashSeed('3,5,7') !== hashSeed('3,5,8'), 'a neighbouring seed must not land next door');
  ok(hashSeed('anything') >>> 0 === hashSeed('anything'), 'and it stays a 32-bit unsigned value');
  const draw = (s) => {
    const r = rngFrom(s);
    return [r(), r(), r.int(1e6), r.range(1, 9), r.pick(['a', 'b', 'c']), r.chance(0.5)];
  };
  eq(draw('abc'), draw('abc'), 'the same seed, the same six numbers');
  eq(draw('abc'), draw(rngFrom('abc')), 'a live generator passes through rngFrom untouched');
  ok(draw('abc').join() !== draw('abd').join(), 'a different seed, a different draw');
  // rng.js is copied verbatim from the benchmark, and its two doors are genuinely different:
  // a number is used as the raw generator state, a string is hashed first. Asserting they
  // agree would be asserting something the file does not do.
  eq(draw(9), draw(9), 'a numeric seed is as repeatable as a string one');
  eq(rngFrom(9)(), mulberry32(9)(), 'and the number really is the raw state');
  ok(draw(9).join() !== draw('9').join(), '9 and "9" are different doors, so a link must quote its seed');
  const raw = mulberry32(7);
  const seq = [raw(), raw(), raw()];
  eq(seq.map((v) => (v >= 0 && v < 1 ? 'in' : 'out')), ['in', 'in', 'in'], 'the generator stays in [0,1)');
  const r2 = mulberry32(99);
  const ints = [];
  for (let i = 0; i < 4000; i++) ints.push(r2.range(1, 4));
  eq(Math.min(...ints), 1, 'range hits its floor');
  eq(Math.max(...ints), 4, 'and its ceiling');
  eq(new Set(ints).size, 4, 'and every value in between');
  const shuffled = rngFrom('shuffle').shuffle([1, 2, 3, 4, 5, 6]);
  eq(shuffled.slice().sort((a, b) => a - b), [1, 2, 3, 4, 5, 6], 'shuffle permutes, it does not invent');
  eq(rngFrom('shuffle').shuffle([1, 2, 3, 4, 5, 6]), shuffled, 'and it is reproducible');
});

test('stats() measures the shelf instead of restating the generator', () => {
  const st = stats();
  eq(st.lots, ALL.length);
  eq(st.engine, ENGINE);
  eq(Object.keys(st.byBand).sort(), GEN_BANDS.map((b) => b.key).sort(), 'one entry per band that shipped');
  let counted = 0;
  for (const b of GEN_BANDS) {
    const s = st.byBand[b.key];
    const rows = lotsIn(b.key);
    counted += s.n;
    eq(s.n, rows.length, `${b.key} counted twice, differently`);
    eq(s.rule, rows[0].rule);
    eq(s.parMin, Math.min(...rows.map((r) => r.par)), `${b.key} parMin`);
    eq(s.parMax, Math.max(...rows.map((r) => r.par)), `${b.key} parMax`);
    ok(s.parMed >= s.parMin && s.parMed <= s.parMax, `${b.key} parMed outside its own range`);
    eq(s.stonesMin, Math.min(...rows.map((r) => sumOf(r.heaps))));
    eq(s.stonesMax, Math.max(...rows.map((r) => sumOf(r.heaps))));
    eq(s.heapsMin, Math.min(...rows.map((r) => r.heaps.length)));
    eq(s.heapsMax, Math.max(...rows.map((r) => r.heaps.length)));
    eq(s.cellsMax, Math.max(...rows.map((r) => r.cells)));
    eq(s.win, rows.reduce((a, r) => { a[r.winMoves] = (a[r.winMoves] || 0) + 1; return a; }, {}),
      `${b.key} winMoves distribution`);
    eq(s.differs, rows.filter((r) => r.scores.normal.outcome !== r.scores.misere.outcome
      || r.scores.normal.par !== r.scores.misere.par
      || r.scores.normal.winMoves !== r.scores.misere.winMoves).length, `${b.key} differs`);
    eq(s.invert, rows.filter((r) => r.scores.normal.outcome !== r.scores.misere.outcome).length, `${b.key} invert`);
  }
  eq(counted, ALL.length, 'the bands add up to the shelf, with nothing counted twice');
  eq(st.byBand.oddball.invert, st.byBand.oddball.n, 'the only band whose lots invert is the all-small one');
  eq(GEN_BANDS.filter((b) => b.key !== 'oddball').reduce((a, b) => a + st.byBand[b.key].invert, 0), 0,
    'and no other band inverts, which is the region theorem one more time');
  eq(st.byBand.spark.win, { 3: st.byBand.spark.n }, 'the teaching band shows three roads on every lot');
  eq(st.byBand.knife.differs, st.byBand.knife.n, 'every knife lot has a different par between the rules');
});

test('the browser cannot search: nothing it loads imports the solver or the generator', () => {
  // The structural half of the "closed form, O(k), never on click" requirement. A test over
  // the import graph beats a comment promising the same thing.
  const browserFiles = ['index.html', 'css/game.css', 'js/main.js', 'js/view.js', 'js/data/lots.js'];
  for (const rel of browserFiles) ok(existsSync(join(root, rel)), `${rel} is missing`);
  const loaded = ['js/main.js', 'js/view.js', 'js/data/lots.js',
    'js/core/heaps.js', 'js/core/bouton.js', 'js/core/ai.js', 'js/core/game.js',
    'js/core/library.js', 'js/core/storage.js', 'js/core/rng.js'];
  for (const rel of loaded) {
    const src = readFileSync(join(root, rel), 'utf8');
    ok(!/from '.*retro\.js'/.test(src), `${rel} imports the retrograde solver`);
    ok(!/from '.*make\.js'/.test(src), `${rel} imports the generator`);
    ok(!/positionScores|retrograde\(|gridOf\(/.test(src), `${rel} calls a search function`);
    ok(!/Math\.random/.test(src), `${rel} rolls dice`);
    if (rel.startsWith('js/core/') && rel !== 'js/core/storage.js') {
      // storage.js is the one core file allowed to name `window`, and only inside a try/catch
      // so Node and file:// degrade to memory. test/storage.test.mjs exercises that guard.
      const code = src.replace(/\/\/[^\n]*/g, '');
      ok(!/window\.|document\.|localStorage|require\(/.test(code), `${rel} touches a browser global`);
    }
  }
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  eq(/<link rel="icon" href="data:,">/.test(html), true, 'no favicon request: a data: URL answers it');
  eq(/<script type="module" src="\.\/js\/main\.js"><\/script>/.test(html), true, 'one module, no bundler');
  eq(/<canvas id="board"/.test(html), true, 'the board is a canvas, not a pile of divs');
  ok(!/fetch\(|https?:\/\//.test(html.replace(/<\/?(html|head|meta|body)[^>]*>/g, '')), 'the page fetches nothing');
  const styles = readFileSync(join(root, 'css/game.css'), 'utf8');
  ok(!/@import|url\(http/.test(styles), 'and neither does the stylesheet');
  eq(/<meta name="viewport"/.test(html), true, 'laid out for a phone');
});

run();
