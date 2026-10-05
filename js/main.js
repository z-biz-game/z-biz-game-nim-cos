// The shell: routes, the save file, the panel, the win card. This is the only file in the
// browser that touches the document, and it decides nothing about the game.
//
// Where each number on screen comes from:
//   * `outcome`, 本步是否必胜 and 剩余必胜着法数 — `bouton.js`, the closed form, O(k) over the
//     k <= 6 heaps this game allows. Nothing here ever searches, not even on a click.
//   * `par`, and its twin under the other rule — the baked row in `js/data/lots.js`, which
//     `tools/bake.mjs` measured with `js/core/retro.js` and `test/library.test.mjs` recomputes.
//   * whether a move is legal and how the machine answers — `js/core/game.js`, the very same
//     object the node tests drive.
//
// Two-tap rule (it is what makes "take from one heap only" unambiguous under a thumb):
// tap a heap to lift it, then tap the *strip* whose label is the number of stones you want
// left there. A tap on another heap while one is lifted is dropped rather than turned into a
// move, and the empty strip above the top stone means "take nothing", which `game.js`
// refuses — so a stray pixel can never bill a ply. The playtest asserts exactly that.

import { MISERE, NORMAL, isTerminal, total } from './core/heaps.js';
import { verdict, winningMoves } from './core/bouton.js';
import { rationale } from './core/ai.js';
import { createGame, grade, play, reset, setRule, status, undo } from './core/game.js';
import { ALL, BANDS, byId, dailyLot, levelAt, lotsIn } from './core/library.js';
import { store } from './core/storage.js';
import { todayKey } from './core/rng.js';
import { createSim } from './anim.js';
import { createSound } from './sound.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  board: $('board'), hintline: $('hintline'), totals: $('totals'), crumbs: $('crumbs'),
  readout: $('readout'), log: $('log'), shelf: $('shelf'), curtain: $('curtain'),
  stars: $('stars'), verdict: $('verdict'), tally: $('tally'), again: $('again'),
  next: $('next'), undo: $('undo'), restart: $('restart'), share: $('share'), wipe: $('wipe'),
  rules: $('rules'), toast: $('toast'), modes: $('modes'),
  help: $('hud-help'), pause: $('hud-pause'), sound: $('hud-sound'), full: $('hud-full'),
  veil: $('pausedveil'), resume: $('resume'), howto: $('howto'),
};

const RULE_LABEL = { [NORMAL]: '取最后一枚者胜', [MISERE]: '取最后一枚者负' };
const OUTCOME_LABEL = { N: 'N（先手必胜）', P: 'P（先手必败）' };

const session = {
  route: { kind: 'home' },
  lot: null,
  game: null,
  selected: -1,
  log: [],
  scored: false,
  dailyKey: todayKey(),
  toastTimer: 0,
  nextId: null,
  // playing / paused：暂停就是仿真的累加器不再吃时间，不是把画面盖住。
  phase: 'playing',
  muted: false,
  reduceMotion: false,
  fullscreen: false,
  helpOpen: false,
};
const errors = [];

// 音频与仿真在 view 之前：view 每一帧要读它们的时钟与粒子，而它们的开关要看存档里的设置。
const prefersReduce = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
session.muted = !!store.settings.muted;
session.reduceMotion = !!(prefersReduce && prefersReduce.matches);

const sim = createSim({ seed: 'nim-anim', reduceMotion: session.reduceMotion });
const sound = createSound(() => session.muted);

function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#/, '');
  const parts = raw.split('/').filter((p) => p !== '');
  if (!parts.length) return { kind: 'home' };
  if (parts[0] === 'daily') return { kind: 'daily' };
  if (parts[0] === 'lot' && parts[1]) return { kind: 'lot', id: decodeURIComponent(parts[1]) };
  return { kind: 'unknown', hash: `#/${parts.join('/')}` };
}

function say(msg) {
  el.toast.hidden = false;
  el.toast.textContent = msg;
  clearTimeout(session.toastTimer);
  session.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2800);
}

// Where a bare `#/` lands: the first lot the save has not unlocked past.
function pointer() {
  return Math.min(Math.max(store.unlocked || 1, 1), ALL.length) - 1;
}

function openLot(lot) {
  session.lot = lot;
  session.game = createGame(lot, lot.rule);
  session.selected = -1;
  session.scored = false;
  session.log = [];
  session.phase = 'playing';
  session.nextId = null;
  sim.reset();
}

