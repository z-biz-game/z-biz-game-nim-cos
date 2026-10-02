// 动画仿真：一颗定步长累加器，把"看得见的动"和"帧来了几次"解耦。
//
// 为什么要它：上一版整块屏是"点一下重画一张静图"，手感全绑在点击那一瞬间；而一旦加上
// 石屑、抬起的呼吸、必胜框的脉动，就把 `x += v`、`v *= 0.96` 这类只在 60Hz 成立的写法
// 请了回来。这里的规定是：
//   * 每一帧只做一件事 —— 把经过的时间塞进累加器 `accum += elapsed`；
//   * 真正推进状态的是**恒定步长** SIM_STEP = 1/120 的整数次循环，步内所有位移/阻尼/寿命
//     都以 s(=SIM_STEP) 为单位，因此 30Hz 与 120Hz 喂进同样的虚拟时长会跑出同样的末态；
//   * 随机数只走 js/core/rng.js 的种子流（浏览器侧不许碰未播种的全局随机数，
//     test/library.test.mjs 逐文件盯着），抽样的**次数**由事件决定而不是由帧数决定，
//     否则帧率翻倍就等于粒子翻倍。
// 暂停 = `advance()` 直接返回 0 且**不把这段时间累加进去**，累加器停在原地，恢复后接着走。

import { rngFrom } from './core/rng.js';

export const SIM_STEP = 1 / 120;
const GRAVITY = 620;          // px/s²，石屑往下坠
const DAMP = 0.14;            // 每秒保留的速度比例（下面用 Math.pow 换成任意步长）
const MAX_PARTICLES = 260;

export function createSim(opts = {}) {
  const seed = opts.seed || 0x5eed1e;
  let rand = rngFrom(seed);
  let accum = 0;
  let steps = 0;
  let clock = 0;          // 虚拟秒：所有正弦/脉动的唯一时间源
  let spawned = 0;
  let reduced = !!opts.reduceMotion;
  let paused = false;
  const particles = [];

  function step(s) {
    clock += s;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.vy += GRAVITY * s;
      const keep = Math.pow(DAMP, s);   // 阻尼写成"每秒比例"，步长变了也等价
      p.vx *= keep;
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.life -= s;
      if (p.life <= 0) {
        particles[i] = particles[particles.length - 1];
        particles.pop();
      }
    }
    steps++;
  }

  // 一帧只许调用一次：elapsed 是那帧经过的虚拟秒。
  function advance(elapsed) {
    // 暂停不是"停下来看一眼"，是这段时间根本不存在：不累加、不补帧、不动 clock。
    if (paused) return 0;
    const dt = Number.isFinite(elapsed) && elapsed > 0 ? Math.min(elapsed, 0.25) : 0;
    accum += dt;
    let ran = 0;
    // 上限拦住"标签页回来一次补 30 秒"的悬崖：追帧只追到 MAX_CATCHUP 步，其余丢掉。
    const MAX_CATCHUP = 8 * 4;   // 8 倍 SIM_STEP×4 = 0.266s，与上面的 dt 钳同量级
    while (accum >= SIM_STEP && ran < MAX_CATCHUP) {
      step(SIM_STEP);
      accum -= SIM_STEP;
      ran++;
    }
    if (accum > SIM_STEP * MAX_CATCHUP) accum = 0;
    return ran;
  }

  function spawn(x, y, kind, count, spread) {
    if (reduced || count <= 0) return 0;
    let added = 0;
    for (let i = 0; i < count; i++) {
      if (particles.length >= MAX_PARTICLES) break;
      const a = rand() * Math.PI * 2;
      const v = spread * (0.35 + rand() * 0.65);
      const ttl = 0.34 + rand() * 0.5;
      particles.push({
        x: x + (rand() - 0.5) * 6, y: y + (rand() - 0.5) * 4,
        vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60 * rand(),
        life: ttl, ttl, size: 0.5 + rand() * 0.9, kind,
      });
      added++;
      spawned++;
    }
    return added;
  }

  // 抬起那一列的呼吸：只由 clock 决定，任何帧率读到的同一个时刻都是同一个值。
  function breath() {
    if (reduced) return 0;
    return Math.sin(clock * Math.PI * 2 * 0.8) * 0.5 + 0.5;
  }

  function pulse() {
    if (reduced) return 1;
    return 0.5 + 0.5 * Math.sin(clock * Math.PI * 2 * 0.55);
  }

  function summary() {
    let sx = 0;
    let sy = 0;
    let sl = 0;
    for (const p of particles) { sx += p.x; sy += p.y; sl += p.life; }
    return { steps, clock, accum, particles: particles.length, spawned, reduced, paused,
      sx: Math.round(sx * 1000) / 1000, sy: Math.round(sy * 1000) / 1000,
      sl: Math.round(sl * 1000) / 1000 };
  }

  return {
    SIM_STEP,
    advance,
    spawn,
    breath,
    pulse,
    summary,
    stats: () => summary(),
    reset() {
      particles.length = 0;
      accum = 0;
      steps = 0;
      clock = 0;
      spawned = 0;
      paused = false;
      rand = rngFrom(seed);
    },
    setReduceMotion(on) { reduced = !!on; },
    setPaused(on) { paused = !!on; },
    get reduceMotion() { return reduced; },
    get paused() { return paused; },
    get particles() { return particles; },
    get clock() { return clock; },
    get steps() { return steps; },
  };
}
