// Minimal zero-dependency CDP driver for headless playtesting (Node 21+ global
// WebSocket/fetch — no Playwright, no Puppeteer).
//
// env: CDP_PORT  devtools port, default 9353 (deliberately off the siblings' 9340/9341:
//               one machine, and two headless Chromes on one port is how a run gets
//               reported green when nothing was actually driven)
//      BASE_URL  page to attach to, default http://127.0.0.1:5193/
//
// usage:
//   node tools/playtest.mjs open  <url>            # fresh page tab, navigate, wait for shell
//   node tools/playtest.mjs nav   <url>
//   node tools/playtest.mjs eval  '<js expression>'          # plain evaluate
//   node tools/playtest.mjs eval  '@boot' [nonav]            # @boot @play @routes @save @reloaded
//   node tools/playtest.mjs tap   <i>,<to>          # one real press+release on heap i strip to
//   node tools/playtest.mjs shot  <path.png>
//   node tools/playtest.mjs logs
//
// Every scenario reports { rows, fail } in the same shape tools/harness.mjs prints, so
// verify.sh aggregates node suites and browser suites on one line.
//
// Two kinds of test live here and they are not interchangeable:
//   * @boot/@play/@routes/@save run page-side JS against `window.nim`. They prove the shell,
//     the router, the save file and the numbers on the panel.
//   * @pointer sends real `Input.dispatchMouseEvent` events through Chrome. Page JS cannot
//     prove that a finger reaches the strip it aims at, so the certified winning line is
//     walked with the mouse and nothing else.
const PORT = process.env.CDP_PORT || 9353;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5193/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 30000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One real mouse event at a client-space coordinate. The @pointer suite and the `tap`
// command share this so the two cannot disagree about what "a press" means on the wire.
const mouseAt = (cdp, sessionId, type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
}, sessionId);

// Press and release where the *view* says heap i / strip `to` currently is. `point()` reads
// the layout the last frame actually drew, so this follows the board as it shrinks.
async function clickStrip(cdp, sessionId, runJS, i, to, hold = 26, rest = 70) {
  const p = await runJS(`window.nim.point(${i}, ${to === null ? 0 : to})`);
  if (!p) return null;
  await mouseAt(cdp, sessionId, 'mousePressed', p.x, p.y, 1);
  await sleep(hold);
  await mouseAt(cdp, sessionId, 'mouseReleased', p.x, p.y, 0);
  await sleep(rest);
  return p;
}

// ---------------------------------------------------------------------------------------
// The page-side second opinion. Nothing here imports the repo: Bouton's rule and the
// winner-shortest / loser-longest game length are re-typed from the theorem statement, so a
// bug in js/core/bouton.js or js/core/retro.js cannot hide by agreeing with itself. This is
// a fixture, not a feature: it is never reachable from the game.
const CF_BODY = `function () {
  const xor = (p) => p.reduce((a, b) => a ^ b, 0);
  const big = (p) => p.filter((n) => n >= 2).length;
  const ones = (p) => p.filter((n) => n === 1).length;
  const isMis = (r) => r === 'misere';
  function out(p, rule) {
    if (isMis(rule) && big(p) === 0) return ones(p) % 2 === 1 ? 'P' : 'N';
    return xor(p) === 0 ? 'P' : 'N';
  }
  function wins(p, rule) {
    const w = [];
    if (isMis(rule)) {
      const b = big(p);
      const c = ones(p);
      // All heaps are single stones: the one who is forced to take the last one loses, so a
      // hand holding an ODD count is already lost and an EVEN count wins by shaving one off.
      if (b === 0) { for (let i = 0; i < p.length; i++) if (p[i] === 1 && c % 2 === 0) w.push({ i: i, to: 0 }); return w; }
      if (b === 1) { for (let i = 0; i < p.length; i++) if (p[i] >= 2) { w.push({ i: i, to: c % 2 === 0 ? 1 : 0 }); return w; } }
    }
    const x = xor(p);
    for (let i = 0; i < p.length; i++) { const to = p[i] ^ x; if (to < p[i]) w.push({ i: i, to: to }); }
    return w;
  }
  function moves(p) {
    const o = [];
    for (let i = 0; i < p.length; i++) for (let to = p[i] - 1; to >= 0; to--) o.push({ i: i, to: to });
    return o;
  }
  const memo = new Map();
  function deep(p, rule) {
    const key = p.join(',') + '|' + rule;
    const hit = memo.get(key);
    if (hit) return hit;
    const mv = moves(p);
    let res;
    if (!mv.length) res = { win: isMis(rule), plies: 0 };
    else {
      let best = Infinity, worst = 0, canWin = false;
      for (const m of mv) {
        const q = p.slice(); q[m.i] = m.to;
        const r = deep(q, rule);
        if (!r.win) { canWin = true; if (1 + r.plies < best) best = 1 + r.plies; }
        else if (1 + r.plies > worst) worst = 1 + r.plies;
      }
      res = canWin ? { win: true, plies: best } : { win: false, plies: worst };
    }
    memo.set(key, res);
    return res;
  }
  // The move that wins in as few plies as any winner can: the par-minimising member of the
  // closed-form winning set. This is what the pointer suite plays, which is why the run it
  // produces is comparable to the printed par rather than merely a win.
  function pick(p, rule) {
    let best = null;
    for (const m of wins(p, rule)) {
      const q = p.slice(); q[m.i] = m.to;
      const d = deep(q, rule);
      if (!d.win && (best === null || 1 + d.plies < best.plies)) best = { i: m.i, to: m.to, plies: 1 + d.plies };
    }
    return best;
  }
  function firstLoser(p, rule) {
    const w = wins(p, rule);
    for (const m of moves(p)) {
      let good = false;
      for (const k of w) if (k.i === m.i && k.to === m.to) good = true;
      if (!good) return m;
    }
    return null;
  }
  // rng.js's two-round UTF-16 mixer, re-typed: an FNV-1a *derived* pair of rounds per code
  // unit (low byte, multiply, high byte, multiply). Not textbook FNV-1a, and deliberately
  // no public test vector is asserted anywhere with it.
  function hs(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i) & 0xff;
      h = Math.imul(h, 0x01000193);
      h ^= (str.charCodeAt(i) >> 8) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }
  return { xor: xor, big: big, ones: ones, out: out, wins: wins, deep: deep, pick: pick, firstLoser: firstLoser, hs: hs, states: () => memo.size };
}`;
// ---------------------------------------------------------------------------------------