function resolveRoute() {
  const route = parseRoute(location.hash);
  if (route.kind === 'unknown') {
    say(`没有这个地址：${route.hash}`);
    return { kind: 'home' };
  }
  if (route.kind === 'lot') {
    const lot = byId(route.id);
    if (!lot) {
      // A shared link that names nothing must not quietly become a random level.
      say(`没有 ${route.id} 这一关，回到战役`);
      return { kind: 'home' };
    }
    return route;
  }
  return route;
}

function lotFor(route) {
  if (route.kind === 'lot') return byId(route.id);
  if (route.kind === 'daily') return dailyLot(session.dailyKey);
  return levelAt(pointer());
}

function applyRoute() {
  const route = resolveRoute();
  session.route = route;
  if (route.kind === 'unknown') route.kind = 'home';
  openLot(lotFor(route));
  if (route.kind !== 'lot') {
    const hash = route.kind === 'daily' ? '#/daily' : `#/lot/${session.lot.id}`;
    if (location.hash !== hash) {
      history.replaceState(null, '', hash);
      // replaceState does not fire hashchange, so the highlight is fixed by hand.
    }
  }
  draw();
}

// ---------------------------------------------------------------- panel

function hintText() {
  const g = session.game;
  if (g.done) {
    return grade(g).key === 'lost'
      ? '<b>对手收走了最后一枚</b>。它一次也没有走出 P 位，所以你交出去的那一步就是这局的界线。'
      : `这局在 <b>${g.plies}</b> 步结束；量出来的最优局长是 <b>${g.scores[g.rule].par}</b> 步。`;
  }
  if (isTerminal(g.heaps)) return '棋盘空了。';
  const v = verdict(g.heaps, g.rule);
  if (session.selected < 0) {
    return v.winning
      ? `<b>本步必胜</b>：只有 <b>${v.winMoves}</b> 条着法能赢，绿框就是它们。其余每一手都把这局交回给对手。`
      : '<b>本步没有必胜着法</b>：这是 P 位，怎么都输。先让对手替你解开来。';
  }
  const size = g.heaps[session.selected];
  return `第 <b>${session.selected + 1}</b> 堆有 ${size} 枚：点一条虚线框，把这堆剩成框上的数。跨堆点击不算棋，取 0 枚也不算。`;
}

function readoutRows() {
  const g = session.game;
  const s = status(g);
  const baked = g.scores[g.rule];
  const sim2 = sim.summary();
  return [
    ['规则', RULE_LABEL[g.rule]],
    ['开局判定', `${OUTCOME_LABEL[baked.outcome]} · 烘焙量得`],
    ['本步是否必胜', s.winning ? '是' : (s.outcome === 'P' ? '否 · P 位' : '否')],
    ['剩余必胜着法数', String(s.winMoves)],
    ['已走 / par', `${g.plies} / ${baked.par}`],
    ['石子 / 堆', `${s.stones} / ${s.heaps}`],
    // 时长来自定步长仿真的虚拟秒：暂停期间它必须一动不动，这是"暂停为真"的读数。
    ['本局时长', `${sim2.clock.toFixed(1)} 秒 · ${session.phase === 'paused' ? '已暂停' : '进行中'}`],
    ['动画步 / 石屑', `${sim2.steps} 步 · ${sim2.particles} 粒`],
    ['局面', g.done ? (g.winner === 'you' ? '你胜' : '对手胜') : '轮到你'],
  ];
}

function renderReadout() {
  el.readout.innerHTML = readoutRows().map(([k, v]) => {
    let cls = '';
    if (k === '本步是否必胜') cls = v.charAt(0) === '是' ? 'yes' : 'no';
    else if (k === '剩余必胜着法数') cls = v === '0' ? 'no' : 'yes';
    else if (k === '局面') cls = v === '你胜' ? 'yes' : v === '对手胜' ? 'no' : '';
    return `<dt>${k}</dt><dd class="${cls}">${v}</dd>`;
  }).join('');
  const lot = session.lot;
  el.crumbs.innerHTML = session.route.kind === 'daily'
    ? `每日一题 · <b>${session.dailyKey}</b> · 全平台同一堆石子 · ${lot.id}`
    : `第 <b>${lot.index + 1}</b>/${ALL.length} 关 · <b>${lot.id}</b> · ${bandLabel(lot.band)}`;
}

