// Original, copyright-free 120 BPM beat synthesized on the device. Arrangement:
// a ticking-clock build under the opening line, a drop on the first cut, a groove
// with every shot change on a kick, a hit when the ending lands, and a final chord.
// Pure math: no Web Audio needed, so it runs in Node tests and any browser.

export const SR = 48000;
const BEAT = 0.5;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param cfg { dur, drop, groove_end, hit, final, whoosh: [], crash: [], taps: [], seed }
 * @returns { sampleRate, left: Float32Array, right: Float32Array }
 */
export function renderMusic(cfg) {
  const dur = cfg.dur;
  const N = Math.ceil(dur * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  const rand = rng(cfg.seed ?? 7);
  const noise = (n) => {
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // approx. Gaussian via sum of uniforms
      x[i] = (rand() + rand() + rand() - 1.5) * 1.15;
    }
    return x;
  };
  const lp = (x, k) => {
    if (k <= 1) return x;
    const out = new Float32Array(x.length);
    let acc = 0;
    const h = k >> 1;
    for (let i = 0; i < x.length + h; i++) {
      if (i < x.length) acc += x[i];
      if (i - k >= 0) acc -= x[i - k];
      const j = i - h;
      if (j >= 0 && j < x.length) out[j] = acc / k;
    }
    return out;
  };
  const hp = (x, k) => {
    const l = lp(x, k);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] - l[i];
    return out;
  };
  const add = (sig, t, gain = 1, pan = 0) => {
    const i0 = Math.round(t * SR);
    const gl = Math.sqrt(0.5 * (1 - pan)) * 1.414 * gain;
    const gr = Math.sqrt(0.5 * (1 + pan)) * 1.414 * gain;
    for (let k = 0; k < sig.length; k++) {
      const i = i0 + k;
      if (i < 0) continue;
      if (i >= N) break;
      L[i] += sig[k] * gl;
      R[i] += sig[k] * gr;
    }
  };
  const note = (m) => 440 * 2 ** ((m - 69) / 12);
  const env = (n, a, d) => {
    const e = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      e[i] = Math.min(1, t / Math.max(a, 1e-4)) * Math.exp(-t / d);
    }
    return e;
  };

  const kick = () => {
    const n = Math.round(0.45 * SR);
    const out = new Float32Array(n);
    const click = hp(noise(n), 8);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * (45 + 85 * Math.exp(-t / 0.035))) / SR;
      out[i] = Math.sin(ph) * Math.exp(-t / 0.18) + 0.25 * click[i] * Math.exp(-t / 0.004);
    }
    return out;
  };
  const clap = () => {
    const n = Math.round(0.25 * SR);
    const x = hp(lp(noise(n), 3), 40);
    const e = new Float32Array(n);
    const base = env(n, 0.001, 0.09);
    for (const o of [0, 0.012, 0.024]) for (let i = Math.round(o * SR); i < n; i++) e[i] += base[i - Math.round(o * SR)];
    for (let i = 0; i < n; i++) x[i] *= e[i] * 0.5;
    return x;
  };
  const hat = (open = false) => {
    const n = Math.round((open ? 0.18 : 0.05) * SR);
    const x = hp(noise(n), 3);
    const e = env(n, 0.0005, open ? 0.06 : 0.012);
    for (let i = 0; i < n; i++) x[i] *= e[i] * 0.35;
    return x;
  };
  const tick = (hi = true) => {
    const n = Math.round(0.05 * SR);
    const nz = hp(noise(n), 4);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = (Math.sin(2 * Math.PI * (hi ? 2600 : 2000) * t) * 0.6 + nz[i] * 0.4) * Math.exp(-t / 0.006);
    }
    return out;
  };
  const tone = (m, d, harm, a, dec, sat = 0) => {
    const n = Math.round(d * SR);
    const out = new Float32Array(n);
    const f = note(m);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      let s = 0;
      for (let k = 0; k < harm.length; k++) s += harm[k] * Math.sin(2 * Math.PI * f * (k + 1) * t);
      s *= Math.min(1, t / Math.max(a, 1e-4)) * Math.exp(-t / dec);
      out[i] = sat ? Math.tanh(sat * s) : s;
    }
    return out;
  };
  const pad = (ms, d) => {
    const n = Math.round(d * SR);
    const out = new Float32Array(n);
    for (const m of ms) {
      for (const det of [-0.004, 0, 0.004]) {
        const f = note(m) * (1 + det);
        const phases = [rand() * 6, rand() * 6, rand() * 6, rand() * 6];
        const harm = [1, 0.35, 0.15, 0.07];
        for (let i = 0; i < n; i++) {
          const t = i / SR;
          let s = 0;
          for (let k = 0; k < 4; k++) s += harm[k] * Math.sin(2 * Math.PI * f * (k + 1) * t + phases[k]);
          out[i] += s;
        }
      }
    }
    const norm = ms.length * 3;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] *= (Math.min(1, t / 0.35) * Math.min(1, (d - t) / 0.4)) / norm;
    }
    return out;
  };
  const whoosh = (d = 0.4) => {
    const n = Math.round(d * SR);
    const x = lp(noise(n), 12);
    for (let i = 0; i < n; i++) x[i] *= Math.sin((Math.PI * i) / n) ** 2 * 0.5;
    return x;
  };
  const tap = () => {
    const n = Math.round(0.09 * SR);
    const nz = lp(noise(n), 6);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      ph += (2 * Math.PI * (900 + 500 * Math.exp(-t / 0.01))) / SR;
      out[i] = (Math.sin(ph) * Math.exp(-t / 0.025) + nz[i] * Math.exp(-t / 0.004) * 0.3) * 0.6;
    }
    return out;
  };

  const PROG = [
    [48, [60, 64, 67]],
    [43, [59, 62, 67]],
    [45, [60, 64, 69]],
    [41, [60, 65, 69]],
  ];
  const DROP = cfg.drop;

  // Intro: ticking clock and a pad under a long opening line, then a riser.
  if (DROP >= 5) {
    for (let k = 0; k < Math.floor(DROP / BEAT); k++) add(tick(k % 2 === 0), k * BEAT, 0.22, k % 2 ? 0.25 : -0.25);
    add(pad([57, 60, 64], DROP - 3.5), 0, 0.28);
    add(pad([53, 57, 60, 64], 3.5), DROP - 3.5, 0.3);
    for (let k = 0; k < 8; k++) add(tick(true), DROP - 2 + k * 0.25, 0.1 + 0.012 * k);
  } else if (DROP > 0.5) add(pad([53, 57, 60, 64], DROP), 0, 0.3);
  const rise = Math.min(3, DROP);
  if (rise > 0.3) {
    const n = Math.round(rise * SR);
    const nz = lp(noise(n), 6);
    const out = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      ph += (2 * Math.PI * (220 + 900 * u * u)) / SR;
      out[i] = nz[i] * u * u * 0.35 + Math.sin(ph) * u ** 3 * 0.12;
    }
    add(out, DROP - rise);
  }
  // Drop impact
  {
    const n = Math.round(1.6 * SR);
    const nz = lp(noise(n), 2);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      out[i] = Math.sin(2 * Math.PI * 48 * t) * Math.exp(-t / 0.5) * 0.9 + nz[i] * Math.exp(-t / 0.25) * 0.25;
    }
    add(out, DROP, 0.9);
  }
  // Groove
  const grooveEnd = cfg.groove_end ?? dur;
  for (let t0 = DROP, bar = 0; t0 < grooveEnd - 1e-6; t0 += 2, bar++) {
    const [root, tri] = PROG[bar % 4];
    add(pad(tri, Math.min(2, grooveEnd - t0 + 0.4)), t0, 0.22);
    for (let b = 0; b < 4; b++) {
      const tb = t0 + b * BEAT;
      if (tb >= grooveEnd - 1e-6) break;
      add(kick(), tb, 0.85);
      if (b === 1 || b === 3) add(clap(), tb, 0.55);
      add(hat(), tb + 0.25, 0.5, 0.3);
      add(hat(), tb, 0.25, -0.3);
      add(tone(root, 0.24, [1, 0.3, 0.1], 0.005, 0.15, 1.6), tb, 0.42);
      add(tone(root + 12, 0.2, [1, 0.3], 0.005, 0.1, 1.6), tb + 0.25, 0.22);
      add(tone(tri[b % 3] + 12, 0.3, [1, 0.4, 0.2, 0.1], 0.003, 0.12), tb, 0.16, -0.2);
      add(tone(tri[(b + 1) % 3] + 12, 0.3, [1, 0.4, 0.2, 0.1], 0.003, 0.12), tb + 0.25, 0.16, 0.2);
    }
  }
  for (const t of cfg.crash ?? []) add(hat(true), t, 0.35);
  for (const t of cfg.whoosh ?? []) add(whoosh(0.4), t - 0.2, 0.35);
  for (const t of cfg.taps ?? []) add(tap(), t + 0.03, 0.55);
  if (cfg.hit != null) {
    add(whoosh(0.5), cfg.hit - 0.4, 0.5);
    add(kick(), cfg.hit, 0.9);
  }
  if (cfg.final != null && dur - cfg.final > 0.3) {
    const fd = dur - cfg.final;
    for (const m of [48, 60, 64, 67, 72]) add(tone(m, fd, [1, 0.45, 0.2, 0.1], 0.01, 1.6), cfg.final, 0.6 / 5);
  }

  // Master: fade out, normalise, gentle saturation, then level to about -16 dBFS RMS.
  const fadeN = Math.min(N, Math.round(0.6 * SR));
  for (let i = 0; i < fadeN; i++) {
    const g = i / fadeN;
    L[N - 1 - i] *= g;
    R[N - 1 - i] *= g;
  }
  let peak = 1e-9;
  for (let i = 0; i < N; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  let sum = 0;
  for (let i = 0; i < N; i++) {
    L[i] = Math.tanh((L[i] / peak) * 1.3);
    R[i] = Math.tanh((R[i] / peak) * 1.3);
    sum += L[i] * L[i] + R[i] * R[i];
  }
  const rms = Math.sqrt(sum / (2 * N));
  const gain = Math.min(0.9, 0.158 / Math.max(rms, 1e-6)); // 0.158 ≈ -16 dBFS
  let top = 0;
  for (let i = 0; i < N; i++) top = Math.max(top, Math.abs(L[i] * gain), Math.abs(R[i] * gain));
  const g2 = top > 0.84 ? (gain * 0.84) / top : gain; // keep peaks under about -1.5 dBFS
  for (let i = 0; i < N; i++) {
    L[i] *= g2;
    R[i] *= g2;
  }
  return { sampleRate: SR, left: L, right: R };
}

export function musicToWav({ sampleRate, left, right }) {
  const n = left.length;
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const s = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF");
  v.setUint32(4, 36 + n * 4, true);
  s(8, "WAVE");
  s(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 16, true);
  s(36, "data");
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    v.setInt16(44 + i * 4, Math.max(-1, Math.min(1, left[i])) * 0x7fff, true);
    v.setInt16(46 + i * 4, Math.max(-1, Math.min(1, right[i])) * 0x7fff, true);
  }
  return buf;
}
