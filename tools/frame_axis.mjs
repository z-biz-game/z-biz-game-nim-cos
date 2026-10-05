// 关卡内帧率对拍：同一份 ESM 图，分别按 30/60/120Hz 喂 rAF，逐字段对账。
//
// 为什么仓里要自己长一把尺：官方量具 cos_frame_probe.js 用 `vm.runInContext` 把每个
// `<script src>` 当**经典脚本**跑，而本仓的入口是 `<script type="module" src="./js/main.js">`
// ⇒ 三档全部 `SyntaxError: Cannot use import statement outside a module`，探针只会输出
// 「结论：无法比对」。这里改走 node 原生 ESM loader（与 cos_load_sweep 的 module 路径同法），
// 于是游戏真进关卡、真下棋、真爆炸，读得到末态。
//
// 两条轴各有各的用处，一条不够：
//   轴二（--events=step）事件钉在 **sim 步号** 上，比较"同一虚拟时长（同一 1/120 步号）"
//       处的末态 ⇒ 结构性帧率无关在这里必须是**逐位全等**（实测偏差 0.000）。
//   轴一（--wall=3）时间钉在墙钟上，比较"喂进同样多秒"之后跑出了几步 ⇒ 专门逮
//       `accum += 常数` 这类"把帧 dt 换成定值"的写法：它在轴二里是绿的（简报 §6 的口径）。
//   阴性对照按简报 §6 钉在"仍在吃帧 dt 的那一行"（accum += dt）与"每帧抽样的那一行"。
//
//   node tools/frame_axis.mjs                          ⇒ 三档 + 两发对照，一段 JSON
//   node tools/frame_axis.mjs --mut=accum-const        ⇒ 只跑某一种变异
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const argv = Object.fromEntries(process.argv.slice(2).map((s) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(s) || [];
  return [m[1], m[2] === undefined ? true : m[2]];
}));
const MUT = String(argv.mut || 'none');
const RATES = String(argv.rates || '30,60,120').split(',').map(Number);
const TARGET_STEPS = Number(argv.steps || 360);      // 3 虚拟秒 = 360 个 1/120 步
const WALL = Number(argv.wall || 3);                 // 轴一：喂满 3 墙钟秒
const WALL_TICKS = Math.round(WALL * 120);           // 同一件事，用整拍说
const LOT = argv.lot || 'deep-05';
const out = { mut: MUT, targetSteps: TARGET_STEPS, wall: WALL };

// ---------------------------------------------------------------- 变异副本
// 只改临时副本，产品仓一个字不动（简报 §1：不许把工作树弄脏）。
// 每发变异自己说"打哪个文件的哪一行"，锚点找不到就炸 —— 静默跳过会让阴性对照变成假绿。
const MUTANTS = {
  'accum-const': {
    file: 'js/anim.js',
    // 轴一的靶子：这一行仍在吃帧 dt，换成常量后"喂同样多秒"跑出的步数必然随帧率漂移
    anchor: '    accum += dt;',
    patch: '    accum += 1 / 60;   // MUTANT',
    label: 'anim.js: accum += dt  ->  accum += 1/60',
  },
  'frame-bernoulli': {
    // 轴二的靶子：把"事件决定抽样次数"改成"每帧按概率抽样"，帧率翻倍就等于粒子翻倍
    file: 'js/anim.js',
    anchor: '    accum += dt;',
    patch: "    accum += dt;\n    if (Math.random() < 0.02) spawn(200, 200, 'stone', 4, 120);   // MUTANT 每帧概率",
    label: 'anim.js: +if (Math.random() < 0.02) spawn(...) 每帧一次',
  },
  'pause-guard': {
    // 行为靶子（不是帧率）：摘掉唯一下棋通道上的暂停守卫，暂停期间的 tap 就该真下出一手
    file: 'js/main.js',
    anchor: "  if (session.phase === 'paused') {\n    say('已暂停",
    patch: "  if (false && session.phase === 'paused') {   // MUTANT 摘掉暂停守卫\n    say('已暂停",
    label: 'main.js: 暂停守卫 -> if (false && …)',
  },
};
function preparedDir() {
  if (MUT === 'none') return { dir: REPO, tmp: null, mutated: [] };
  const mut = MUTANTS[MUT];
  if (!mut) throw new Error(`未知变异 ${MUT}（可用：${Object.keys(MUTANTS).join(' / ')}）`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-frame-'));
  fs.cpSync(REPO, tmp, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules|dist|build)[\\/]/.test(s + '/') });
  const target = path.join(tmp, mut.file);
  const src = fs.readFileSync(target, 'utf8');
  if (!src.includes(mut.anchor)) throw new Error(`变异锚点找不到：${mut.file} 里那段守卫/累加代码被改写了，尺子的靶心得跟着改`);
  fs.writeFileSync(target, src.replace(mut.anchor, mut.patch));
  return { dir: tmp, tmp, mutated: [mut.label] };
}
const prepared = preparedDir();