function bandLabel(key) {
  const b = BANDS.find((x) => x.key === key);
  return b ? `${b.label} · ${b.blurb}` : key;
}

function renderLog() {
  el.log.innerHTML = session.log.slice(-9).map((l) => `<li class="${l.side}">${l.text}</li>`).join('');
}

function renderTotals() {
  const st = store.stats;
  const recs = Object.values(store.records);
  const won = recs.filter((r) => r && r.won).length;
  const perfect = recs.filter((r) => r && r.perfect).length;
  el.totals.innerHTML = `通关 <b>${won}</b>/${ALL.length} · 完美 <b>${perfect}</b> · 已玩 ${st.plays} 局 · ${st.plies} 步`;
  const bad = store.droppedBadRecords();
  if (bad > 0) el.totals.innerHTML += ` · <b>丢弃坏记录 ${bad} 条</b>`;
  const want = session.route.kind === 'daily' ? 'daily' : 'home';
  for (const a of el.modes.querySelectorAll('a')) a.classList.toggle('on', a.dataset.route === want);
}

function renderShelf() {
  const unlocked = store.unlocked;
  el.shelf.innerHTML = BANDS.map((b) => {
    const cells = lotsIn(b.key).map((lot) => {
      const pos = ALL.indexOf(lot) + 1;
      const rec = store.record(lot.id);
      if (pos > unlocked) return `<span class="locked" title="第 ${pos} 关还没打开">${String(pos).padStart(2, '0')}</span>`;
      const cls = [lot.id === session.lot.id ? 'here' : '', rec && rec.won ? 'won' : ''].filter(Boolean).join(' ');
      const mark = rec && rec.perfect ? '★' : rec && rec.won ? '✓' : '';
      const tip = `第 ${pos} 关 · ${lot.heaps.join('+')} · par ${lot.par}${rec && rec.best ? ` · 最佳 ${rec.best}` : ''}`;
      return `<a href="#/lot/${lot.id}" class="${cls}" title="${tip}">${String(pos).padStart(2, '0')}${mark}</a>`;
    });
    return `<h3>${b.label} · ${RULE_LABEL[b.rule]} · par ${b.parMin}-${b.parMax}</h3><div class="lots">${cells.join('')}</div>`;
  }).join('') + '<p>点数字进关，灰的是还没打开的。</p>';
}

function renderCurtain() {
  const g = session.game;
  if (!g.done) {
    el.curtain.hidden = true;
    return;
  }
  const gr = grade(g);
  // Not `g.index + 1`: `index` is the band index, so from deep-08 that would name nerve-01
  // (a band's first lot) rather than the next board on the shelf.
  const next = levelAt(ALL.findIndex((l) => l.id === g.id) + 1);
  session.nextId = next.id;
  el.curtain.hidden = false;
  el.stars.textContent = '★'.repeat(gr.stars) + '☆'.repeat(Math.max(0, 3 - gr.stars));
  el.verdict.textContent = gr.label;
  el.verdict.style.color = gr.key === 'lost' ? 'var(--lose)' : 'var(--win)';
  el.tally.innerHTML = `${g.heaps.join(' · ') || '空'} ｜ ${RULE_LABEL[g.rule]} ｜ par ${g.scores[g.rule].par} ｜ 用了 ${g.plies} 步 ｜ ${g.id}`;
  el.next.textContent = next.id === g.id ? '再来一次' : '下一关';
}

function syncButtons() {
  const g = session.game;
  el.undo.disabled = !g.history.length;
  el.restart.disabled = !g;
  for (const btn of el.rules.querySelectorAll('button')) {
    btn.classList.toggle('on', btn.dataset.rule === g.rule);
    // par is baked per rule: switching after the last stone would move the goalposts.
    btn.disabled = g.done;
  }
}

let dirty = true;

function draw() {
  const g = session.game;
  if (!g) return;
  const v = verdict(g.heaps, g.rule);
  const paused = session.phase === 'paused';
  view.render({
    heaps: g.heaps,
    rule: g.rule,
    selected: session.selected,
    last: g.history.length ? g.history[g.history.length - 1] : null,
    done: g.done,
    paused,
    showStrips: !g.done && session.selected < 0 && v.winning,
  });
  dirty = false;
  el.hintline.innerHTML = hintText();
  renderReadout();
  renderLog();
  renderTotals();
  renderShelf();
  renderCurtain();
  syncButtons();
  syncHud();
}