async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* gone already */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // Wait on the shell, not on a timer. This page is a module graph fetched over the network:
  // a fixed sleep is long enough for localhost and too short for GitHub Pages, where it hands
  // back an undefined `window.nim` and a canvas still sitting at the spec's 300x150 default —
  // a fake failure on a perfectly good deployment.
  const waitShell = async (floorMs, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.nim && window.nim.state && window.nim.state.id)');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'tap') {
    // One heap/strip pair, pressed and released for real, against the page already open.
    // Same primitive @pointer uses, so a human reviewing a screenshot can produce it too.
    const [i, to] = String(arg || '').split(',').map(Number);
    if (!Number.isInteger(i) || i < 0 || !Number.isInteger(to) || to < 0) {
      console.log('tap wants "<heap>,<strip>", got: ' + arg);
      process.exit(1);
    }
    const p = await clickStrip(cdp, sessionId, runJS, i, to);
    if (!p) { console.log('EVAL THROW: no heap ' + i + ' on screen'); process.exit(1); }
    const now = await runJS('JSON.stringify(window.nim.state.heaps) + " plies=" + window.nim.state.plies + " sel=" + window.nim.state.selected');
    console.log(`tapped heap ${i + 1} strip ${to} at ${p.x},${p.y} -> ${now}`);
  } else if (cmd === 'eval') {
    if (process.argv[4] !== 'nonav') {
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      await waitShell(300);
    }
    if (arg && arg.startsWith('@')) {
      const name = arg.slice(1);
      let value = null;
      if (name === 'pointer') {
        value = await pointerScenario(cdp, sessionId, runJS);
      } else if (SCENARIOS[name]) {
        // Clear the row buffer *before* running: every scenario with `nonav` evaluates in the
        // same page, so a suite that dies at parse time would otherwise hand back the previous
        // suite's rows and verify.sh would print them as if they belonged to this one.
        await runJS('window.__lastRows = null; 1');
        try {
          value = await runJS(SCENARIOS[name]);
        } catch (err) {
          const dumped = await runJS('JSON.stringify(window.__lastRows||[])').catch(() => '[]');
          value = { rows: JSON.parse(dumped) };
          value.rows.push({ test: `@${name} threw`, pass: false, detail: String(err.message).slice(0, 300) });
        }
      } else {
        console.log('unknown scenario ' + name + ' — have ' + Object.keys(SCENARIOS).join(', ') + ', pointer');
        process.exit(1);
      }
      value.fail = (value.rows || []).filter((r) => !r.pass).map((r) => r.test);
      console.log(JSON.stringify(value, null, 2));
    } else {
      try {
        console.log(JSON.stringify(await runJS(arg), null, 2));
      } catch (err) {
        console.log('EVAL THROW: ' + err.message);
      }
    }
    if (logs.length) console.log('--- console ---\n' + logs.join('\n'));
  } else if (cmd === 'shot') {
    await runJS('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    (await import('node:fs')).writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg + ' (' + Math.round(data.length / 1024) + 'kB b64)');
  } else if (cmd === 'logs') {
    await sleep(800);
    console.log(logs.join('\n') || '(none)');
  }
  ws.close();
  process.exit(0);
}