// ---------------------------------------------------------------- 浏览器桩
// 时钟从 1000ms 起：从 0 起步会被 main.js 里 `lastTime = 0` 的首帧哨兵吃掉一帧，
// 凭空造出 25ms 的假帧率依赖（简报 §3 坑②）。
const sb = { clock: 1000, elapsed: 0, pending: [], timers: [], timerId: 1, handlers: { window: {}, document: {} }, seed: 0x2f6e2b1 };
const REAL_RANDOM = Math.random;
function reseed(s = 0x2f6e2b1) {
  sb.seed = s;
  Math.random = () => { sb.seed = (sb.seed * 1103515245 + 12345) & 0x7fffffff; return sb.seed / 0x7fffffff; };
}
function makeCtx() {
  const grad = { addColorStop() {} };
  return new Proxy({}, {
    get: (t, k) => {
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      if (typeof k === 'symbol') return undefined;
      const v = t[k];
      return v !== undefined && typeof v !== 'function' ? v : () => undefined;
    },
    set: (t, k, v) => { t[k] = v; return true; },
  });
}
function makeEl(id) {
  const h = {};
  return {
    id, tagName: id === 'board' ? 'CANVAS' : 'DIV', hidden: false, disabled: false,
    textContent: '', innerHTML: '', value: '', dataset: {}, style: {}, children: [],
    clientWidth: id === 'board' ? 640 : 300, clientHeight: 300, width: 640, height: 480,
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { on ? this._s.add(c) : this._s.delete(c); } },
      contains(c) { return this._s.has(c); } },
    addEventListener(t, cb) { (h[t] = h[t] || []).push(cb); },
    removeEventListener(t, cb) { h[t] = (h[t] || []).filter((f) => f !== cb); },
    dispatch(t, ev) { for (const cb of h[t] || []) cb(Object.assign({ type: t, target: this, preventDefault() {}, stopPropagation() {} }, ev)); },
    setAttribute(k, v) { this['attr_' + k] = v; }, getAttribute(k) { return this['attr_' + k]; },
    appendChild(c) { this.children.push(c); return c; },
    querySelector(s) { return makeEl(id + s); }, querySelectorAll: () => [],
    getContext: () => makeCtx(),
    getBoundingClientRect: () => ({ left: 20, top: 120, width: this.clientWidth, height: this.clientHeight || 400 }),
    focus() {}, blur() {}, remove() {}, scrollIntoView() {},
  };
}
const els = new Map();
const getEl = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
const docStub = {
  documentElement: makeEl('html'), body: makeEl('body'), title: '', hidden: false, fullscreenElement: null,
  getElementById: getEl, querySelector: (s) => getEl('q' + s), querySelectorAll: () => [],
  createElement: (t) => makeEl('created-' + t), fonts: { ready: Promise.resolve() },
  addEventListener(t, cb) { (sb.handlers.document[t] = sb.handlers.document[t] || []).push(cb); },
  removeEventListener() {},
};
const ls = new Map();
function fireTimers() {
  for (const t of sb.timers) {
    if (t.dead || t.at > sb.clock) continue;
    if (t.interval) t.at = sb.clock + t.interval; else t.dead = true;
    try { t.cb(); } catch (e) { /* 定时器回调抛错不许中断推进 */ }
  }
  for (let i = sb.timers.length - 1; i >= 0; i--) if (sb.timers[i].dead) sb.timers.splice(i, 1);
}
function define(name, value) {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: true });
}
define('document', docStub);
define('window', globalThis);
define('self', globalThis);
define('navigator', { userAgent: 'frame_axis', maxTouchPoints: 0, language: 'zh-CN' });
define('location', {
  href: `http://127.0.0.1/index.html#/lot/${LOT}`, protocol: 'http:', origin: 'http://127.0.0.1', pathname: '/index.html',
  get hash() { return this._h || `#/lot/${LOT}`; },
  set hash(v) { this._h = v; for (const cb of sb.handlers.window.hashchange || []) cb({ type: 'hashchange' }); },
});
define('localStorage', { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), clear: () => ls.clear() });
define('requestAnimationFrame', (cb) => { sb.pending.push(cb); return sb.pending.length; });
define('cancelAnimationFrame', () => {});
define('performance', { now: () => sb.clock });
define('setTimeout', (cb, ms) => { const id = sb.timerId++; sb.timers.push({ at: sb.clock + Math.max(0, Number(ms) || 0), cb, id }); return id; });
define('setInterval', (cb, ms) => { const iv = Math.max(1, Number(ms) || 1), id = sb.timerId++; sb.timers.push({ at: sb.clock + iv, cb, id, interval: iv }); return id; });
define('clearTimeout', (id) => { const t = sb.timers.find((x) => x.id === id); if (t) t.dead = true; });
define('clearInterval', globalThis.clearTimeout);
define('matchMedia', (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {} }));
define('devicePixelRatio', 2);
define('innerWidth', 1200);
define('innerHeight', 900);
define('addEventListener', (t, cb) => { (sb.handlers.window[t] = sb.handlers.window[t] || []).push(cb); });
define('removeEventListener', () => {});
define('dispatchEvent', () => true);
define('ResizeObserver', function () { return { observe() {}, unobserve() {}, disconnect() {} }; });
define('Image', function () { const h = {}; return { addEventListener(t, cb) { (h[t] = h[t] || []).push(cb); }, set src(v) { void v; }, get src() { return ''; } }; });
define('AudioContext', function () {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, setTargetAtTime() {}, cancelScheduledValues() {}, cancelAndHoldAtTime() {}, setValueCurveAtTime() {} });
  const node = () => ({ connect: (d) => d, disconnect() {}, start() {}, stop() {}, type: 'sine', frequency: param(), detune: param(), gain: param(), Q: param(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(), playbackRate: param() });
  const ac = {
    createOscillator: node, createGain: node, createBiquadFilter: node, createBufferSource: node,
    createDynamicsCompressor: node, createStereoPanner: node, createWaveShaper: node,
    createBuffer: () => ({ getChannelData: () => new Float32Array(1024), length: 1024, sampleRate: 44100 }),
    destination: { maxChannelCount: 2 }, currentTime: 0, sampleRate: 44100, state: 'suspended',
    resume() { ac.state = 'running'; return Promise.resolve(); },
    suspend() { ac.state = 'suspended'; return Promise.resolve(); },
    close() { return Promise.resolve(); },
  };
  return ac;
});
define('HTMLElement', function () {});
define('HTMLCanvasElement', function () {});
define('CSS', { supports: () => false });
define('getComputedStyle', () => ({ getPropertyValue: () => '' }));
define('history', { replaceState(_, __, hash) { globalThis.location.hash = hash; }, pushState() {}, state: null, length: 1 });
define('console', { log() {}, warn() {}, error() {}, info() {}, debug() {} });