// HUD 的按钮态是"读出来的"，不是"点下去时顺手写的"：任何一条改状态的路径（键盘、按钮、
// 存档恢复）之后都走这里，屏幕就不会和 session 分家。
function syncHud() {
  const paused = session.phase === 'paused';
  el.veil.hidden = !paused;
  el.pause.setAttribute('aria-pressed', String(paused));
  el.pause.textContent = paused ? '继续' : '暂停';
  el.sound.setAttribute('aria-pressed', String(session.muted));
  el.sound.textContent = session.muted ? '已静音' : '静音';
  el.full.setAttribute('aria-pressed', String(session.fullscreen));
  el.full.textContent = session.fullscreen ? '退出全屏' : '全屏';
  el.help.setAttribute('aria-expanded', String(session.helpOpen));
  el.howto.hidden = !session.helpOpen;
}

// ---------------------------------------------------------------- moves

function logMove(entry, kind) {
  const who = entry.side === 'you' ? '你' : '对手';
  session.log.push({
    side: entry.side,
    text: `${who}：第 ${entry.i + 1} 堆 ${entry.was}→${entry.to}（取走 ${entry.was - entry.to} 枚）`
      + (entry.side === 'ai' ? ` · ${rationale(kind)}` : ''),
  });
}

function settleRecord() {
  const g = session.game;
  if (!g.done || session.scored) return;
  session.scored = true;
  const won = g.winner === 'you';
  store.finish(g.id, { won, plies: g.plies, par: g.scores[g.rule].par });
  if (won) {
    // `index` on a lot is its *band* index, which is not what the shelf locks against: the
    // shelf walks ALL, so unlocking has to count campaign positions or clearing knife-12
    // would "unlock" the third lot of the pool.
    const position = ALL.findIndex((l) => l.id === g.id);
    const opened = Math.min(ALL.length, position + 2);
    if (opened > store.unlocked) store.unlock(opened);
  }
  if (session.route.kind === 'daily') store.markDaily(session.dailyKey, g.id);
  sound.chord(won ? 'win' : 'lose', 0.12);
}

function goNext() {
  if (session.nextId) location.hash = `#/lot/${session.nextId}`;
}

// One tap from the view. `hitAt` is `{ i, to }`, or null for a tap off every column.
function takeTap(hitAt) {
  const g = session.game;
  // 暂停的遮罩挡住了手指，但挡不住 window.nim.tap 这类程序化入口：守卫必须写在唯一那条
  // 下棋通道上，否则幕布上「棋盘上的石子一颗没动」只是一句愿望。
  if (session.phase === 'paused') {
    say('已暂停：按 Space 或 P 继续');
    sound.blip('refuse');
    return;
  }
  if (g.done) {
    say('这一局已经结束了：按「重开」或「下一关」');
    sound.blip('refuse');
    return;
  }
  if (!hitAt) {
    session.selected = -1;
    draw();
    return;
  }
  if (session.selected < 0) {
    if (!g.heaps[hitAt.i]) {
      say('那一堆是空的');
      sound.blip('refuse');
      return;
    }
    session.selected = hitAt.i;
    sound.blip('lift');
    draw();
    return;
  }
  if (hitAt.i !== session.selected) {
    // Deliberately inert. "One heap per move" is a rule of the game, so the shell refuses to
    // turn a cross-heap tap into anything at all: no ply, no reply, no history entry.
    say('一次只能动一堆：先点棋盘空白处放下抬起的那堆');
    sound.blip('refuse');
    return;
  }
  const move = { i: session.selected, to: hitAt.to };
  const was = g.heaps[move.i];
  const r = play(g, move);
  if (!r.ok) {
    say(r.reason);
    session.selected = -1;
    sound.blip('refuse');
    draw();
    return;
  }
  // 石屑画在"这一手之前"的列几何上，所以必须在 draw() 重排版面之前炸出去。
  view.burst(r.you.i, was, r.you.to, 'stone');
  sound.blip('take');
  if (r.ai) {
    view.burst(r.ai.i, r.ai.was, r.ai.to, 'lose');
    sound.blip('reply', 0.09);
  }
  session.selected = -1;
  logMove(r.you);
  if (r.ai) logMove(r.ai, r.kind);
  settleRecord();
  draw();
}

function liftOnly(i) {
  session.selected = i;
  draw();
}

