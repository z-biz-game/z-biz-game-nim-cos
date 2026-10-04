// Pixels and gestures. Nothing in this file decides a rule, a verdict or a score: it draws
// the heaps it is handed, turns a tap into `{ i, to }` — "heap i, bring it down to `to`
// stones" — and asks the shell to make of that what the core allows.
//
// Two shapes matter:
//
//   * the *strip* under a tap. Each heap is a column of stones; the strip the (t+1)-th stone
//     from the bottom sits in is the target `to = t`, and the empty strip above the top stone
//     is `to = n` — taking nothing. The view reports both; only `game.js` refuses the second
//     one, so a stray pixel can never disagree with a test.
//   * the layout is computed once per frame and reused for hit testing and for
//     `point(i, to)`, which is how the playtest aims a real mouse click at a real stone.
//
// Imports: `bouton.js` for the green strips, and that is all. No solver, no generator.

import { winningMoves } from './core/bouton.js';
import { isTerminal } from './core/heaps.js';

const PAD = 10;
const GAP = 0.55;          // column gap, in stone widths
const LABEL = 18;          // room for the heap number
const BOTTOM = 8;          // floor line above the canvas edge
const MAX_BAND = 34;       // a stone is never taller than this, however few the heaps
const MIN_BAND = 13;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function createView(canvas, handlers = {}) {
  const ctx = canvas.getContext('2d');
  let state = {
    heaps: [], rule: 'normal', selected: -1, last: null, done: false, showStrips: false,
  };
  let cssW = 0;
  let cssH = 0;
  let cols = [];
  let band = MIN_BAND;

  // One source of truth for drawing and for hit testing: recompute at every size, use it
  // everywhere else.
  function layout() {
    const n = state.heaps.length;
    const maxN = n ? Math.max(...state.heaps, 1) : 1;
    cssW = Math.max(240, canvas.clientWidth || 320);
    band = Math.max(MIN_BAND, Math.min(MAX_BAND, Math.floor(((cssW - 2 * PAD) / (n || 1)) * GAP)));
    const wantH = (maxN + 1) * band + LABEL + BOTTOM + PAD;
    cssH = Math.max(180, wantH);
    const totalW = n * band + (n - 1) * band * GAP;
    const start = Math.max(PAD, Math.floor((cssW - totalW) / 2));
    const bottom = cssH - BOTTOM;
    cols = state.heaps.map((size, i) => ({
      i,
      size,
      x: start + i * band * (1 + GAP),
      w: band,
      top: bottom - (size + 1) * band,
      bottom,
    }));
  }

  function targetsOf(col) {
    // Which `to` values win right now, from the closed form. Recomputed per frame, which is
    // O(k) over heaps — the point of the theorem is that this is never a search.
    if (col.i !== state.selected || state.done || isTerminal(state.heaps)) return null;
    const set = new Set();
    for (const m of winningMoves(state.heaps, state.rule)) if (m.i === col.i) set.add(m.to);
    return set;
  }

  function drawStrip(col, t, win) {
    const y = col.bottom - (t + 1) * band;
    ctx.save();
    ctx.setLineDash([3, 4]);
    ctx.strokeStyle = win ? '#57c98a' : '#3a4048';
    ctx.lineWidth = win ? 1.6 : 1;
    ctx.strokeRect(col.x + 1.5, y + 1.5, col.w - 3, band - 3);
    if (win) {
      ctx.setLineDash([]);
      ctx.fillStyle = '#57c98a22';
      ctx.fillRect(col.x + 1.5, y + 1.5, col.w - 3, band - 3);
    }
    ctx.restore();
    ctx.fillStyle = win ? '#57c98a' : '#6b7280';
    ctx.font = `${Math.max(9, band * 0.42)}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(t), col.x + 3, y + band / 2);
  }

  function drawStone(col, t) {
    const y = col.bottom - (t + 1) * band;
    const w = col.w - 8;
    const h = band - 4;
    const x = col.x + 4;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#ded9cc');
    g.addColorStop(1, '#a29c8e');
    ctx.fillStyle = g;
    roundRect(ctx, x, y + 2, w, h, Math.min(7, h / 2));
    ctx.fill();
    ctx.strokeStyle = '#00000055';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff30';
    roundRect(ctx, x + 3, y + 4, w - 6, Math.max(2, h * 0.22), 2);
    ctx.fill();
  }

  function render(next) {
    state = Object.assign({}, state, next || {});
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    layout();
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#171a20';
    roundRect(ctx, 0.5, 0.5, cssW - 1, cssH - 1, 8);
    ctx.fill();
    ctx.strokeStyle = '#2b3038';
    ctx.stroke();

    for (const col of cols) {
      const sel = col.i === state.selected;
      if (sel) {
        ctx.fillStyle = '#e0b64a14';
        roundRect(ctx, col.x - 2, PAD - 4, col.w + 4, cssH - PAD - 4, 6);
        ctx.fill();
      }
      const wins = state.showStrips || sel ? targetsOf(col) : null;
      for (let t = 0; t <= col.size; t++) if (wins || sel) drawStrip(col, t, wins ? wins.has(t) : false);
      for (let t = 0; t < col.size; t++) drawStone(col, t);
      if (state.last && state.last.i === col.i && !state.done) {
        ctx.fillStyle = '#d7695f';
        ctx.font = `${Math.max(10, band * 0.42)}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.fillText('↑', col.x + col.w / 2, col.top - 2);
      }
      ctx.fillStyle = sel ? '#e0b64a' : '#9d9a93';
      ctx.font = `${LABEL - 6}px ui-monospace, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`${col.i + 1}:${col.size}`, col.x + col.w / 2, PAD + 3);
    }
    ctx.fillStyle = '#2b3038';
    ctx.fillRect(PAD, cssH - BOTTOM + 3, cssW - 2 * PAD, 1);
  }

  // client coordinates -> { i, to }
  function hit(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const x = clientX - r.left;
    const y = clientY - r.top;
    for (const col of cols) {
      if (x < col.x - 2 || x > col.x + col.w + 2) continue;
      if (y > col.bottom || y < col.top - band) return null;
      const t = Math.max(0, Math.min(col.size, Math.floor((col.bottom - y) / band)));
      return { i: col.i, to: t, size: col.size };
    }
    return null;
  }

  // ...and the reverse, so a test can aim at a specific outcome rather than at a pixel and
  // hope. Returns client coordinates, which is what `Input.dispatchMouseEvent` wants.
  function point(i, to) {
    const col = cols[i];
    if (!col) return null;
    const t = Math.max(0, Math.min(col.size, to));
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.round(r.left + col.x + col.w / 2),
      y: Math.round(r.top + col.bottom - (t + 0.5) * band),
      inside: t < col.size,
    };
  }

  function onTap(ev) {
    const hitAt = hit(ev.clientX, ev.clientY);
    if (handlers.tap) handlers.tap(hitAt, state);
  }

  canvas.addEventListener('pointerdown', onTap);
  window.addEventListener('resize', () => render());

  // The box also moves for reasons this file cannot see: the panel fills with text, the page
  // tips past the viewport, and on a platform where scrollbars take room that narrows the
  // column the canvas sits in without changing the window — so no `resize` fires and the
  // backing store we sized from the wider read stays on screen. game.css reserves the gutter,
  // which removes the feedback entirely; this covers a browser where `scrollbar-gutter` is
  // unsupported (Safari) by re-measuring when the box itself changes. Comparing against the
  // width `layout()` last used is what keeps this from re-rendering its own height change.
  let observed = null;
  if (typeof ResizeObserver === 'function') {
    observed = new ResizeObserver(() => {
      if (Math.max(240, canvas.clientWidth || 320) !== cssW) render();
    });
    observed.observe(canvas);
  }

  return {
    render,
    point,
    hit,
    layout: () => cols.map((c) => ({ i: c.i, size: c.size, x: c.x, w: c.w, band })),
    get state() { return state; },
    get size() { return { cssW, cssH, band }; },
    destroy() {
      canvas.removeEventListener('pointerdown', onTap);
      if (observed) observed.disconnect();
    },
  };
}
