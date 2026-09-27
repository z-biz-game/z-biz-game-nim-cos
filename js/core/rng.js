// Deterministic seeding. `hashSeed` is an FNV-1a *derived* two-round mixer over UTF-16 code
// units (low byte, multiply, high byte, multiply), NOT textbook FNV-1a: hashSeed('a') is
// 723832900 where the published FNV-1a vector is 3826002220. Nothing in this repo asserts a
// public vector; the tests in test/library.test.mjs only claim self-consistency (same seed
// twice, neighbours apart, `>>> 0` in 32 bits). With that caveat the promise holds: every
// lot is a pure function of a seed string, so a daily date and a shared #/lot/<id> link
// resolve to the same piles on any device.

export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (str.charCodeAt(i) >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  let s = a >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  return rng;
}

export function rngFrom(seed) {
  if (typeof seed === 'function' && seed.int) return seed;
  if (typeof seed === 'number') return mulberry32(seed >>> 0);
  return mulberry32(hashSeed(String(seed)));
}

export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