// --------------------------------------------------------------------------- @pointer
// Real input, start to finish. Every row below is caused by a mouse event Chrome generated,
// never by a call into `window.nim`, so what is under test is the pointer-to-strip wiring in
// js/view.js and the refusals in js/core/game.js as a thumb actually meets them.
async function pointerScenario(cdp, sessionId, runJS) {
  const rows = [];
  const rec = (name, pass, detail) => rows.push({
    test: name, pass: !!pass,
    detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)),
  });
  const mouse = (type, x, y, buttons) => mouseAt(cdp, sessionId, type, x, y, buttons);
  const key = (k) => cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', text: k, key: k, code: 'Key' + k.toUpperCase(), windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0),
  }, sessionId);
  const strip = (i, to) => clickStrip(cdp, sessionId, runJS, i, to);
  const st = () => runJS(`(() => { const g = window.nim; return { id: g.state.id, heaps: g.state.heaps, plies: g.state.plies, sel: g.state.selected, done: g.state.done, winner: g.state.winner, par: g.state.par, winMoves: g.state.winMoves, outcome: g.state.outcome, rule: g.state.rule, hist: g.state.history.length, said: document.getElementById('toast').textContent, hint: document.getElementById('hintline').textContent }; })()`);

  const ids = await runJS(`['board','hintline','totals','crumbs','readout','log','shelf','curtain','stars','verdict','tally','again','next','undo','restart','share','wipe','rules','toast','modes']
    .map((i) => [i, !!document.getElementById(i)])`);
  rec('every control the shell reaches for exists', ids.every(([, on]) => on), Object.fromEntries(ids));

  await runJS('window.__cf = (' + CF_BODY + ')(); 1');
  await runJS(`(() => { location.hash = '#/lot/spark-01'; return 1; })()`);
  await sleep(300);
  const open = await st();
  rec('a shared link opens its lot with a certified par', open.id === 'spark-01' && open.par === 5 && open.plies === 0, open);
  const painted = await runJS(`(() => { const c = document.getElementById('board'); const x = c.getContext('2d'); const d = x.getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 3] > 0) lit++; return lit; })()`);
  rec('the board is painted with stones, not an empty frame', painted > 200, { litPixels: painted });
  const off = await runJS(`(() => { const c = document.getElementById('board'); const r = c.getBoundingClientRect(); const p = window.nim.point(0, 0); return { inBox: p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom, x: p.x, y: p.y, box: [r.left, r.top, r.width, r.height] }; })()`);
  rec('the point the view offers a click is inside the canvas box', off.inBox, off);

  // A strip that takes nothing: the empty strip above the top stone is a real pixel target,
  // the two-tap protocol accepts it as the ask, and the game must refuse it. Nothing is
  // billed, no reply, no history — the same refusal node/core/game.js gives in test/.
  const size0 = open.heaps[0];
  await strip(0, 0);
  const armed = await st();
  rec('the first click lifts heap 1 without billing it', armed.sel === 0 && armed.plies === 0 && armed.hist === 0, armed);
  await strip(0, size0);
  const greedy = await st();
  rec('the top strip is a real click, and taking no stones is not a move',
    greedy.plies === 0 && greedy.hist === 0 && greedy.done === false && greedy.heaps.join(',') === open.heaps.join(','), greedy);
  rec('and it says so instead of going quiet', greedy.said.indexOf('至少取走一枚') >= 0, greedy.said);

  // Cross-heap reach: lift heap 1, then point at heap 2. One heap per move is a rule of the
  // game, so the second click must not become a move on either heap.
  await strip(0, 0);
  const lifted = await st();
  rec('a click on a heap lifts it', lifted.sel === 0 && lifted.plies === 0, lifted);
  await strip(1, 0);
  const crossed = await st();
  rec('reaching across to another heap is refused: no ply, no reply, no history',
    crossed.plies === 0 && crossed.hist === 0 && crossed.heaps.join(',') === open.heaps.join(','), crossed);
  rec('and the lifted heap is still the lifted heap', crossed.sel === 0, { sel: crossed.sel });
  rec('the shell names the rule it refused', crossed.said.indexOf('一次只能动一堆') >= 0, crossed.said);

  // A click on bare board puts the heap back down without billing anything.
  const blank = await runJS(`(() => {
    const c = document.getElementById('board'); const r = c.getBoundingClientRect(); const L = window.nim.layout();
    const cands = [[r.left + 2, r.top + 2], [r.right - 2, r.top + 2], [r.left + 2, r.bottom - 2], [r.right - 2, r.bottom - 2]];
    for (let i = 0; i + 1 < L.length; i++) {
      cands.push([Math.round(L[i].x + L[i].w + (L[i + 1].x - L[i].x - L[i].w) / 2 + r.left), Math.round(r.top + r.height / 2)]);
    }
    for (const [x, y] of cands) {
      if (x < 1 || y < 1 || x > innerWidth - 1 || y > innerHeight - 1) continue;
      if (window.nim.hit(x, y) === null) return { x, y };
    }
    return null;
  })()`);
  if (!blank) {
    rec('a click on bare board is ignored', false, 'no reachable point off every column');
  } else {
    await mouse('mousePressed', blank.x, blank.y, 1);
    await sleep(26);
    await mouse('mouseReleased', blank.x, blank.y, 0);
    await sleep(90);
    const dropped = await st();
    rec('a click on bare board drops the heap and bills nothing',
      dropped.sel === -1 && dropped.plies === 0 && dropped.heaps.join(',') === open.heaps.join(','), { blank, dropped });
  }

  // The certified line, clicked for real. `__cf.pick` is the theorem re-typed in this file,
  // so the sequence is the par-minimising win rather than a lucky one.
  await runJS('window.nim.restart(); 1');
  await sleep(120);
  let moves = 0;
  const trail = [];
  for (let guard = 0; guard < 40; guard++) {
    const now = await st();
    if (now.done) break;
    const ask = await runJS(`(() => { const g = window.nim; const m = window.__cf.pick(g.state.heaps, g.state.rule); return m ? { i: m.i, to: m.to } : null; })()`);
    if (!ask) { rec('the theorem has a winning move left', false, now); break; }
    const before = now.plies;
    await strip(ask.i, 0);
    const sel = await st();
    if (sel.sel !== ask.i) { rec(`click ${moves + 1} lifts heap ${ask.i + 1}`, false, sel); break; }
    await strip(ask.i, ask.to);
    const after = await st();
    moves++;
    trail.push({ heap: ask.i + 1, to: ask.to, plies: after.plies, heaps: after.heaps.join(',') });
    if (after.plies <= before) { rec(`click ${moves} on heap ${ask.i + 1} was billed`, false, after); break; }
  }
  const end = await st();
  rec('real clicks play a whole winning line', end.done === true && end.winner === 'you', { moves, trail, end });
  rec('and it lands on the measured par, not past it', end.plies === end.par && end.par === 5, { plies: end.plies, par: end.par });
  const card = await runJS(`(() => ({
    hidden: document.getElementById('curtain').hidden,
    stars: document.getElementById('stars').textContent,
    verdict: document.getElementById('verdict').textContent,
    tally: document.getElementById('tally').textContent,
    next: document.getElementById('next').textContent,
  }))()`);
  rec('the win card goes up with three stars', card.hidden === false && card.stars === '★★★' && card.verdict.indexOf('不多一手') >= 0, card);
  rec('the card prints the measured par next to what the run cost', card.tally.indexOf('par 5') >= 0 && card.tally.indexOf('用了 5 步') >= 0, card.tally);
  const nextBox = await runJS(`(() => { const r = document.getElementById('next').getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  rec('on the win card 下一关 has a real hit box a thumb can reach', nextBox.w > 24 && nextBox.y > 0 && nextBox.y < 820, nextBox);
  await mouse('mousePressed', nextBox.x, nextBox.y, 1);
  await sleep(26);
  await mouse('mouseReleased', nextBox.x, nextBox.y, 0);
  await sleep(350);
  const advanced = await st();
  rec('a real click on 下一关 deals the next lot in the baked order', advanced.id === 'spark-02' && advanced.plies === 0, advanced);

  // The machine's reply is theorem-driven, so after any click of ours that is not a winning
  // one the position must come back as a loss for us. Checked with the mouse on a second lot.
  await runJS(`(() => { location.hash = '#/lot/spark-04'; return 1; })()`);
  await sleep(300);
  const open4 = await st();
  const blunder = await runJS(`(() => { const g = window.nim; return window.__cf.firstLoser(g.state.heaps, g.state.rule); })()`);
  await strip(blunder.i, 0);
  await strip(blunder.i, blunder.to);
  const gave = await st();
  rec('one non-winning click and the position comes back lost',
    gave.outcome === 'P' && gave.winMoves === 0 && gave.plies === 2 && gave.id === 'spark-04', { blunder, open4, gave });
  rec('the hint line tells the player the truth about that', gave.hint.indexOf('没有必胜着法') >= 0, gave.hint);

  // Keyboard is input too: digits lift and commit, u undoes a whole round.
  await runJS('window.nim.restart(); 1');
  await sleep(200);
  const fresh = await st();
  await key('1');
  await sleep(120);
  const lifted1 = await st();
  rec('the 1 key lifts the first heap', lifted1.sel === 0 && lifted1.plies === 0, lifted1);
  await key('0');
  await sleep(200);
  const committed = await st();
  rec('a digit then commits the lifted heap to that many stones',
    committed.plies === 2 && committed.heaps[0] === 0 && committed.heaps.join(',') !== fresh.heaps.join(','), committed);
  await key('u');
  await sleep(200);
  const undone = await st();
  rec('the u key takes the whole round back', undone.plies === 0 && undone.heaps.join(',') === fresh.heaps.join(','), undone);

  // An emptied heap is not playable and must not be liftable once it is.
  const emptied = await runJS(`(() => {
    const g = window.nim; const h = g.state.heaps;
    let i = 0; for (let j = 1; j < h.length; j++) if (h[j] < h[i]) i = j;
    g.lift(i); g.tap(i, 0);
    return { i, heaps: g.state.heaps.join(',') };
  })()`);
  await sleep(120);
  const before = await st();
  const lifted2 = await runJS(`window.nim.lift(${emptied.i})`);
  const after = await st();
  rec('a heap the game has emptied cannot be lifted',
    lifted2 === -1 && after.plies === before.plies && after.heaps[emptied.i] === 0, { emptied, lifted2, after });
  rec('and the shell says which one it was', after.said.indexOf('空') >= 0, after.said);

  rec('nothing threw on the page while the mouse was moving', (await runJS('window.nim.errors.length')) === 0, await runJS('window.nim.errors'));
  return { rows };
}

// --------------------------------------------------------------------------- in-page suites
const REC = `const rows = [];
    const rec = (name, pass, detail) => rows.push({ test: name, pass: !!pass, detail: detail === undefined ? null : JSON.parse(JSON.stringify(detail ?? null)) });
    window.__lastRows = rows;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const D = (id) => document.getElementById(id);
    const has = (s, w) => String(s).indexOf(w) >= 0;
    const isDate = (s) => s.length === 10 && +s.slice(0, 4) > 2000 && s[4] === '-' && s[7] === '-';
    const cf = (${CF_BODY})();`;

const SCENARIOS = {
  boot: `(async () => {
    ${REC}
    const g = window.nim;
    const c = document.getElementById('board');
    const box = c.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    const s = g.state;

    rec('the shell boots straight into a game', g.version === 1 && !!s.id && !!s.par, s);
    rec('the URL it settled on is a shareable lot link', location.hash === '#/lot/' + s.id, { hash: location.hash, id: s.id });
    rec('the canvas has real pixels', c.width > 0 && c.height > 0 && !!c.getContext('2d'), { w: c.width, h: c.height });
    // A canvas whose stylesheet never arrived is still the 300x150 box the HTML spec hands
    // out; the game would then draw stones into a strip nobody designed. This is the same
    // check the screenshot catches by eye, inside the gate.
    rec('the canvas is laid out, not the unstyled 300x150 default',
      box.width > 300 && box.height >= 180 && Math.abs(c.width - box.width * dpr) <= dpr + 1 && Math.abs(c.height - box.height * dpr) <= dpr + 1,
      { css: [Math.round(box.width), Math.round(box.height)], backing: [c.width, c.height], dpr });
    const lit = await (async () => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 120 && d[i + 3] > 0) n++;
      return n;
    })();
    rec('stones were actually drawn', lit > 200, { litPixels: lit });

    const readout = D('readout').textContent;
    rec('the panel prints the three numbers the repo claims', has(readout, '开局判定') && has(readout, '本步是否必胜') && has(readout, '剩余必胜着法数') && has(readout, '已走'), readout);
    const row = g.lots.filter((r) => r.id === s.id)[0];
    rec('the printed par is the baked one for the rule being played', s.par === row.scores[s.rule].par, { shown: s.par, baked: row.scores[s.rule].par, rule: s.rule });
    rec('and the heap on screen is the heap that row measured', s.heaps.join(',') === row.heaps.join(','), { screen: s.heaps, row: row.heaps });

    const myOut = cf.out(s.heaps, s.rule);
    const myWin = cf.wins(s.heaps, s.rule).length;
    rec('a re-typed Bouton agrees with the panel on this device', myOut === s.outcome && myWin === s.winMoves, { mine: [myOut, myWin], panel: [s.outcome, s.winMoves] });
    rec('the xor of a P-position is exactly zero', s.outcome === 'P' ? cf.xor(s.heaps) === 0 : cf.xor(s.heaps) !== 0 || s.rule === 'misere', { heaps: s.heaps, outcome: s.outcome });
    rec('with a big heap left, normal-play winMoves is odd', (s.rule !== 'normal' || cf.big(s.heaps) === 0) || s.winMoves % 2 === 1, { winMoves: s.winMoves, heaps: s.heaps });

    // The repo's whole claim, recomputed in the browser over the shipped pool: the closed
    // form for the verdict and the move count, a plain minimax for the length.
    const bad = [];
    for (const r of g.lots) {
      for (const rule of ['normal', 'misere']) {
        const sc = r.scores[rule];
        const d = cf.deep(r.heaps, rule);
        if (d.win !== (sc.outcome === 'N')) bad.push(r.id + '/' + rule + ' outcome');
        if (d.plies !== sc.par) bad.push(r.id + '/' + rule + ' par ' + sc.par + '!=' + d.plies);
        if (cf.wins(r.heaps, rule).length !== sc.winMoves) bad.push(r.id + '/' + rule + ' winMoves');
      }
      if (r.outcome !== 'N') bad.push(r.id + ' shipped a position the first player loses');
    }
    rec('every shipped row survives a third opinion in the browser', bad.length === 0, { rows: g.lots.length, mismatches: bad.slice(0, 8), statesWalked: cf.states() });
    const inverted = g.lots.filter((r) => r.scores.normal.outcome !== r.scores.misere.outcome);
    rec('the two win conventions genuinely disagree somewhere in the pool', inverted.length > 0 && inverted.every((r) => r.scores.normal.outcome === 'P'), inverted.map((r) => r.id + ':' + r.heaps.join('+')));

    const shelf = D('shelf').textContent;
    const cells = document.querySelectorAll("#shelf a[href^='#/lot/']").length;
    const locked = document.querySelectorAll('#shelf span.locked').length;
    rec('the shelf lists the whole pool and locks what is not open', cells + locked === g.lots.length && locked === g.lots.length - s.unlocked, { cells, locked, lots: g.lots.length, unlocked: s.unlocked });
    rec('the header tally renders on boot', has(D('totals').textContent, '通关'), D('totals').textContent);
    rec('the crumbs name the band and the lot', has(D('crumbs').textContent, s.id), D('crumbs').textContent);
    rec('the rule toggle shows which convention is live', D('rule-' + s.rule).classList.contains('on'), { rule: s.rule });
    const L = g.layout();
    rec('the view lays out one column per heap, left to right', L.length === s.heaps.length && L.every((col, i) => col.size === s.heaps[i] && (i === 0 || col.x > L[i - 1].x)), L);
    rec('every heap has a clickable point inside the board', (() => {
      const r = c.getBoundingClientRect();
      for (let i = 0; i < s.heaps.length; i++) {
        const p = g.point(i, 0);
        if (!p || p.x < r.left || p.x > r.right || p.y < r.top || p.y > r.bottom) return false;
      }
      return true;
    })(), g.layout().map((col) => g.point(col.i, 0)));
    rec('nothing threw while the pool loaded', g.errors.length === 0, g.errors);
    return { rows };
  })()`,

  play: `(async () => {
    ${REC}
    const g = window.nim;
    g.wipe();
    g.go('#/lot/spark-01'); await sleep(200);
    g.restart();
    const start = g.state;
    const par = start.par;
    rec('a lot opens at its baked opening position', start.id === 'spark-01' && start.heaps.join(',') === '2,2,2' && par === 5, start);

    // The two refusals the game has to make, driven through the shell's own tap path.
    g.tap(0, start.heaps[0]);
    const same = g.tap(0, start.heaps[0]);
    rec('asking to take nothing is refused and bills nothing', g.state.plies === 0 && g.state.history.length === 0 && typeof same !== 'undefined', { same, plies: g.state.plies });
    rec('and the shell says why instead of silently redrawing', has(D('toast').textContent, '至少取走一枚'), D('toast').textContent);
    g.clear();
    g.lift(0);
    const cross = g.tap(1, 0);
    rec('reaching across to a second heap is refused', g.state.selected === 0 && g.state.plies === 0, { cross, selected: g.state.selected });
    rec('the refusal names the one-heap rule', has(D('toast').textContent, '一次只能动一堆'), D('toast').textContent);
    g.clear();
    rec('a click on bare board puts the heap down', g.state.selected === -1, g.state.selected);
    rec('every refusal left the pile count alone', g.state.heaps.join(',') === '2,2,2' && g.state.plies === 0, g.state);

    // One real round: you take, the perfect player answers.
    const mv = cf.pick(g.state.heaps, g.state.rule);
    g.lift(mv.i);
    const before = g.state.plies;
    g.tap(mv.i, mv.to); await sleep(60);
    const round = g.state;
    rec('a legal move costs one ply for you and one for the machine', round.plies === before + 2, { before, plies: round.plies });
    rec('the move you made handed the machine a P-position', (() => {
      const after = round.history[0];
      const q = start.heaps.slice(); q[after.i] = after.to;
      return cf.out(q, round.rule) === 'P';
    })(), { you: round.history[0], from: start.heaps });
    const reply = round.history[1];
    rec('the machine had no winning move there, so it stalled by one stone', reply.side === 'ai' && reply.was - reply.to === 1, reply);
    rec('and it took the largest heap, which is the deterministic stall', (() => {
      const q = start.heaps.slice(); q[round.history[0].i] = round.history[0].to;
      let i = 0;
      for (let j = 1; j < q.length; j++) if (q[j] > q[i]) i = j;
      return reply.i === i;
    })(), { reply, heapsBeforeReply: start.heaps });
    rec('a stall out of a P-position necessarily leaves you a win', round.outcome === 'N' && round.winMoves > 0, { outcome: round.outcome, winMoves: round.winMoves });
    rec('the history logged both sides of the round', round.history.length === 2 && round.history[0].side === 'you' && round.history[1].side === 'ai', round.history);
    rec('the log line counts match the plies', document.querySelectorAll('#log li').length >= 2, document.querySelectorAll('#log li').length);
    const st = g.status();
    rec('status() re-reads the same verdict the panel prints', st.outcome === round.outcome && st.winMoves === round.winMoves, st);
    rec('the hint line prints the same win count the closed form gives', has(D('hintline').textContent, '本步必胜') && has(D('hintline').textContent, String(round.winMoves) + ' 条'), D('hintline').textContent);

    g.undo(); await sleep(60);
    rec('undo rewinds the whole round, never into the machine turn', g.state.plies === 0 && g.state.heaps.join(',') === '2,2,2' && g.state.selected === -1, g.state);
    rec('the button disables itself when there is nothing to undo', D('undo').disabled === true, D('undo').disabled);

    g.setRule('misere');
    rec('switching the rule leaves every stone where it was', g.state.heaps.join(',') === '2,2,2' && g.state.plies === 0, g.state);
    rec('and takes the printed par from the other measured column', g.state.par === 4 && g.state.par !== par, { misere: g.state.par, normal: par });
    g.setRule('normal');
    rec('switching back restores the baked number', g.state.par === 5, g.state.par);

    // The certified line, played through the shell (the mouse version is @pointer).
    g.restart(); await sleep(60);
    let guard = 0;
    for (;;) {
      if (g.state.done || guard++ > 40) break;
      const m = cf.pick(g.state.heaps, g.state.rule);
      if (!m) break;
      g.lift(m.i);
      g.tap(m.i, m.to);
      await sleep(30);
    }
    const won = g.state;
    rec('the perfect line wins the lot', won.done === true && won.winner === 'you', won);
    rec('and it finishes on the measured par exactly', won.plies === won.par && won.par === 5, { plies: won.plies, par: won.par });
    rec('grade calls that three stars, which is a measured claim', g.grade().stars === 3 && g.grade().key === 'perfect', g.grade());
    rec('the card is up and the controls froze', D('curtain').hidden === false && D('rule-normal').disabled === true, { curtain: D('curtain').hidden, ruleFrozen: D('rule-normal').disabled });
    rec('a finished game refuses further moves', (() => { g.lift(0); const p = g.state.plies; return p === won.plies && has(D('toast').textContent, '已经结束了'); })(), D('toast').textContent);
    rec('再来一次 deals the same lot again', (() => { D('again').click(); return g.state.heaps.join(',') === '2,2,2' && g.state.plies === 0 && D('curtain').hidden; })(), g.state);

    // A blunder, and what it costs.
    const bad = cf.firstLoser(g.state.heaps, g.state.rule);
    g.lift(bad.i); g.tap(bad.i, bad.to); await sleep(40);
    rec('one losing move and the position is a P-position for you', g.state.outcome === 'P' && g.state.winMoves === 0, { bad, outcome: g.state.outcome });
    rec('the hint line admits a P-position is lost', has(D('hintline').textContent, '没有必胜着法'), D('hintline').textContent);
    let guard2 = 0;
    for (;;) {
      if (g.state.done || guard2++ > 60) break;
      const m = cf.pick(g.state.heaps, g.state.rule) || { i: g.state.heaps.findIndex((n) => n > 0), to: Math.max(0, g.state.heaps[g.state.heaps.findIndex((n) => n > 0)] - 1) };
      g.lift(m.i); g.tap(m.i, m.to); await sleep(20);
    }
    rec('a lost game is still a legal game: it ends, and the card says who won', g.state.done && g.state.winner === 'ai', g.state);
    rec('and the loss is graded as a loss', g.grade().stars === 0 && g.grade().key === 'lost', g.grade());
    rec('nothing threw on the way', g.errors.length === 0, g.errors);
    return { rows };
  })()`,

  routes: `(async () => {
    ${REC}
    const g = window.nim;
    g.wipe();
    g.go('#/lot/deep-01'); await sleep(200);
    rec('#/lot/deep-01 opens that lot with its measured par', g.state.id === 'deep-01' && g.state.par === 23 && g.route.kind === 'lot', { state: g.state.id, par: g.state.par, route: g.route });
    rec('and the board is the four heaps that row was measured on', g.state.heaps.join(',') === '2,5,8,9', g.state.heaps);
    rec('a four-heap lot gets four columns, each with a point a click can reach', (() => {
      const cols = g.layout();
      const r = document.getElementById('board').getBoundingClientRect();
      return cols.length === 4 && cols.every((c, i) => c.size === g.state.heaps[i]) && [0, 1, 2, 3].every((i) => {
        const p = g.point(i, 0);
        return !!p && p.x > r.left && p.x < r.right && p.y > r.top && p.y < r.bottom;
      });
    })(), g.layout());
    g.go('#/lot/no-such-lot'); await sleep(200);
    rec('an unknown id is refused rather than turned into a random level', g.route.kind === 'home' && has(D('toast').textContent, '没有'), { route: g.route, toast: D('toast').textContent });
    rec('the board still dealt something playable', !!g.state.id && g.state.outcome === 'N', g.state);
    g.go('#/nonsense'); await sleep(200);
    rec('an unparseable route falls back to the campaign', g.route.kind === 'home' && has(D('toast').textContent, '没有这个地址'), { route: g.route, toast: D('toast').textContent });

    g.go('#/daily'); await sleep(200);
    const daily = g.state.id;
    rec('#/daily is a route, not a random pick', g.route.kind === 'daily' && !!daily, { route: g.route, id: daily });
    g.go('#/lot/spark-01'); await sleep(150);
    g.go('#/daily'); await sleep(200);
    rec('the daily route is the same puzzle twice', g.state.id === daily && g.route.kind === 'daily', { first: daily, again: g.state.id });
    const crumbs = D('crumbs').textContent;
    rec('the daily crumbs carry a date', has(crumbs, '每日一题') && isDate(g.state.id ? crumbs.slice(crumbs.indexOf('20'), crumbs.indexOf('20') + 10) : ''), crumbs);
    const dayKey = (() => { const c = crumbs; const i = c.indexOf('20'); return i >= 0 ? c.slice(i, i + 10) : ''; })();
    rec('and the same date recomputes the same lot from the seed alone', (() => {
      const idx = cf.hs('daily|' + dayKey) % g.lots.length;
      return g.lots[idx].id === daily;
    })(), { dayKey, daily, recomputed: g.lots[cf.hs('daily|' + dayKey) % g.lots.length].id });
    const dailyRow = g.lots.filter((r) => r.id === daily)[0];
    rec('the daily lot is a first-player win with a certified par', dailyRow.outcome === 'N' && g.state.par === dailyRow.scores[dailyRow.rule].par, { id: daily, par: g.state.par });
    rec('the nav highlights the route actually open', D('modes').querySelector('a.on').getAttribute('href') === '#/daily', D('modes').querySelector('a.on').outerHTML);

    g.go('#/lot/oddball-01'); await sleep(200);
    rec('a misère lot opens under the misère convention', g.state.rule === 'misere' && g.state.heaps.join(',') === '1,1', g.state);
    const oddRow = g.lots.filter((x) => x.id === 'oddball-01')[0];
    rec('which is why it ships at all: normal play calls the same piles lost',
      oddRow.scores.normal.outcome === 'P' && oddRow.scores.misere.outcome === 'N' && g.state.outcome === 'N', oddRow.scores);
    rec('and re-typing the theorem here says the same thing both ways',
      cf.out(oddRow.heaps, 'normal') === 'P' && cf.out(oddRow.heaps, 'misere') === 'N', oddRow.heaps);
    g.go('#/lot/twitch-01'); await sleep(200);
    rec('the twitch band really has exactly one winning move', g.state.winMoves === 1 && g.state.heaps.join(',') === '1,1,3', g.state);
    rec('the strip the view would light up is the one the theorem names', (() => {
      const mine = cf.wins(g.state.heaps, g.state.rule).filter((m) => m.i === 2).map((m) => m.to).join(',');
      return g.winMovesHere(2).join(',') === mine && mine.length > 0;
    })(), { view: g.winMovesHere(2), retyped: cf.wins(g.state.heaps, g.state.rule) });
    // The win card is hidden outright while the game is live, so its button has no box on
    // screen at all. (getComputedStyle reports the specified display for a child of a hidden
    // subtree, which is why the hit box, not the style string, is what proves a thumb cannot
    // press it.)
    rec('下一关 is not on screen until the game is over, so no mid-play tap can reach it',
      D('curtain').hidden === true && D('next').getBoundingClientRect().width === 0 && D('next').offsetParent === null,
      { curtain: D('curtain').hidden, w: D('next').getBoundingClientRect().width, offsetParent: D('next').offsetParent === null });
    g.go('#/lot/spark-02'); await sleep(200);
    const prevId = (() => {
      const i = g.lots.findIndex((r) => r.id === 'spark-02');
      return i > 0 ? g.lots[i - 1].id : '';
    })();
    rec('the campaign order is the baked one: spark-02 comes straight after spark-01',
      g.state.id === 'spark-02' && prevId === 'spark-01', { prevId, now: g.state.id });
    rec('a route change re-lays out the board', g.layout().length === g.state.heaps.length && g.layout().length === 3, { cols: g.layout().length, heaps: g.state.heaps.length });
    rec('the share link is the route that opened this lot', location.href.indexOf('#/lot/spark-02') > 0, location.href);
    const firstCell = document.querySelector("#shelf a[href^='#/lot/']");
    if (firstCell) { firstCell.click(); }
    await sleep(200);
    rec('a shelf cell is a real link and clicking it changes the lot',
      g.state.id === 'spark-01' && !!firstCell && firstCell.href.indexOf('#/lot/spark-01') > 0, { id: g.state.id, href: firstCell && firstCell.href });
    rec('locked lots are not links at all', document.querySelectorAll("#shelf a[href^='#/lot/']").length === 1, document.querySelectorAll("#shelf a[href^='#/lot/']").length);
    rec('nothing threw on any of those routes', g.errors.length === 0, g.errors);
    return { rows };
  })()`,

  save: `(async () => {
    ${REC}
    const g = window.nim;
    const KEY = 'nim.save.v1';
    g.wipe();
    g.go('#/lot/spark-01'); await sleep(200);
    rec('a wiped device starts the campaign at one', g.state.unlocked === 1 && Object.keys(g.save().records).length === 0 && localStorage.getItem(KEY) === null, g.save());
    const walk = async () => {
      g.restart();
      let guard = 0;
      for (;;) {
        if (g.state.done || guard++ > 40) break;
        const m = cf.pick(g.state.heaps, g.state.rule);
        if (!m) break;
        g.lift(m.i); g.tap(m.i, m.to); await sleep(20);
      }
      return g.state;
    };
    const won = await walk();
    rec('the solve is written through to localStorage, not only to memory', (() => {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      return !!(raw && raw.records['spark-01'] && raw.records['spark-01'].best === 5);
    })(), JSON.parse(localStorage.getItem(KEY) || 'null'));
    const rec1 = g.save().records['spark-01'];
    rec('the record is flagged perfect at the measured par', rec1.won === true && rec1.best === 5 && rec1.perfect === true && rec1.plays === 1, rec1);
    rec('clearing a lot unlocks the next one', g.save().unlocked === 2, g.save().unlocked);
    rec('the header tally counted the win', has(D('totals').textContent, '通关'), D('totals').textContent);
    rec('the shelf now marks it done', /✓|★/.test(D('shelf').textContent), D('shelf').textContent.slice(0, 200));

    // A sloppier second run: best only moves down, and a perfect flag never comes off.
    const finishAny = async () => {
      let guard = 0;
      for (;;) {
        if (g.state.done || guard++ > 60) break;
        const m = cf.pick(g.state.heaps, g.state.rule)
          || cf.firstLoser(g.state.heaps, g.state.rule)
          || { i: g.state.heaps.findIndex((n) => n > 0), to: 0 };
        g.lift(m.i); g.tap(m.i, m.to); await sleep(15);
      }
      return g.state;
    };
    g.restart(); await sleep(40);
    const mv = cf.firstLoser(g.state.heaps, g.state.rule);
    g.lift(mv.i); g.tap(mv.i, mv.to); await sleep(30);
    const sloppy = await finishAny();
    const rec2 = g.save().records['spark-01'];
    rec('a second run takes plays up but leaves the best time alone',
      rec2.plays === 2 && rec2.best === 5 && rec2.perfect === true && sloppy.done === true, { rec2, plies: sloppy.plies, winner: sloppy.winner });
    const lossWalk = async () => {
      g.go('#/lot/spark-02'); await sleep(150);
      g.restart();
      let guard = 0;
      for (;;) {
        if (g.state.done || guard++ > 60) break;
        const m = cf.firstLoser(g.state.heaps, g.state.rule);
        const q = m || { i: g.state.heaps.findIndex((n) => n > 0), to: 0 };
        g.lift(q.i); g.tap(q.i, q.to); await sleep(12);
      }
      return g.state;
    };
    const lost = await lossWalk();
    rec('a loss is recorded as a loss and invents no best time', lost.winner === 'ai' && g.save().records['spark-02'] && !g.save().records['spark-02'].best && g.save().records['spark-02'].won === false, g.save().records['spark-02']);
    rec('and it does not unlock anything', g.save().unlocked === 2, g.save().unlocked);

    g.go('#/daily'); await sleep(150);
    const dailyId = g.state.id;
    await walk();
    const dayKey = (() => { const c = D('crumbs').textContent; const i = c.indexOf('20'); return i >= 0 ? c.slice(i, i + 10) : ''; })();
    rec('today is logged once the daily is solved', !!g.save().daily[dayKey] && g.save().daily[dayKey].id === dailyId, { dayKey, daily: g.save().daily });
    rec('stats add up across the session', (() => { const s = g.save().stats; return s.plays >= 4 && s.wins >= 2 && s.losses >= 1 && s.plies > 0; })(), g.save().stats);
    D('wipe').click(); await sleep(150);
    rec('清空存档 clears the disk as well as the memory', Object.keys(g.save().records).length === 0 && localStorage.getItem(KEY) === null && g.save().unlocked === 1, g.save());
    rec('and the shell survives it: a board is still dealt', !!g.state.id && g.state.heaps.length >= 2 && D('curtain').hidden === true, g.state);
    // Leave one solved game on disk for @reloaded, which runs in its own driver process and
    // is the only suite that can tell a warm module cache from a save that really landed.
    g.go('#/daily'); await sleep(150);
    await walk();
    rec('after the wipe a new solve is written again', (() => {
      const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
      return !!raw && Object.keys(raw.records).length === 1 && raw.records[g.state.id].won === true;
    })(), JSON.parse(localStorage.getItem(KEY) || 'null'));
    rec('nothing threw while writing and wiping', g.errors.length === 0, g.errors);
    return { rows };
  })()`,

  // Run after @save in its own driver process, so `eval` without `nonav` has really
  // reloaded the page: this is the only suite that can tell a warm module cache from a save
  // that actually reached disk.
  reloaded: `(async () => {
    ${REC}
    const g = window.nim;
    const KEY = 'nim.save.v1';
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    rec('a fresh page reads its progress off disk', !!raw && Object.keys(raw.records).length >= 1, raw && Object.keys(raw.records));
    const id = raw ? Object.keys(raw.records)[0] : '';
    const one = raw ? raw.records[id] : null;
    rec('the record came back with its measured best, not a re-guess', !!one && one.won === true && one.best === one.par && one.perfect === true, { id, one });
    rec('the unlocked pointer came back and matches what the shell holds', g.state.unlocked === raw.unlocked && raw.unlocked >= 2, { memory: g.state.unlocked, disk: raw && raw.unlocked });
    rec('the stats survived the reload', g.save().stats.plays === raw.stats.plays && g.save().stats.plays >= 1, g.save().stats);
    rec('the shelf renders the recovered solve as done', (() => {
      const cell = document.querySelector("#shelf a[href='#/lot/" + id + "']");
      return !!cell && (cell.textContent.indexOf('★') >= 0 || cell.textContent.indexOf('✓') >= 0);
    })(), document.getElementById('shelf').textContent.slice(0, 160));
    rec('the header prints the recovered tally', has(D('totals').textContent, '通关'), D('totals').textContent);
    rec('the daily slot is remembered across the reload', Object.keys(g.save().daily).length >= 1, g.save().daily);
    rec('and the lot it names is the lot the seed still picks today', (() => {
      const day = Object.keys(g.save().daily)[0];
      const idx = cf.hs('daily|' + day) % g.lots.length;
      return !!day && g.lots[idx].id === g.save().daily[day].id;
    })(), g.save().daily);
    g.wipe();
    rec('a reset leaves nothing on disk for the next visitor', localStorage.getItem(KEY) === null, localStorage.getItem(KEY));
    return { rows };
  })()`,
};

main().catch((err) => {
  console.error('playtest failed: ' + ((err && err.stack) || err));
  process.exit(1);
});
