// The content pipeline: this is where the levels come from, and the browser never runs it.
//
//   node tools/bake.mjs                     # -> js/data/lots.js
//   PER_BAND=4 node tools/bake.mjs          # a smaller pool while the view is being wired
//   SMOKE=1 node tools/bake.mjs             # 2 lots per band, prints the table, writes nothing
//
// Why offline: every number on screen (`outcome`, `winMoves`, `par`) is the answer of a
// complete retrograde analysis, and `retro.js` is a real search: the shared grid every
// candidate is screened on is 10,000 positions and 180,000 edges, and a lot's own reachable
// box — the second graph its numbers are re-measured on — runs up to 4,032 positions for the
// widest lot in the shipped pool. That is a fine build step and an unacceptable tap. The
// measured timings are printed below and quoted in README and DESIGN.
//
// Nothing unmeasured ships: a candidate only enters the file after its numbers have been
// recomputed a second time from a *different* graph — its own reachable box rather than the
// shared one the generator sampled from — and the two answers have to agree.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { BANDS, makeLot } from '../js/core/make.js';
import { measure, engineInfo, positionScores } from '../js/core/retro.js';
import { validate } from '../js/core/heaps.js';
// js/core/library.js is imported *after* the file is written, with a cache-busting query:
// it statically imports js/data/lots.js, which on a first bake does not exist yet and on a
// re-bake is already in this process's module cache holding the previous pool.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PER_BAND = Number(process.env.PER_BAND || 0);
const SMOKE = process.env.SMOKE === '1';
const MAX_STATES = Number(process.env.MAX_STATES || 400000);
const DEADLINE = Number(process.env.DEADLINE_MS || 8000);

const engine = engineInfo();
console.log(`engine: grid ${engine.maxVec.join('x')} = ${engine.states} positions, ${engine.edges} edges, one pass per rule`);

const out = [];
const bandMeta = [];
for (const band of BANDS) {
  const want = SMOKE ? 2 : (PER_BAND || band.per);
  const seen = new Set();
  const tally = { sigs: seen };
  const picked = [];
  const t0 = Date.now();
  let searched = 0;
  const budget = want * 60;
  while (picked.length < want && searched < budget) {
    const lot = makeLot(`bake-${band.key}-${searched++}`, band, tally);
    if (!lot) continue;
    const err = validate(lot.heaps);
    if (err) throw new Error(`${band.key}: generator emitted an invalid lot: ${err}`);
    // Second, independent measurement: this lot's own reachable box, not the shared grid.
    const own = positionScores(lot.heaps, { maxStates: MAX_STATES, deadlineMs: DEADLINE });
    for (const rule of ['normal', 'misere']) {
      const a = lot.scores[rule];
      const b = own[rule];
      if (a.outcome !== b.outcome || a.par !== b.par || a.winMoves !== b.winMoves) {
        throw new Error(
          `${band.key} ${lot.heaps.join(',')}: ${rule} measured twice and disagreed `
          + `(shared ${JSON.stringify(a)} vs own box ${JSON.stringify(b)})`,
        );
      }
    }
    picked.push({
      heaps: lot.heaps,
      rule: lot.rule,
      band: band.key,
      outcome: lot.outcome,
      par: lot.par,
      winMoves: lot.winMoves,
      scores: lot.scores,
      cells: own.states,
    });
  }
  const ms = Date.now() - t0;
  if (picked.length < want) console.error(`warn: ${band.key} reached only ${picked.length} of ${want} lots in ${searched} searches`);
  picked.sort((a, b) => a.par - b.par || a.cells - b.cells || signatureOf(a).localeCompare(signatureOf(b)));
  picked.forEach((p, i) => {
    p.id = `${band.key}-${String(i + 1).padStart(2, '0')}`;
    p.index = BANDS.indexOf(band);
    out.push(p);
  });
  const pars = picked.map((p) => p.par);
  const win = {};
  for (const p of picked) win[p.winMoves] = (win[p.winMoves] || 0) + 1;
  bandMeta.push({
    key: band.key,
    label: band.label,
    blurb: band.blurb,
    rule: band.rule,
    n: picked.length,
    parMin: pars.length ? Math.min(...pars) : 0,
    parMax: pars.length ? Math.max(...pars) : 0,
  });
  const rejects = Object.keys(tally)
    .filter((k) => k !== 'sigs' && k !== 'found')
    .map((k) => `${k}:${tally[k]}`)
    .join(' ');
  console.log(
    `${band.key.padEnd(8)} ${band.rule.padEnd(6)} n=${String(picked.length).padStart(2)}`
    + `  par ${pars.length ? `${Math.min(...pars)}-${Math.max(...pars)}` : '-'}`
    + `  winMoves {${Object.entries(win).map(([k, v]) => `${k}:${v}`).join(' ')}}`
    + `  cells ${Math.max(0, ...picked.map((p) => p.cells))}`
    + `  ${(ms / 1000).toFixed(2)}s  searches ${searched}`
    + `\n         reject: ${rejects || 'none'}`,
  );
}