// ---------------------------------------------------------------- wiring

const view = createView(el.board, { tap: (hitAt) => takeTap(hitAt), sim });

el.undo.addEventListener('click', () => {
  if (!undo(session.game)) {
    say('还没有可回退的一步');
    sound.blip('refuse');
    return;
  }
  session.selected = -1;
  session.log.push({ side: 'you', text: '回退一手（连同对手的回应一起收回）' });
  sound.blip('lift');
  draw();
});

// 重开 = 把这一关发回起点：模型、抬起态、日志、记分标记，以及**动画层的全部缓存**
// （粒子、累加器、虚拟秒、步数、种子流）。少清一样，第二局就带着第一局的余烬跑。
function restartNow() {
  reset(session.game);
  session.selected = -1;
  session.scored = false;
  session.log = [];
  session.phase = 'playing';
  sim.reset();
  sound.blip('pick');
  dirty = true;
  draw();
}

el.restart.addEventListener('click', restartNow);
el.again.addEventListener('click', restartNow);
el.next.addEventListener('click', goNext);

for (const btn of el.rules.querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    if (session.game.done) return;
    setRule(session.game, btn.dataset.rule);
    session.selected = -1;
    session.log.push({ side: 'you', text: `换规则：${RULE_LABEL[session.game.rule]}（石子一颗没动）` });
    draw();
  });
}

el.share.addEventListener('click', async () => {
  const lot = session.lot;
  const link = `${location.origin}${location.pathname}#/lot/${lot.id}`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(`尼姆堆 ${lot.id}：${lot.heaps.join('+')} · ${RULE_LABEL[session.game.rule]} · par ${lot.par}\n${link}`);
      say(`已复制链接 ${link}`);
      return;
    }
  } catch (err) {
    /* a refused clipboard falls through to showing the link */
  }
  say(link);
});

el.wipe.addEventListener('click', () => {
  store.reset();
  session.muted = false;
  sound.setMuted(false);
  applyRoute();
  say('存档已清空，回到第 1 关');
});

// ---------------------------------------------------------------- 辅助能力
// 每个开关都同时做三件事：改 session、把事实交给真正会停/会停不下来的那一层（仿真、音频、
// 全屏 API），再从 session 回读一次按钮态。屏幕上的标签永远是被读出来的，不是被写上去的。

// 上一帧的时间戳与读数刷新用的拍子。`lastTime = 0` 是"下一帧重新起算"的哨兵：暂停、
// 重开都置零，于是恢复的那一帧不会把暂停的几秒补进累加器。
let lastTime = 0;
let uiBeat = 0;

function togglePause(force) {
  // force 有值时它就是目标态（true=暂停，false=继续），省略才是"翻一下"。
  // 写成 `force === false` 会把两者都反过来：「继续」按钮再按一次暂停，
  // window.nim.setPaused(true) 反而把仿真放行 —— 尺子读到的暂停态因此是假的。
  const next = force === undefined ? (session.phase !== 'paused') : !!force;
  session.phase = next ? 'paused' : 'playing';
  sim.setPaused(session.phase === 'paused');
  if (session.phase === 'paused') {
    // 暂停期间音频时钟也停住：不然"暂停"只是画面不动，声音还在排期。
    sound.suspend();
  } else {
    lastTime = 0;            // 不再让累加器一帧补上暂停那几秒
    sound.resume();
  }
  sound.blip('pause');
  syncHud();
}

function toggleMute(force) {
  session.muted = force === undefined ? !session.muted : !!force;
  sound.setMuted(session.muted);
  store.setSetting('muted', session.muted);
  if (!session.muted) sound.blip('pick');
  syncHud();
  say(session.muted ? '已静音：一个振荡器也不会再建' : '声音已开回');
}

function toggleHelp(force) {
  session.helpOpen = force === undefined ? !session.helpOpen : !!force;
  if (session.helpOpen && !store.settings.seenTutorial) store.setSetting('seenTutorial', true);
  syncHud();
}

// 全屏走标准名，退而求其次退 webkit 前缀（iOS Safari 到 16.4 才给网页这个 API）；
// 两个都没有就如实说，不假装成功。
function toggleFullscreen() {
  const doc = document;
  const node = doc.documentElement;
  if (doc.fullscreenElement || doc.webkitFullscreenElement) {
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(doc)).catch(() => say('退出全屏被拦下了'));
    return;
  }
  const req = node.requestFullscreen || node.webkitRequestFullscreen;
  if (!req) { say('这台浏览器不开放网页全屏'); return; }
  Promise.resolve(req.call(node)).catch(() => say('全屏被系统拦下了'));
}

