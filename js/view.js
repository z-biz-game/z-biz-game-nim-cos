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
//
// 2026-10-02 加了一层"看得见的动"：桌布与石屑用 assets/textures/ 里的真位图（由
// assets/gen/make_art.py 现算，不外链），粒子状态归 js/anim.js 的定步长仿真所有，本文件
// 只负责把它交过来的位置画成像素。纹理没加载成功（file://、离线、单测沙箱）就退回原来的
// 程序化画法 —— 画面少一张桌布，功能一颗不少。

import { winningMoves } from './core/bouton.js';
import { isTerminal } from './core/heaps.js';

const ART = {
  table: './assets/textures/table.png',
  win: './assets/textures/spark-win.png',
  pick: './assets/textures/spark-pick.png',
  lose: './assets/textures/spark-lose.png',
  stone: './assets/textures/spark-stone.png',
};

// 浏览器给的 Image 桩（或没有 Image）都不能让这里抛错：ready 只是"少画一张图"的开关。
function loadArt() {
  const art = { ready: {}, size: {} };
  for (const key of Object.keys(ART)) {
    if (typeof Image !== 'function') break;
    const img = new Image();
    art.ready[key] = false;
    img.addEventListener('load', () => { art.ready[key] = true; });
    img.addEventListener('error', () => { art.ready[key] = false; });
    img.src = ART[key];
    art[key] = img;
  }
  return art;
}

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
  const { sim = null } = handlers;
  const art = loadArt();
  const ctx = canvas.getContext('2d');
  let state = {
    heaps: [], rule: 'normal', selected: -1, last: null, done: false, showStrips: false, paused: false,
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
    const beat = win && sim ? sim.pulse() : 1;   // 只有必胜框呼吸：其余一律静图
    ctx.save();
    ctx.globalAlpha = win ? 0.62 + 0.38 * beat : 1;
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

  function drawStone(col, t, rise = 0) {
    const y = col.bottom - (t + 1) * band - rise;
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
    roundRect(ctx, 0.5, 0.5, cssW - 1, cssH - 1, 8);
    if (art.ready.table && art.table) {
      ctx.save();
      ctx.clip();
      ctx.drawImage(art.table, 0, 0, cssW, cssH);
      ctx.restore();
      ctx.strokeStyle = '#2b3038';
      ctx.stroke();
    } else {
      ctx.fillStyle = '#171a20';
      ctx.fill();
      ctx.strokeStyle = '#2b3038';
      ctx.stroke();
    }
    const lift = sim && !state.paused ? sim.breath() * 2 : 0;

    for (const col of cols) {
      const sel = col.i === state.selected;
      if (sel) {
        ctx.fillStyle = '#e0b64a14';
        roundRect(ctx, col.x - 2, PAD - 4, col.w + 4, cssH - PAD - 4, 6);
        ctx.fill();
      }
      const wins = state.showStrips || sel ? targetsOf(col) : null;
      for (let t = 0; t <= col.size; t++) if (wins || sel) drawStrip(col, t, wins ? wins.has(t) : false);
      for (let t = 0; t < col.size; t++) drawStone(col, t, sel ? lift : 0);
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

    if (sim) {
      for (const p of sim.particles) {
        const img = art[p.kind];
        const r = band * 0.5 * p.size;
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life / p.ttl));
        if (art.ready[p.kind] && img) {
          ctx.drawImage(img, p.x - r, p.y - r, r * 2, r * 2);
        } else {
          ctx.fillStyle = p.kind === 'lose' ? '#d7695f' : p.kind === 'win' ? '#57c98a'
            : p.kind === 'pick' ? '#e0b64a' : '#d8d3c6';
          ctx.fillRect(p.x - r * 0.35, p.y - r * 0.35, r * 0.7, r * 0.7);
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  // 一手棋之后炸在盘上的那几颗：坐标由本帧真实画出来的列算，不是由推测算。
  function burst(i, from, to, kind) {
    if (!sim) return 0;
    const col = cols[i];
    if (!col) return 0;
    let n = 0;
    const high = Math.max(to, Math.min(from, col.size));
    for (let t = Math.max(0, to); t < high; t++) {
      const x = col.x + col.w / 2;
      const y = col.bottom - (t + 0.5) * band;
      n += sim.spawn(x, y, kind || 'stone', 5, band * 3.2);
    }
    return n;
  }

  // client coordinates -> { i, to }。换算走 rect：画布可能被 CSS 缩放过（width:100% 加上
  // 页面缩放、或父栏比 layout 当时读到的宽度窄），直接用 clientX-left 就会"点 A 打 B"。
  function hit(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const sx = r.width > 0 ? cssW / r.width : 1;
    const sy = r.height > 0 ? cssH / r.height : 1;
    const x = (clientX - r.left) * sx;
    const y = (clientY - r.top) * sy;
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
    // hit() 的逆：layout 坐标 → client 坐标，同一条 rect 缩放链反着走一遍。
    const sx = r.width > 0 ? r.width / cssW : 1;
    const sy = r.height > 0 ? r.height / cssH : 1;
    return {
      x: Math.round(r.left + (col.x + col.w / 2) * sx),
      y: Math.round(r.top + (col.bottom - (t + 0.5) * band) * sy),
      inside: t < col.size,
    };
  }

  function onTap(ev) {
    const hitAt = hit(ev.clientX, ev.clientY);
    if (handlers.tap) handlers.tap(hitAt, state);
  }

  // pointerdown 优先；没有 PointerEvent 的环境（老 Safari、某些 WebView）回落到
  // touchstart / mousedown。回落只在真没有指针事件时挂，否则一次点击会被两条通道各记一手。
  let pointerDown = false;
  if (typeof PointerEvent === 'function' || 'onpointerdown' in canvas) {
    pointerDown = true;
    canvas.addEventListener('pointerdown', onTap);
  }
  function onTouch(ev) {
    const t = (ev.changedTouches && ev.changedTouches[0]) || null;
    if (!t) return;
    if (ev.preventDefault) ev.preventDefault();   //  prevent 掉浏览器随后补的那一下 mousedown
    onTap({ clientX: t.clientX, clientY: t.clientY });
  }
  function onMouse(ev) {
    if (pointerDown) return;
    onTap(ev);
  }
  if (!pointerDown) {
    canvas.addEventListener('touchstart', onTouch, { passive: false });
    canvas.addEventListener('mousedown', onMouse);
  }
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
    burst,
    artReady: () => Object.keys(art.ready).filter((k) => art.ready[k]),
    layout: () => cols.map((c) => ({ i: c.i, size: c.size, x: c.x, w: c.w, band })),
    get state() { return state; },
    get size() { return { cssW, cssH, band }; },
    destroy() {
      canvas.removeEventListener('pointerdown', onTap);
      canvas.removeEventListener('touchstart', onTouch);
      canvas.removeEventListener('mousedown', onMouse);
      if (observed) observed.disconnect();
    },
  };
}