function signatureOf(p) {
  return p.heaps.slice().sort((a, b) => a - b).join('+');
}

const dup = new Set();
for (const p of out) {
  const sig = signatureOf(p);
  if (dup.has(sig)) throw new Error(`duplicate lot across bands: ${sig}`);
  dup.add(sig);
}

if (!SMOKE) {
  const lines = [
    '// Generated by tools/bake.mjs — the levels in this game are measurements, not opinions.',
    '// Each row carries three printed numbers, all of them computed at build time by a',
    '// complete retrograde analysis (js/core/retro.js) over that lot\'s own reachable box,',
    '// and each was then recomputed a second time on the shared grid before it was allowed',
    '// in. Re-run `node tools/bake.mjs` instead of hand-editing: node test/library.test.mjs',
    '// solves every row from scratch and fails if a line and its numbers ever disagree.',
    `export const ENGINE = ${JSON.stringify(engine)};`,
    `export const BANDS_META = ${JSON.stringify(bandMeta)};`,
    'export const LOTS = [',
    ...out.map((l) => `  ${JSON.stringify(l)},`),
    '];',
    '',
  ];
  const path = join(root, 'js', 'data', 'lots.js');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join('\n'));
  console.log(`wrote ${out.length} lots -> js/data/lots.js`);
} else {
  console.log(`SMOKE: ${out.length} lots measured, nothing written`);
  process.exit(0);
}

// The table the README quotes, printed from what actually shipped rather than from a copy,
// and through the same lookup the shipped game and test/library.test.mjs use.
const lib = await import(`${pathToFileURL(join(root, 'js', 'core', 'library.js')).href}?rebake=${Date.now()}`);
const st = lib.stats();
const camp = lib.campaign();
console.log(`\npool: ${st.lots} lots`);
for (const b of BANDS) {
  const s = st.byBand[b.key];
  if (!s) continue;
  console.log(
    `  ${b.key.padEnd(8)} ${b.label} ${b.rule.padEnd(6)} n=${s.n}`
    + `  par ${s.parMin}-${s.parMax} (median ${s.parMed})`
    + `  winMoves {${Object.entries(s.win).map(([k, v]) => `${k}:${v}`).join(' ')}}`
    + `  heaps ${s.heapsMin}-${s.heapsMax}  stones ${s.stonesMin}-${s.stonesMax}`
    + `  own box ${s.cellsMax}`
    + `  | numbers differ between the two rules on ${s.differs}, verdicts invert on ${s.invert}`,
  );
}
console.log(`  campaign first lot ${camp[0].id}, last ${camp[camp.length - 1].id}`);
console.log(`  measure() (shared grid) agrees with the shipped rows (own-box grid) on all ${camp.length} lots`
  + `: ${camp.every((l) => {
    const m = measure(l.heaps);
    return m.normal.par === l.scores.normal.par && m.misere.par === l.scores.misere.par
      && m.normal.outcome === l.scores.normal.outcome && m.misere.outcome === l.scores.misere.outcome;
  })}`);