function readFullscreen() {
  session.fullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
  syncHud();
}

el.pause.addEventListener('click', () => togglePause());
el.resume.addEventListener('click', () => togglePause(false));
el.sound.addEventListener('click', () => toggleMute());
el.full.addEventListener('click', () => toggleFullscreen());
el.help.addEventListener('click', () => toggleHelp());
document.addEventListener('fullscreenchange', readFullscreen);
document.addEventListener('webkitfullscreenchange', readFullscreen);

// reduceMotion 要有真分支，不是一句 CSS：粒子一颗不生、呼吸与脉动恒等于静图。
if (prefersReduce) {
  const onChange = (e) => {
    session.reduceMotion = !!(e && e.matches);
    sim.setReduceMotion(session.reduceMotion);
    dirty = true;
    draw();
  };
  if (typeof prefersReduce.addEventListener === 'function') {
    prefersReduce.addEventListener('change', onChange);
  } else if (typeof prefersReduce.addListener === 'function') {
    prefersReduce.addListener(onChange);
  }
}

// 切到后台就把音频时钟挂起（浏览器自己也会这么做，但"看不见却在耗电"是投诉点）。
document.addEventListener('visibilitychange', () => {
  if (document.hidden) sound.suspend();
  else sound.resume();
});

window.addEventListener('hashchange', applyRoute);
window.addEventListener('resize', draw);
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  // 焦点在按钮/链接上时 Enter/Space 由浏览器自己触发那次 click，这里再动一次就是双发。
  const tag = ev.target && ev.target.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  const k = ev.key;
  if (k === 'Escape') {
    if (session.helpOpen) toggleHelp(false);
    else { session.selected = -1; draw(); }
    return;
  }
  if (k === 'h' || k === 'H' || k === '?') { toggleHelp(); return; }
  if (k === 'm' || k === 'M') { toggleMute(); return; }
  if (k === 'f' || k === 'F') { toggleFullscreen(); return; }
  if (k === 'p' || k === 'P') { togglePause(); return; }
  if (k === 'u' || k === 'U') { el.undo.click(); return; }
  if (k === 'r' || k === 'R') { restartNow(); return; }
  if (k === 'Enter') {
    // Enter = 把这局"开始"下去：结束了走再来一次/下一关，暂停了先解除，否则抬起第一堆。
    if (session.game.done) { (session.nextId ? el.next : el.again).click(); return; }
    if (session.phase === 'paused') { togglePause(false); return; }
    if (session.selected < 0) {
      const i = session.game.heaps.findIndex((n) => n > 0);
      if (i >= 0) liftOnly(i);
    }
    return;
  }
  if (k === ' ' || k === 'Spacebar') {
    if (session.game.done) { restartNow(); return; }
    togglePause();
    return;
  }
  if (session.phase === 'paused') { say('已暂停：按 Space 或 P 继续'); return; }
  const d = Number(k);
  if (!Number.isInteger(d) || d < 0 || d > 9) return;
  if (session.selected >= 0) {
    // A lifted heap plus a digit means "leave exactly this many there".
    if (d < session.game.heaps[session.selected]) takeTap({ i: session.selected, to: d });
    else say(`第 ${session.selected + 1} 堆只剩 ${session.game.heaps[session.selected]} 枚，留不了 ${d} 枚`);
    return;
  }
  if (d >= 1 && d <= session.game.heaps.length) liftOnly(d - 1);
});
window.addEventListener('error', (ev) => errors.push(String(ev.message || ev.error)));

// ---------------------------------------------------------------- 主循环
// 全仓只有这一处 requestAnimationFrame。它做且仅做四件事：算出这一帧经过了多少秒、
// 把它交给定步长累加器（暂停时它自己一颗也不走）、按需重画、按拍刷新读数。

