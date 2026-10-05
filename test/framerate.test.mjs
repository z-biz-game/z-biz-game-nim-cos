// 关卡内三档对拍（简报 §3）：30/60/120 Hz 跑同一局、同一支事件日程，比 sim 状态。
//
// 这一支不重实现仿真，只当"尺子的裁判"：真正的推进在 tools/frame_axis.mjs 里（浏览器桩 +
// 虚拟时钟 + 整拍对齐）。这里负责三件事：
//   1. 基线必须绿 —— 游戏状态字段（手数/石子/堆/history/clock）三档逐位全等，粒子字段只允许
//      一阶采样滞后（比值 ≤3.0，简报的判尺线）；
//   2. 暂停必须真冻 —— pause 与 resume 落在同一个 sim 步号上，且暂停期间的程序化下棋被守卫拒掉；
//   3. 三发阴性对照必须红 —— 摘掉暂停守卫 / 把累加钉成常量 / 每帧概率爆炸。任何一发量不动，
//      前面的绿就只是"尺子失效"。（简报 §6）
//
// 变异只打在 os.tmpdir() 的副本上（frame_axis 自己做），产品仓一个字不动。

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, ok, eq, run } from '../tools/harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(HERE, '..', 'tools', 'frame_axis.mjs');
const RATES = ['30', '60', '120'];
const MODES = ['step', 'wall'];
const STATE_FIELDS = ['plies', 'stones', 'heaps', 'history', 'spawn', 'clock'];
const VISUAL_FIELDS = ['sx', 'sy', 'sl', 'n'];

function axisRun(args) {
  const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out.trim().split('\n').filter((l) => l.startsWith('{')).pop());
}
const BASE = axisRun([]);
const freezeOf = (mode, fps) => BASE.modes[mode].freeze[fps].map((x) => (Array.isArray(x) ? x[0] : x));

test('对拍基座自证：没打变异、随机数钉死、共同步号够多', () => {
  eq(BASE.mut, 'none');
  eq(BASE.mutated, []);
  eq(BASE.rng, 'seeded-lcg');       // 随机数没钉住，"逐位全等"就是掷骰子
  for (const mode of MODES) {
    const ck = Object.values(BASE.modes[mode].spread)[0].checkpoints;
    ok(ck >= 20, `${mode} 轴只有 ${ck} 个共同步号，比对没有统计意义`);
  }
});

test('轴二（同步号）：游戏状态三档逐位全等，且三档都跑满 360 步', () => {
  const s = BASE.modes.step.spread;
  for (const k of STATE_FIELDS) eq(s[k].worst, 0, `step 轴 ${k} 三档不一致`);
  eq(BASE.modes.step.endSteps, { 30: 360, 60: 360, 120: 360 });
});

test('轴二：粒子字段只有一阶采样滞后（三档差 / 单步自身变化 ≤3.0）', () => {
  for (const k of VISUAL_FIELDS) {
    const { worst, gap, ratio } = BASE.modes.step.spread[k];
    ok(gap > 0, `${k} 的"单步自身变化量"没量到，判尺失效`);
    ok(ratio !== 'inf' && ratio <= 3.0, `${k} 三档差 ${worst} / 单步变化 ${gap} = ${ratio}，超出帧率无关的容忍`);
  }
});

test('轴一（同墙钟）：3 秒喂进去的步数只差一阶，落点状态一致', () => {
  const steps = Object.values(BASE.modes.wall.endSteps);
  ok(Math.max(...steps) - Math.min(...steps) <= 2,
    `同 3 秒墙钟下步数差 ${steps.join('/')}（>2 就是帧率依赖）`);
  for (const k of STATE_FIELDS) eq(BASE.modes.wall.spread[k].worst, 0, `wall 轴 ${k} 三档不一致`);
  for (const k of VISUAL_FIELDS) {
    const r = BASE.modes.wall.spread[k].ratio;
    ok(r !== 'inf' && r <= 3.0, `wall 轴 ${k} 比值 ${r} 超线`);
  }
});

test('暂停真冻：pause 与 resume 同一步号，1 秒墙钟里 sim 一步没走', () => {
  for (const mode of MODES) {
    for (const fps of RATES) {
      const list = freezeOf(mode, fps);
      const pause = list.find((l) => l.startsWith('pause@'));
      const resume = list.find((l) => l.startsWith('resume@'));
      ok(pause && resume, `${mode}/${fps} 没成对记录 pause/resume：${JSON.stringify(list)}`);
      eq(pause.split('@')[1], resume.split('@')[1], `${mode}/${fps} 暂停期间 sim 走了步：${pause} → ${resume}`);
      eq(BASE.modes[mode].pausedFrames[fps], Number(fps), `${mode}/${fps} 暂停 1 秒该是 ${fps} 帧`);
    }
  }
});

test('暂停守卫：程序化 lift/tap 在 phase=paused 下一颗石子都不动', () => {
  for (const mode of MODES) {
    for (const fps of RATES) {
      const probes = freezeOf(mode, fps).filter((l) => l.startsWith('probe:'));
      eq(probes.length, 2, `${mode}/${fps} 探针没落在暂停窗口里`);
      for (const p of probes) {
        ok(p.includes('phase=paused'), `${mode}/${fps} 探针发在暂停之外：${p}`);
        const [, before, after] = p.match(/plies=(\d+)→(\d+)/);
        eq(before, after, `${mode}/${fps} 暂停期间手数被改动：${p}`);
      }
    }
  }
});

test('阴性对照·守卫：摘掉暂停守卫，暂停期间那一次 tap 必须真下出一手', () => {
  const m = axisRun(['--mut=pause-guard']);
  eq(m.mutated.length, 1, '变异没打上，这一条等于没测');
  const probe = m.modes.step.freeze['60'].map((x) => (Array.isArray(x) ? x[0] : x)).find((l) => l.startsWith('probe:move'));
  ok(probe, '变异跑里没有暂停探针记录');
  const [, before, after] = probe.match(/plies=(\d+)→(\d+)/);
  ok(before !== after, `守卫摘掉后暂停期间手数仍不动（${probe}）—— 上面那条绿并没有真的在测守卫`);
});

test('阴性对照一：把 accum += dt 钉死成 1/60，墙钟轴必须红', () => {
  const m = axisRun(['--mut=accum-const']);
  eq(m.mutated.length, 1, '变异没打上，这一条等于没测');
  const steps = Object.values(m.modes.wall.endSteps);
  ok(Math.max(...steps) - Math.min(...steps) > 20,
    `钉死 dt 后三档仍然同步（${steps.join('/')}）—— 尺子量不到帧率依赖，上面的绿不算数`);
});

test('阴性对照二：往渲染里塞每帧概率爆炸，同步号轴必须红', () => {
  const m = axisRun(['--mut=frame-bernoulli']);
  eq(m.mutated.length, 1, '变异没打上，这一条等于没测');
  const s = m.modes.step.spread.spawn;
  ok(s.worst > 0 && (s.ratio === 'inf' || s.ratio > 3.0),
    `每帧概率的爆炸在三档对拍下没露馅（worst=${s.worst} ratio=${s.ratio}）`);
  ok(JSON.stringify(m.modes.step.endSpawn) !== JSON.stringify(BASE.modes.step.endSpawn),
    '变异跑的落点爆炸数与基线相同，说明变异没生效');
});

run();
