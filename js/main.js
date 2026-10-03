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
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {
  board: $('board'), hintline: $('hintline'), totals: $('totals'), crumbs: $('crumbs'),
  readout: $('readout'), log: $('log'), shelf: $('shelf'), curtain: $('curtain'),
  stars: $('stars'), verdict: $('verdict'), tally: $('tally'), again: $('again'),
  next: $('next'), undo: $('undo'), restart: $('restart'), share: $('share'), wipe: $('wipe'),
  rules: $('rules'), toast: $('toast'), modes: $('modes'),
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
};
const errors = [];

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
  return [
    ['规则', RULE_LABEL[g.rule]],
    ['开局判定', `${OUTCOME_LABEL[baked.outcome]} · 烘焙量得`],
    ['本步是否必胜', s.winning ? '是' : (s.outcome === 'P' ? '否 · P 位' : '否')],
    ['剩余必胜着法数', String(s.winMoves)],
    ['已走 / par', `${g.plies} / ${baked.par}`],
    ['石子 / 堆', `${s.stones} / ${s.heaps}`],
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

function draw() {
  const g = session.game;
  if (!g) return;
  const v = verdict(g.heaps, g.rule);
  view.render({
    heaps: g.heaps,
    rule: g.rule,
    selected: session.selected,
    last: g.history.length ? g.history[g.history.length - 1] : null,
    done: g.done,
    showStrips: !g.done && session.selected < 0 && v.winning,
  });
  el.hintline.innerHTML = hintText();
  renderReadout();
  renderLog();
  renderTotals();
  renderShelf();
  renderCurtain();
  syncButtons();
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
}

function goNext() {
  if (session.nextId) location.hash = `#/lot/${session.nextId}`;
}

// One tap from the view. `hitAt` is `{ i, to }`, or null for a tap off every column.
function takeTap(hitAt) {
  const g = session.game;
  if (g.done) {
    say('这一局已经结束了：按「重开」或「下一关」');
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
      return;
    }
    session.selected = hitAt.i;
    draw();
    return;
  }
  if (hitAt.i !== session.selected) {
    // Deliberately inert. "One heap per move" is a rule of the game, so the shell refuses to
    // turn a cross-heap tap into anything at all: no ply, no reply, no history entry.
    say('一次只能动一堆：先点棋盘空白处放下抬起的那堆');
    return;
  }
  const move = { i: session.selected, to: hitAt.to };
  const r = play(g, move);
  if (!r.ok) {
    say(r.reason);
    session.selected = -1;
    draw();
    return;
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

const view = createView(el.board, { tap: (hitAt) => takeTap(hitAt) });

el.undo.addEventListener('click', () => {
  if (!undo(session.game)) {
    say('还没有可回退的一步');
    return;
  }
  session.selected = -1;
  session.log.push({ side: 'you', text: '回退一手（连同对手的回应一起收回）' });
  draw();
});

function restartNow() {
  reset(session.game);
  session.selected = -1;
  session.scored = false;
  session.log = [];
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
  applyRoute();
  say('存档已清空，回到第 1 关');
});

window.addEventListener('hashchange', applyRoute);
window.addEventListener('resize', draw);
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  if (ev.key === 'Escape') { session.selected = -1; draw(); return; }
  if (ev.key === 'u' || ev.key === 'U') { el.undo.click(); return; }
  if (ev.key === 'r' || ev.key === 'R') { restartNow(); return; }
  const d = Number(ev.key);
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

applyRoute();

// The playtest's door. Everything behind it is the code a real click runs: `tap` goes
// through `takeTap`, `point` reads the layout the last frame actually drew.
window.nim = {
  version: 1,
  lots: ALL,
  bands: BANDS,
  errors,
  get route() { return { ...session.route }; },
  get lot() { return session.lot; },
  get state() {
    const g = session.game;
    const v = verdict(g.heaps, g.rule);
    return {
      id: g.id, band: g.band, index: g.index, rule: g.rule, heaps: g.heaps.slice(),
      start: g.start.slice(), plies: g.plies, done: g.done, winner: g.winner,
      selected: session.selected, history: g.history.map((h) => ({ ...h })),
      outcome: v.outcome, winMoves: v.winMoves, winning: v.winning,
      par: g.scores[g.rule].par, stones: total(g.heaps), terminal: isTerminal(g.heaps),
      unlocked: store.unlocked, plays: store.stats.plays, stars: grade(g) ? grade(g).stars : 0,
    };
  },
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
  save: () => ({ records: { ...store.records }, stats: { ...store.stats }, daily: { ...store.daily }, unlocked: store.unlocked }),
  wipe: () => { store.reset(); draw(); return Object.keys(store.records).length; },
};

// ---- 全屏开关（#btn-fullscreen）----
// 绑的是本页 HUD 上真实存在的那个按钮。全屏最常见的假实现就是引用一个并不存在的
// id：点下去什么也不会发生，量具却算它"已实现"。所以这里找不到按钮就直接不装。
(function bindFullscreen() {
  const btn = document.getElementById('btn-fullscreen');
  if (!btn) return;
  const root = document.documentElement;
  // 只做特性检测，不嗅探 UA：iOS Safari 是 webkitRequestFullscreen，老 Edge 是 ms 前缀，
  // 而 UA 字符串随时会改。"有没有这个能力"是查出来的，不是猜出来的。
  const req = root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
  const current = () => document.fullscreenElement || document.webkitFullscreenElement
    || document.msFullscreenElement || null;

  // 不支持也要给个说法：只把按钮灰掉而不解释，玩家会以为这功能没做完。
  const unsupported = () => {
    btn.disabled = true;
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」独立打开）';
  };
  if (!req) unsupported();

  // fullscreen 返回 Promise，被拒时必须吃掉：iOS Safari 对多数非 video 元素直接拒绝，
  // 让这个 rejection 冒泡出去会变成一条未捕获错误，整局游戏跟着挂。
  const settle = (p) => { if (p && p.catch) p.catch(unsupported); };

  // 进出都能走：已经全屏时这次调用是退出，不是"再进一次"。
  function toggle() {
    try {
      if (current()) {
        if (exit) settle(exit.call(document));
      } else if (req) {
        settle(req.call(root));
      } else {
        unsupported();
      }
    } catch (e) {
      unsupported();
    }
  }

  // Esc 和系统手势退出都不经过我们的代码，按钮状态只能靠 fullscreenchange 回写，
  // 否则用户已经退出、HUD 还停在"退出全屏"，下一次点击反而会重新进全屏。
  function sync() {
    const on = !!current();
    btn.setAttribute('aria-pressed', String(on));
    btn.textContent = on ? "退出全屏" : "全屏";
    btn.title = "全屏" + '（F）';
    const body = document.body;
    if (body && body.classList) body.classList.toggle('fullscreen', on);
  }

  btn.addEventListener('click', toggle);
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'f' && ev.key !== 'F') return;
    const t = ev.target;
    // 盘号 / 种子这类输入框里打字不能触发全屏，否则玩家输 seed 输到一半屏幕没了。
    if (t && /input|textarea|select/i.test(t.tagName || '')) return;
    if (ev.repeat || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault();
    toggle();
  });
  window.addEventListener('fullscreenchange', sync);
  window.addEventListener('webkitfullscreenchange', sync);
  window.addEventListener('MSFullscreenChange', sync);
  sync();
})();