function frame(now) {
  requestAnimationFrame(frame);
  // dt 只在"帧与帧之间"有意义，推进状态的一律是 anim.js 里的恒定步长。
  const dt = lastTime ? Math.min(0.25, (now - lastTime) / 1000) : 0;
  lastTime = now;
  sim.advance(dt);
  if (session.phase !== 'paused') uiBeat += dt;
  const moving = sim.particles.length > 0 || (session.selected >= 0 && !sim.reduceMotion);
  if (dirty || (moving && session.phase !== 'paused')) {
    view.render({ paused: session.phase === 'paused' });
    dirty = false;
  }
  if (uiBeat >= 0.2) {
    uiBeat = 0;
    renderReadout();   // 「本局时长」这一行是读出来的，不是估出来的
  }
}

applyRoute();
if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);

// 可安装：file:// 下根本没有 SW registry，整段跳过；老浏览器没有 navigator.serviceWorker
// 也跳过。注册失败（无 HTTPS、被策略拦）只影响"能不能离线"，绝不让页面抛未捕获异常。
if (location.protocol !== 'file:' && typeof navigator !== 'undefined'
  && 'serviceWorker' in navigator && typeof window !== 'undefined'
  && typeof window.addEventListener === 'function') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      /* 装不上就在线玩：这一句必须存在，否则控制台是一条未处理的 rejection */
    });
  });
}

// The playtest's door. Everything behind it is the code a real click runs: `tap` goes
// through `takeTap`, `point` reads the layout the last frame actually drew.
window.nim = {
  version: 2,
  lots: ALL,
  bands: BANDS,
  errors,
  get route() { return { ...session.route }; },
  get lot() { return session.lot; },
  get state() {
    const g = session.game;
    const v = verdict(g.heaps, g.rule);
    const s = sim.summary();
    return {
      id: g.id, band: g.band, index: g.index, rule: g.rule, heaps: g.heaps.slice(),
      start: g.start.slice(), plies: g.plies, done: g.done, winner: g.winner,
      selected: session.selected, history: g.history.map((h) => ({ ...h })),
      outcome: v.outcome, winMoves: v.winMoves, winning: v.winning,
      par: g.scores[g.rule].par, stones: total(g.heaps), terminal: isTerminal(g.heaps),
      unlocked: store.unlocked, plays: store.stats.plays, stars: grade(g) ? grade(g).stars : 0,
      // 辅助能力与动画层的读数：任何一把尺子都要能读到"暂停真的停了、静音真的停了"。
      phase: session.phase, paused: session.phase === 'paused',
      muted: session.muted, reduceMotion: session.reduceMotion,
      fullscreen: session.fullscreen, helpOpen: session.helpOpen,
      simClock: s.clock, simSteps: s.steps, simParticles: s.particles,
      simAccum: s.accum, simSpawned: s.spawned,
    };
  },
  sim: () => sim.summary(),
  sound: () => sound.stats(),
  art: () => view.artReady(),
  startLevel: (id) => {
    // 走真实那条路：hash → applyRoute → openLot，另写一套"测试专用开局"就证明不了任何东西。
    if (id) location.hash = `#/lot/${id}`;
    session.phase = 'playing';
    draw();
    return { id: session.game.id, heaps: session.game.heaps.slice(), phase: session.phase };
  },
  setPaused: (on) => { togglePause(on); return session.phase; },
  setMuted: (on) => { toggleMute(on); return session.muted; },
  setHelp: (on) => { toggleHelp(on); return session.helpOpen; },
  advance: (dt) => sim.advance(dt),
  burst: (i, from, to, kind) => view.burst(i, from, to, kind),
  status: () => status(session.game),
  grade: () => grade(session.game),
  point: (i, to) => view.point(i, to),
  layout: () => view.layout(),
  hit: (x, y) => view.hit(x, y),
  winMovesHere: (i) => winningMoves(session.game.heaps, session.game.rule)
    .filter((m) => m.i === i).map((m) => m.to),
  tap: (i, to) => { takeTap({ i, to }); return session.game.heaps.slice(); },
  lift: (i) => { takeTap({ i, to: 0 }); return session.selected; },
  clear: () => { takeTap(null); return session.selected; },
  undo: () => { el.undo.click(); return session.game.plies; },
  restart: restartNow,
  setRule: (r) => { setRule(session.game, r); draw(); return session.game.rule; },
  go: (hash) => { location.hash = hash; return session.route; },
  save: () => ({
    records: { ...store.records }, stats: { ...store.stats }, daily: { ...store.daily },
    unlocked: store.unlocked, settings: { ...store.settings },
    droppedBadRecords: store.droppedBadRecords(),
  }),
  wipe: () => { store.reset(); draw(); return Object.keys(store.records).length; },
};