// ---------------------------------------------------------------- 推进
await import(pathToFileURL(path.join(prepared.dir, 'js/main.js')).href);
const nim = globalThis.window.nim;
if (!nim) throw new Error('window.nim 没挂出来：任何探针都读不到状态');

// 事件钉在 sim 步号上（轴二）：钉在墙钟上会让同一步号处的爆炸时机差几帧，那是尺子的粒度
// 而不是游戏的缺陷，逐位全等就没有可比性。
const SCHEDULE = [
  { step: 24, act: 'lift', i: 0 }, { step: 28, act: 'move' },
  { step: 72, act: 'lift', i: 1 }, { step: 76, act: 'move' },
  { step: 110, act: 'burst' },
  { step: 120, act: 'pause' },
  { step: 200, act: 'burst' },
  { step: 240, act: 'lift', i: 1 }, { step: 244, act: 'move' },
  { step: 300, act: 'lift', i: 0 }, { step: 304, act: 'move' },
];
// 暂停守卫的探针钉在"拍"上（暂停窗口 = 第 120..240 拍），两轴都会真的落在暂停中途。
// 单独一支队列、不进 SCHEDULE：那条是按步号推进的，暂停期间步号不动，探针就永远排不上。
const PROBES = [{ tick: 150, act: 'lift', i: 1 }, { tick: 154, act: 'move' }];
function act(a) {
  const st = nim.state;
  if (a.act === 'lift') {
    const idx = a.i ?? st.heaps.findIndex((n) => n > 0);
    const i = st.heaps[idx] > 0 ? idx : st.heaps.findIndex((n) => n > 0);
    if (i >= 0) nim.lift(i);
  } else if (a.act === 'move') {
    const s2 = nim.state;
    if (s2.selected >= 0) {
      const opts = nim.winMovesHere(s2.selected);
      nim.tap(s2.selected, opts.length ? opts[0] : Math.max(0, s2.heaps[s2.selected] - 1));
    }
  } else if (a.act === 'burst') nim.burst(0, Math.max(1, nim.state.heaps[0]), 0, 'stone');
  else if (a.act === 'pause') nim.setPaused(true);
  else if (a.act === 'resume') nim.setPaused(false);
}
// 时钟只能按整拍走：一拍 = 1/120 秒 = sim 的一步。三档的帧长（4/2/1 拍）都是整数，
// 若把 dt 当浮点秒累加，30Hz 每帧会少掉 1 ulp，步号就永远落在 …3/7/11 上，
// 与 60/120Hz 的步号集合几乎不相交 —— 对拍尺子自己先把可比性弄丢了。
const TICK_MS = 1000 / 120;
function stepFrame(ticks) {
  const cb = sb.pending.shift();
  if (!cb) throw new Error('rAF 队列空了：主循环没有自续');
  sb.ticks += ticks;
  sb.clock = 1000 + sb.ticks * TICK_MS;
  sb.elapsed = sb.ticks / 120;
  fireTimers();
  cb(sb.clock);
}
function snapshot() {
  const q = nim.sim(), st = nim.state;
  return { steps: q.steps, clock: Math.round(q.clock * 1e6) / 1e6, accum: Math.round(q.accum * 1e12) / 1e12,
    n: q.particles, spawn: q.spawned, sx: Math.round(q.sx * 1e4) / 1e4, sy: Math.round(q.sy * 1e4) / 1e4,
    sl: Math.round(q.sl * 1e4) / 1e4, plies: st.plies, stones: st.stones, heaps: st.heaps.join(','),
    history: st.history.length, phase: st.phase, paused: st.paused, muted: st.muted };
}
function runRate(fps, mode) {
  // 两轴共用同一支日程：暂停期间下棋由 PROBES 证，不再靠"某一轴跳过这段"来躲边界。
  const SCHED = SCHEDULE;
  reseed();
  nim.setMuted(false);
  nim.setPaused(false);
  nim.startLevel(LOT);
  sb.ticks = 0; sb.clock = 1000; sb.elapsed = 0; sb.timers.length = 0;
  // rAF 队列不清：里面正是主循环自续登记的那一个回调，清了下一帧就取不到人。
  // 开局那一帧的 dt 必须是 0（首帧哨兵），所以先喂一帧空帧把状态摆正
  stepFrame(0);
  const byStep = new Map();
  const freeze = [];
  let si = 0, pi = 0, frames = 0, pausedFrames = 0, guard = 0, pauseUntil = null;
  const frameTicks = Math.round(120 / fps);
  const PAUSE_SPAN = 120;          // 一拍一步，暂停 1 秒 = 120 拍
  const record = () => { const s = snapshot(); if (!byStep.has(s.steps)) byStep.set(s.steps, s); };
  const done = () => (mode === 'wall' ? sb.ticks >= WALL_TICKS : nim.sim().steps >= TARGET_STEPS);
  while (!done() && guard++ < 40000) {
    record();
    if (nim.state.paused) pausedFrames++;
    let dt = frameTicks;
    // 日程项的 step 就是"第几拍"（1 拍 = 1 步），两轴共用同一套整数边界。
    const next = si < SCHED.length ? SCHED[si].step : null;
    if (next !== null) {
      const cur = mode === 'step' ? nim.sim().steps : sb.ticks;
      dt = next > cur ? Math.min(dt, next - cur) : 0;    // 边界已到：这一帧只发事件，不喂时间
    }
    if (pauseUntil !== null && pauseUntil > sb.ticks) dt = Math.min(dt, pauseUntil - sb.ticks);
    if (dt > 0) stepFrame(dt);
    // 同刻先放行暂停，再发这一帧到期的日程项；反过来的话 lift 会被暂停守卫拒掉，
    // 三档下出的手数就不一样了 —— 那是尺子的粒度，不是游戏的帧率依赖。
    if (pauseUntil !== null && sb.ticks >= pauseUntil) {
      pauseUntil = null;
      act({ act: 'resume' });
      freeze.push(['resume@step' + nim.sim().steps, nim.sim().clock]);
    }
    while (si < SCHED.length && (mode === 'step' ? SCHED[si].step <= nim.sim().steps : sb.ticks >= SCHED[si].step)) {
      const a = SCHED[si];
      const stepsBefore = nim.sim().steps;
      act(a);
      if (a.act === 'pause') { pauseUntil = sb.ticks + PAUSE_SPAN; freeze.push(['pause@step' + stepsBefore, nim.sim().clock]); }
      if (a.act === 'move') freeze.push(['tap@step' + stepsBefore + '→plies' + nim.state.plies]);
      if (a.act === 'lift') freeze.push(['lift@step' + stepsBefore + ' sel=' + nim.state.selected + ' phase=' + nim.state.phase + ' t=' + sb.elapsed.toFixed(6)]);
      si++;
    }
    while (pi < PROBES.length && sb.ticks >= PROBES[pi].tick) {
      const p = PROBES[pi];
      const pliesBefore = nim.state.plies;
      act(p);
      freeze.push(['probe:' + p.act + '@tick' + sb.ticks + ' phase=' + nim.state.phase +
        ' plies=' + pliesBefore + '→' + nim.state.plies]);
      pi++;
    }
    frames++;
    record();
  }
  const s = snapshot();
  return { fps, mode, frames, pausedFrames, freeze, end: s, wall: Math.round(sb.elapsed * 1e6) / 1e6,
    byStep: [...byStep.values()] };
}
const modes = argv.mode ? [String(argv.mode)] : ['step', 'wall'];
for (const mode of modes) {
  const runs = {};
  for (const fps of RATES) runs[fps] = runRate(fps, mode);
  const common = RATES.map((f) => new Set(runs[f].byStep.map((x) => x.steps)))
    .reduce((a, b) => new Set([...a].filter((k) => b.has(k))));
  const keys = ['sx', 'sy', 'sl', 'n', 'spawn', 'plies', 'stones', 'heaps', 'history', 'clock'];
  const maps = Object.fromEntries(RATES.map((f) => [f, Object.fromEntries(runs[f].byStep.map((x) => [x.steps, x]))]));
  const spread = {};
  for (const k of keys) {
    let worst = 0, badSteps = 0;
    for (const st of common) {
      const vals = RATES.map((f) => maps[f][st][k]);
      const d = typeof vals[0] === 'number' ? Math.max(...vals) - Math.min(...vals) : (new Set(vals).size > 1 ? 1 : 0);
      if (d > 0) badSteps++;
      worst = Math.max(worst, d);
    }
    // 判尺：把"同一步号处三档的差"和"这一步本身会让该字段动多少"放在一起看。
    // 一阶采样滞后的比值天然 ≤3.0，>3.6 才算帧率依赖（简报 §3）。
    let gap = 0;
    for (const st of common) {
      const here = maps[120][st];
      const nxt = maps[120][st + 1];
      if (!nxt || typeof here[k] !== 'number') continue;
      gap = Math.max(gap, Math.abs(nxt[k] - here[k]));
    }
    const ratio = gap > 1e-9 ? worst / gap : (worst === 0 ? 0 : Infinity);
    spread[k] = { worst, badSteps, checkpoints: common.size, gap: Math.round(gap * 1e4) / 1e4,
      ratio: Number.isFinite(ratio) ? Math.round(ratio * 100) / 100 : 'inf' };
  }
  out.modes = out.modes || {};
  out.modes[mode] = { spread, endSteps: Object.fromEntries(RATES.map((f) => [f, runs[f].end.steps])),
    endSpawn: Object.fromEntries(RATES.map((f) => [f, runs[f].end.spawn])),
    frames: Object.fromEntries(RATES.map((f) => [f, runs[f].frames])),
    wall: Object.fromEntries(RATES.map((f) => [f, runs[f].wall])),
    freeze: Object.fromEntries(RATES.map((f) => [f, runs[f].freeze])), pausedFrames: Object.fromEntries(RATES.map((f) => [f, runs[f].pausedFrames])),
    end: Object.fromEntries(RATES.map((f) => [f, runs[f].end])) };
}
out.mutated = prepared.mutated;
out.rng = Math.random !== REAL_RANDOM ? 'seeded-lcg' : 'native';
if (prepared.tmp) fs.rmSync(prepared.tmp, { recursive: true, force: true });
process.stdout.write(JSON.stringify(out) + '\n');
