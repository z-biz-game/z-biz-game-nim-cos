// 声音：全部现算的 WebAudio，不取任何音频文件（本仓零外链）。
//
// 静音必须是真静音，而不是"把 gain 设成 0"：
//   * `muted` 为真时 `blip()` 在建节点之前就 return —— 振荡器一个也不新建，计数器可证；
//   * 同时 `ctx.suspend()` 把整台时钟停下来，已排队的包络也跟着冻住；
//   * 解除静音才 `ctx.resume()`，并且首帧之前不建 AudioContext（自动播放策略下建了也是
//     `suspended`，反而让人以为没声是 bug）。
// 页面切到后台同样挂起，回来再恢复 —— 这是"听不见但还在耗电"的那类缺陷。
//
// 这里不读 localStorage：静音态由 js/core/storage.js 决定并传进来，本文件只碰浏览器音频。

const VOICES = {
  // [频率, 时长(秒), 波形, 峰值] —— 与屏幕上的读数同色系：下棋一颗、被应将一颗、胜负各一和弦
  pick: [523.25, 0.06, 'triangle', 0.16],
  lift: [392.00, 0.05, 'sine', 0.12],
  take: [261.63, 0.09, 'triangle', 0.20],
  reply: [196.00, 0.09, 'sawtooth', 0.14],
  refuse: [138.00, 0.12, 'square', 0.10],
  win: [659.25, 0.34, 'triangle', 0.22],
  lose: [110.00, 0.42, 'sine', 0.20],
  pause: [329.63, 0.07, 'sine', 0.12],
};

export function createSound(isMuted) {
  let ctx = null;
  let master = null;
  let built = 0;      // 真建出来的振荡器个数
  let skipped = 0;    // 因为静音而没建出去的个数
  let refused = 0;    // 没有 AudioContext（老浏览器/沙箱）时的哑火次数

  function ensure() {
    if (ctx) return ctx;
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return null;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    } catch (err) {
      ctx = null;
      return null;
    }
    // 建的时候已经是静音态：立刻挂起，别让它先响一声再闭嘴。
    if (isMuted()) ctx.suspend().catch(() => {});
    return ctx;
  }

  function tone(freq, dur, type, peak, when = 0) {
    const c = ensure();
    if (!c) { refused++; return false; }
    if (c.state !== 'running') c.resume().catch(() => {});
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    // 短促的 ADSR：起音 8ms 防"咔"，其余按包络指数衰减到听不见为止。
    const top = Math.max(0.0001, peak);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(top, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    built++;
    return true;
  }

  function blip(name, when = 0) {
    if (isMuted()) {
      skipped++;
      return false;
    }
    const spec = VOICES[name] || VOICES.take;
    return tone(spec[0], spec[1], spec[2], spec[3], when);
  }

  // 和弦：胜负两张牌靠音程区分 —— 完全五度叠是"你收下最后一枚"，小三度是"被收"。
  function chord(root, when = 0) {
    if (isMuted()) { skipped++; return false; }
    const win = root === 'win';
    const base = win ? 329.63 : 164.81;
    const ratios = win ? [1, 1.5, 2] : [1, 1.19, 1.5];
    const dur = win ? 0.34 : 0.42;
    const type = win ? 'triangle' : 'sine';
    ratios.forEach((r, i) => tone(base * r, dur, type, 0.2 / (i + 1), when + i * 0.06));
    return true;
  }

  function setMuted(next) {
    const on = !!next;
    if (ctx) {
      if (on) ctx.suspend().catch(() => {});
      else if (!on) ctx.resume().catch(() => {});
    }
    return on;
  }

  function suspend() {
    if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {});
  }

  function resume() {
    // 静音态下绝不把时钟开回来，否则"静音"只在没建节点时成立。
    if (ctx && !isMuted() && ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  return {
    blip,
    chord,
    setMuted,
    suspend,
    resume,
    hasContext: () => !!ctx,
    stats: () => ({ built, skipped, refused, state: ctx ? ctx.state : 'none' }),
  };
}
