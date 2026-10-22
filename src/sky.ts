/** Grand events: rare, large, one-at-a-time moments layered into the background.
 *
 *  Design rules (they keep the interface above readable and the frame cheap):
 *   - Every event is a pure function of progress p (0..1) and a few parameters
 *     rolled once at the start (centre, hue, a small typed-array "pool" of
 *     angles/magnitudes). No per-frame allocation, nothing to clean up but one
 *     slot, and a viewport resize mid-event just rescales it.
 *   - Everything soft is a sprite built once, drawn with drawImage.
 *   - Brightness is capped: every blit is clamped to CAP alpha, glows are
 *     coloured not white, and nothing here covers the whole canvas.
 */

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sm = (x: number) => { const c = clamp01(x); return c * c * (3 - 2 * c); };
const outCubic = (x: number) => { const c = 1 - clamp01(x); return 1 - c * c * c; };
const frac = (x: number) => x - Math.floor(x);
/** Standard in/out envelope: ease in over the first 18%, out over the last 30%. */
const envelope = (p: number) => sm(p / 0.18) * sm((1 - p) / 0.3);
const CAP = 0.9;
const PN = 100; // pool size
const MARGIN = new Set(["supernova", "implosion", "void", "wormhole", "bloom", "pulsar"]);

export interface SkyEnv {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  w: () => number;
  h: () => number;
  hues: number[];
  glow: HTMLCanvasElement[]; // big soft nebula sprites, one per hue
  orb: HTMLCanvasElement[];  // small orbs, one per hue
  lite: () => boolean;
}

interface Def { name: string; dur: [number, number]; draw: (p: number, t: number) => void }

function sprite(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  paint(c.getContext("2d")!);
  return c;
}

export function createSky(env: SkyEnv) {
  const { ctx, canvas, hues } = env;
  const NH = hues.length;
  const hi = (i: number) => ((Math.floor(i) % NH) + NH) % NH;

  // ----------------------------------------------------------- sprites (once)
  const ringS = hues.map((hue) => sprite(512, 512, (g) => {
    const gr = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    gr.addColorStop(0, `hsla(${hue}, 95%, 62%, 0)`);
    gr.addColorStop(0.72, `hsla(${hue}, 95%, 62%, 0)`);
    gr.addColorStop(0.9, `hsla(${hue + 12}, 100%, 70%, 0.85)`);
    gr.addColorStop(1, `hsla(${hue + 24}, 95%, 60%, 0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  }));
  // A crisp thin ring (photon ring / shockwave front) with a soft glow either side.
  const thinS = hues.map((hue) => sprite(512, 512, (g) => {
    const gr = g.createRadialGradient(256, 256, 0, 256, 256, 256);
    gr.addColorStop(0, `hsla(${hue}, 95%, 62%, 0)`);
    gr.addColorStop(0.9, `hsla(${hue}, 95%, 62%, 0)`);
    gr.addColorStop(0.955, `hsla(${hue + 10}, 100%, 72%, 0.35)`);
    gr.addColorStop(0.975, `hsla(${hue + 20}, 100%, 82%, 1)`);
    gr.addColorStop(0.99, `hsla(${hue + 10}, 100%, 66%, 0.3)`);
    gr.addColorStop(1, `hsla(${hue}, 95%, 60%, 0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 512, 512);
  }));
  const hot = sprite(128, 128, (g) => {
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(255, 238, 255, 1)");
    gr.addColorStop(0.22, "rgba(255, 190, 255, 0.5)");
    gr.addColorStop(1, "rgba(200, 120, 255, 0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  });
  const dark = sprite(256, 256, (g) => {
    const gr = g.createRadialGradient(128, 128, 0, 128, 128, 128);
    gr.addColorStop(0, "rgba(2, 1, 8, 1)");
    gr.addColorStop(0.78, "rgba(2, 1, 8, 0.96)");
    gr.addColorStop(1, "rgba(2, 1, 8, 0)");
    g.fillStyle = gr; g.fillRect(0, 0, 256, 256);
  });
  // A beam: bright at the left origin, fading along its length and across it.
  const beamS = hues.map((hue) => sprite(512, 48, (g) => {
    const along = g.createLinearGradient(0, 0, 512, 0);
    along.addColorStop(0, `hsla(${hue}, 100%, 72%, 1)`);
    along.addColorStop(0.3, `hsla(${hue + 20}, 100%, 62%, 0.5)`);
    along.addColorStop(1, `hsla(${hue + 40}, 100%, 55%, 0)`);
    g.fillStyle = along; g.fillRect(0, 0, 512, 48);
    g.globalCompositeOperation = "destination-in";
    const across = g.createLinearGradient(0, 0, 0, 48);
    across.addColorStop(0, "rgba(0,0,0,0)");
    across.addColorStop(0.5, "rgba(0,0,0,1)");
    across.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = across; g.fillRect(0, 0, 512, 48);
  }));
  // Aurora curtain strip: bright lower hem, soft fade upward.
  const stripS = hues.map((hue) => sprite(4, 256, (g) => {
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, `hsla(${hue + 50}, 95%, 60%, 0)`);
    gr.addColorStop(0.55, `hsla(${hue + 25}, 95%, 60%, 0.3)`);
    gr.addColorStop(0.88, `hsla(${hue}, 100%, 64%, 0.9)`);
    gr.addColorStop(1, `hsla(${hue}, 100%, 60%, 0)`);
    g.fillStyle = gr; g.fillRect(0, 0, 4, 256);
  }));
  // Gas giant: one reusable offscreen canvas, repainted per appearance.
  const PW = 760, PH = 480, PR = 150;
  const planetC = document.createElement("canvas");
  planetC.width = PW; planetC.height = PH;

  function paintPlanet(hue: number, ph: number) {
    const g = planetC.getContext("2d")!;
    g.clearRect(0, 0, PW, PH);
    g.save();
    g.translate(PW / 2, PH / 2);
    g.rotate(-0.28);
    const ringSet: [number, number, number, number][] = [
      [0.62, 9, 0.45, 55], [0.72, 5, 0.3, 66], [0.8, 12, 0.5, 50], [0.9, 6, 0.35, 62], [1, 4, 0.3, 70],
    ];
    const rx = 340, ry = 80;
    const ringHalf = (a0: number, a1: number) => {
      for (const [s, lw, al, l] of ringSet) {
        g.strokeStyle = `hsla(${hue + 24}, 55%, ${l}%, ${al})`;
        g.lineWidth = lw;
        g.beginPath(); g.ellipse(0, 0, rx * s, ry * s, 0, a0, a1); g.stroke();
      }
    };
    ringHalf(Math.PI, TAU);            // far side, behind the planet
    g.save();
    g.beginPath(); g.arc(0, 0, PR, 0, TAU); g.clip();
    for (let k = 0; k < 17; k++) {
      const y = -PR + (k * 2 * PR) / 16;
      g.fillStyle = `hsl(${hue + 18 * Math.sin(k * 0.9 + ph)}, 55%, ${28 + 12 * Math.sin(k * 1.7 + ph)}%)`;
      g.fillRect(-PR, y, 2 * PR, (2 * PR) / 16 + 1);
    }
    const sh = g.createRadialGradient(-60, -60, 20, 0, 0, PR + 10);
    sh.addColorStop(0, "rgba(255, 255, 255, 0.16)");
    sh.addColorStop(0.5, "rgba(0, 0, 10, 0)");
    sh.addColorStop(1, "rgba(0, 0, 10, 0.78)");
    g.fillStyle = sh; g.fillRect(-PR, -PR, 2 * PR, 2 * PR);
    g.restore();
    ringHalf(0, Math.PI);              // near side, in front
    g.restore();
  }

  // ------------------------------------------------------------------- state
  const pool = new Float32Array(PN * 4); // per particle: angle, magnitude, size, phase
  let cx = 0.5, cy = 0.5, hb = 0, mirror = 1;
  let moonCols = ["", "", ""];
  let planetHue = 0;

  function blit(img: HTMLCanvasElement, x: number, y: number, size: number, alpha: number, cap = CAP) {
    if (!(size > 0.5) || !(alpha > 0.003)) return; // also rejects NaN
    ctx.globalAlpha = alpha > cap ? cap : alpha;
    ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
  }
  /** Beam sprite from (x,y) outward along angle a, length len, thickness th. */
  function beam(i: number, x: number, y: number, a: number, len: number, th: number, alpha: number) {
    if (!(len > 1) || !(alpha > 0.003)) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a);
    ctx.globalAlpha = alpha > CAP ? CAP : alpha;
    ctx.drawImage(beamS[hi(i)], 0, -th / 2, len, th);
    ctx.restore();
  }
  const dims = () => {
    const w = Math.max(1, env.w()), h = Math.max(1, env.h());
    return { w, h, D: Math.hypot(w, h), x: cx * w, y: cy * h };
  };
  const count = (n: number) => (env.lite() ? Math.ceil(n / 2) : n);

  // ------------------------------------------------------------------ events

  const defs: Def[] = [
    {
      // Tiny point, flash, three shockwave rings, a spray of debris, slow fade.
      name: "supernova", dur: [11, 14],
      draw(p) {
        const { D, x, y } = dims();
        const life = sm(p / 0.025) * (1 - sm((p - 0.3) / 0.7));
        blit(env.glow[hi(hb)], x, y, D * 1.3 * (0.85 * outCubic(p * 1.3) + 0.15 * p), 0.5 * life);
        const flash = (1 - sm(p / 0.1)) * sm(p / 0.01);
        blit(hot, x, y, D * 0.09 + D * 0.2 * flash, 0.7 * flash);
        blit(hot, x, y, D * 0.05 * (1 - p), 0.5 * (1 - p));
        for (let k = 0; k < 3; k++) {
          const q = clamp01((p - k * 0.05) / 0.85);
          if (q <= 0) continue;
          const f = Math.pow(1 - q, 1.4);
          blit(ringS[hi(hb + k)], x, y, D * 1.3 * outCubic(q), 0.85 * f);
          blit(thinS[hi(hb + k)], x, y, D * 1.3 * outCubic(q), 0.9 * f);
        }
        const n = count(70);
        const spread = 0.85 * outCubic(p * 1.15) + 0.15 * p; // never clamps: keeps drifting while it fades
        const a = Math.pow(1 - p, 1.1);
        for (let i = 0; i < n; i++) {
          const ang = pool[i * 4] + p * 0.2 * (pool[i * 4 + 3] - 0.5);
          const sz = (16 + 30 * pool[i * 4 + 2]) * (1 - 0.5 * p);
          const img = env.orb[hi(hb + i)];
          // Head plus a short fading trail back toward the blast centre.
          for (let k = 0; k < 3; k++) {
            const r = D * 0.6 * pool[i * 4 + 1] * spread * (1 - 0.07 * k);
            blit(img, x + Math.cos(ang) * r, y + Math.sin(ang) * r, sz * (1 - 0.22 * k), 0.95 * a * (1 - 0.3 * k));
          }
        }
      },
    },
    {
      // Everything spirals inward, a pinch of light, then a soft rebound.
      name: "implosion", dur: [10, 13],
      draw(p) {
        const { D, x, y } = dims();
        const PIN = 0.5;
        const q = clamp01(p / PIN);
        const n = count(100);
        const arrive = sm(p / 0.08);
        for (let i = 0; i < n; i++) {
          const img = env.orb[hi(hb + i)];
          // Each orb falls along a winding path; two older samples make a streak.
          for (let k = 0; k < 3; k++) {
            const qq = clamp01(p / PIN - k * 0.035); // unclamped head: trails keep moving after the pinch
            const near = 1 - Math.pow(qq, 1.8);
            if (near <= 0.002) continue; // alpha is already ~0 here (see the sm(near) fade)
            const a = pool[i * 4] + mirror * 9 * Math.pow(qq, 1.5);
            const r = D * 0.75 * pool[i * 4 + 1] * near;
            const sz = (10 + 22 * pool[i * 4 + 2]) * (0.55 + 0.7 * qq) * (1 - 0.2 * k);
            blit(img, x + Math.cos(a) * r, y + Math.sin(a) * r, sz, (0.45 + 0.5 * q) * arrive * sm(near * 8) * (1 - 0.3 * k));
          }
        }
        if (p < PIN) {
          const gather = 1 - sm((q - 0.8) / 0.2); // fades out as it closes on the point
          blit(ringS[hi(hb)], x, y, D * 1.5 * (1 - Math.pow(q, 1.8)) + 20, 0.5 * arrive * q * gather);
          blit(env.glow[hi(hb + 1)], x, y, D * 0.5 * Math.pow(q, 2), 0.4 * arrive * gather);
        }
        if (p < PIN + 0.12) {
          const pinch = Math.pow(q, 2.5) * (1 - sm((p - PIN) / 0.12));
          blit(hot, x, y, 14 + D * 0.2 * pinch, 0.85 * pinch);
        }
        if (p > PIN) {
          const b = clamp01((p - PIN) / (1 - PIN));
          const f = Math.pow(1 - b, 1.3) * sm(b / 0.06);
          blit(ringS[hi(hb + 2)], x, y, D * 1.5 * outCubic(b), 0.9 * f);
          blit(thinS[hi(hb + 3)], x, y, D * 1.5 * outCubic(b), 0.9 * f);
          blit(ringS[hi(hb + 4)], x, y, D * 1.0 * (0.75 * outCubic(b) + 0.25 * b), 0.6 * f);
          blit(env.glow[hi(hb + 1)], x, y, D * 1.1 * outCubic(b), 0.4 * (1 - b) * sm(b / 0.06));
        }
      },
    },
    {
      // A dark disc swells and swallows the stars; lensing ring, accretion glow.
      name: "void", dur: [13, 16],
      draw(p, t) {
        const { D, x, y } = dims();
        const open = sm(p / 0.35) * (1 - sm((p - 0.68) / 0.32));
        const Rv = D * 0.22 * open;
        if (Rv < 2) return;
        // Stars and motes are pulled in: they orbit, speed up, trail, and shrink into the rim.
        const n = count(56);
        for (let i = 0; i < n; i++) {
          const img = env.orb[hi(hb + i)];
          for (let k = 0; k < 3; k++) {
            const f = frac(pool[i * 4 + 3] + t * (0.06 + 0.04 * pool[i * 4 + 1]) - k * 0.012);
            const r = Rv * (1.1 + 3.2 * (1 - f) * (1 - f));
            const a = pool[i * 4] + Math.pow(1 - f, 1.5) * 7 * mirror;
            blit(img, x + Math.cos(a) * r, y + Math.sin(a) * r * 0.9, (8 + 10 * pool[i * 4 + 2]) * (1 - 0.25 * k), 0.85 * open * Math.sin(f * Math.PI) * (1 - 0.3 * k));
          }
        }
        // Accretion arc: a tilted ellipse of orbs. Far half behind the disc, near half in front.
        const m = count(26);
        const tc = Math.cos(-0.35), ts = Math.sin(-0.35);
        const arc = (front: boolean) => {
          for (let i = 0; i < m; i++) {
            const a = (i / m) * TAU + t * 0.55 * mirror;
            const ex = Math.cos(a) * Rv * 1.6, ey = Math.sin(a) * Rv * 0.42;
            if ((ey >= 0) !== front) continue;
            blit(env.orb[hi(i % 2 ? 5 : 0)], x + ex * tc - ey * ts, y + ex * ts + ey * tc, Rv * 0.6, 0.6 * open);
          }
        };
        blit(ringS[hi(3)], x, y, Rv * 4.2, 0.4 * open);       // wide lensing halo
        arc(false);
        ctx.globalCompositeOperation = "source-over";
        blit(dark, x, y, Rv * 2.55, 0.93 * open, 0.95);       // the hole itself
        ctx.globalCompositeOperation = "lighter";
        blit(thinS[hi(5)], x, y, Rv * 2.5 + Math.sin(t * 1.3) * 4, 0.95 * open); // photon ring
        blit(ringS[hi(NH - 1)], x, y, Rv * 2.9, 0.55 * open);
        arc(true);
      },
    },
    {
      // A ringed gas giant with three moons drifts the full width, slowly.
      name: "gas-giant", dur: [15, 18],
      draw(p, t) {
        const { w, h } = dims();
        const scale = (h * 1.2) / PW;
        const dw = PW * scale;
        const px = w + dw * 0.5 - p * (w + dw);
        const py = clamp01(cy * 0.6 + 0.2) * h + Math.sin(t * 0.3) * 8;
        const pr = PR * scale;
        const fade = envelope(p);
        const moons = (back: boolean) => {
          for (let k = 0; k < 3; k++) {
            const a = pool[k * 4] + t * (0.5 - 0.13 * k) * mirror;
            const s = Math.sin(a);
            if ((s < 0) !== back) continue;
            const orb = pr * (1.55 + 0.45 * k);
            const mr = pr * (0.07 + 0.03 * pool[k * 4 + 2]);
            ctx.globalAlpha = 0.85 * fade;
            ctx.fillStyle = moonCols[k];
            ctx.beginPath();
            ctx.arc(px + Math.cos(a) * orb * 1.35, py + s * orb * 0.3, mr, 0, TAU);
            ctx.fill();
          }
        };
        ctx.globalCompositeOperation = "lighter";
        blit(env.glow[hi(planetHue)], px, py, pr * 6, 0.12 * fade); // faint atmosphere haze
        ctx.globalCompositeOperation = "source-over";
        moons(true);
        ctx.globalAlpha = 0.8 * fade;
        ctx.drawImage(planetC, px - dw / 2, py - (PH * scale) / 2, dw, PH * scale);
        moons(false);
        ctx.globalCompositeOperation = "lighter";
      },
    },
    {
      // A curtain of light sweeps across the sky, rippling as it goes.
      name: "aurora", dur: [12, 15],
      draw(p, t) {
        const { w, h } = dims();
        const n = count(44);
        const cw = w / n;
        const centre = w * (-0.15 + 1.3 * p);
        const fade = envelope(p);
        for (let i = 0; i < n; i++) {
          const x = i * cw;
          const d = (x - centre) / (w * 0.3);
          const wt = Math.exp(-d * d);
          if (wt < 0.03) continue;
          const len = h * (0.5 + 0.2 * Math.sin(i * 0.45 + t * 1.2) + 0.1 * Math.sin(i * 0.13 - t * 0.7));
          const top = h * 0.55 - len + Math.sin(i * 0.3 + t * 0.8) * h * 0.06 + h * 0.2;
          ctx.globalAlpha = Math.min(CAP, 0.17 * wt * fade);
          ctx.drawImage(stripS[hi(i / 7 + t * 0.35 + hb)], x - cw * 0.3, top, cw * 1.6, len);
        }
      },
    },
    {
      // A spiral portal opens, turns, and swallows itself again.
      name: "wormhole", dur: [11, 14],
      draw(p, t) {
        const { D, x, y } = dims();
        const open = sm(p / 0.3) * (1 - sm((p - 0.72) / 0.28));
        const Rm = D * 0.32 * open;
        if (Rm < 2) return;
        const arms = 5, pts = env.lite() ? 11 : 20;
        for (let a = 0; a < arms; a++) {
          for (let i = 1; i <= pts; i++) {
            const u = i / pts;
            const ang = (a * TAU) / arms + u * 4.5 * mirror + t * 1.5 * mirror;
            const r = Rm * Math.pow(u, 1.15);
            blit(env.orb[hi(hb + a + i / 7)], x + Math.cos(ang) * r, y + Math.sin(ang) * r, 12 + 36 * u, 0.9 * u * open);
          }
        }
        for (let k = 0; k < 3; k++) {
          const f = frac(t * 0.35 + k / 3);
          blit(ringS[hi(hb + k)], x, y, Rm * 2.2 * (1.05 - f), 0.6 * open * Math.sin(f * Math.PI));
        }
        blit(env.glow[hi(hb)], x, y, Rm * 2.6, 0.4 * open);
        blit(thinS[hi(hb + 1)], x, y, Rm * 2.2, 0.9 * open);   // bright rim
        ctx.globalCompositeOperation = "source-over";
        blit(dark, x, y, Rm * 1.0, 0.93 * open, 0.95);         // dark core
        ctx.globalCompositeOperation = "lighter";
        blit(thinS[hi(hb + 3)], x, y, Rm * 1.05, 0.6 * open);
      },
    },
    {
      // A lighthouse in space: twin beams sweep the sky, throwing ripples.
      name: "pulsar", dur: [12, 15],
      draw(p, t) {
        const { D, x, y } = dims();
        const fade = envelope(p);
        const rate = 0.85;
        const a = t * rate * mirror + pool[3] * TAU;
        const len = D * 1.0;
        beam(hb, x, y, a, len, D * 0.09, 0.42 * fade);
        beam(hb + 1, x, y, a + Math.PI, len, D * 0.09, 0.42 * fade);
        beam(hb, x, y, a, len * 0.8, D * 0.025, 0.3 * fade);
        beam(hb + 1, x, y, a + Math.PI, len * 0.8, D * 0.025, 0.3 * fade);
        blit(env.glow[hi(hb)], x, y, D * 0.3 * (0.9 + 0.1 * Math.sin(t * 9)), 0.3 * fade);
        blit(hot, x, y, 26 + 12 * Math.sin(t * 9), 0.5 * fade);
        const f = frac((t * rate) / Math.PI);
        blit(ringS[hi(hb + 2)], x, y, D * 1.1 * f + 10, 0.3 * fade * (1 - f) * sm(f / 0.08));
      },
    },
    {
      // A great nebula unfolds like a flower, turns slowly, and folds away.
      name: "bloom", dur: [13, 16],
      draw(p, t) {
        const { D, x, y } = dims();
        const fade = envelope(p);
        const open = sm(p / 0.55);
        const n = env.lite() ? 6 : 9;
        for (let layer = 0; layer < 2; layer++) {
          for (let i = 0; i < n; i++) {
            const a = (i / n) * TAU + t * 0.12 * (layer ? -1 : 1) * mirror + layer * 0.35;
            const dist = D * (layer ? 0.1 : 0.19) * open;
            const size = D * (layer ? 0.3 : 0.42) * open * (0.75 + 0.25 * Math.sin(i * 1.3 + t * 0.6));
            blit(env.glow[hi(hb + i + layer * 3)], x + Math.cos(a) * dist, y + Math.sin(a) * dist, size, (layer ? 0.17 : 0.2) * fade);
          }
        }
        blit(env.glow[hi(hb)], x, y, D * 0.35 * (open + 0.1 * Math.sin(t * 0.8)), 0.25 * fade);
        blit(ringS[hi(hb + 3)], x, y, D * 1.1 * (open + 0.2 * p), 0.16 * fade);
      },
    },
    {
      // A storm of comets, all one way, arriving in waves.
      name: "comet-storm", dur: [8, 10],
      draw(p) {
        const { w, h, D } = dims();
        const n = count(36);
        const dx = -mirror, dy = 0.45;
        const norm = Math.hypot(dx, dy);
        const vx = dx / norm, vy = dy / norm;
        const ang = Math.atan2(-vy, -vx); // tail points back along the path
        for (let i = 0; i < n; i++) {
          const delay = pool[i * 4 + 3] * 0.45;
          const q = (p - delay) / 0.5;
          if (q <= 0 || q >= 1) continue;
          const x0 = (mirror > 0 ? 0.2 + pool[i * 4 + 1] * 1.1 : -0.1 + (1 - pool[i * 4 + 1]) * 1.1) * w;
          const y0 = (-0.25 + pool[i * 4] / TAU * 0.8) * h;
          const run = D * 0.85 * q;
          const hx = x0 + vx * run, hy = y0 + vy * run;
          const a = Math.sin(q * Math.PI);
          beam(hb + i, hx, hy, ang, 140 + 200 * pool[i * 4 + 2], 9 + 8 * pool[i * 4 + 2], 0.55 * a);
          blit(env.orb[hi(hb + i)], hx, hy, 16, 0.7 * a);
        }
      },
    },
  ];

  const byName = new Map(defs.map((d) => [d.name, d]));

  // --------------------------------------------------------------- scheduler
  let cur: { def: Def; t: number; dur: number } | null = null;
  let wait = rand(25, 70);   // first event no sooner than 25 s after load
  let lastName = "";
  let enabled = true;

  function start(def: Def) {
    for (let i = 0; i < PN; i++) {
      pool[i * 4] = rand(0, TAU);
      pool[i * 4 + 1] = 0.3 + 0.7 * Math.sqrt(Math.random());
      pool[i * 4 + 2] = Math.random();
      pool[i * 4 + 3] = Math.random();
    }
    cy = rand(0.25, 0.65);
    // Big centred events hide behind the content column, so mostly push them to the margins.
    if (MARGIN.has(def.name) && Math.random() < 0.8) cx = Math.random() < 0.5 ? rand(0.08, 0.24) : rand(0.76, 0.92);
    else cx = rand(0.25, 0.75);
    hb = Math.floor(rand(0, NH));
    mirror = Math.random() < 0.5 ? 1 : -1;
    if (def.name === "gas-giant") {
      planetHue = hues[hi(hb)];
      paintPlanet(planetHue, rand(0, TAU));
      moonCols = [0, 1, 2].map((k) => `hsl(${planetHue + 20 * k}, 22%, ${46 + 8 * k}%)`);
    }
    cur = { def, t: 0, dur: rand(def.dur[0], def.dur[1]) };
    canvas.dataset.skyEvent = def.name;
  }
  function end() {
    cur = null;
    canvas.dataset.skyEvent = "";
    wait = rand(60, 180);
  }

  /** Advance the schedule. Call once per frame with the (capped) dt. */
  function update(dt: number) {
    if (!enabled || cur || document.hidden) return;
    if ((wait -= dt) > 0) return;
    if (env.lite()) { wait = rand(30, 60); return; } // weak machine: skip it
    const options = defs.filter((d) => d.name !== lastName);
    const def = options[Math.floor(Math.random() * options.length)];
    lastName = def.name;
    start(def);
  }

  /** Draw the active event, if any. Leaves the context in a neutral state. */
  function draw(dt: number) {
    if (!cur) return;
    cur.t += dt;
    const p = cur.t / cur.dur;
    if (!(p < 1)) { end(); return; }
    ctx.globalCompositeOperation = "lighter";
    cur.def.draw(p, cur.t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  function trigger(name: string): boolean {
    const def = byName.get(name);
    if (!def || !enabled) return false;
    lastName = name;
    start(def);
    return true;
  }

  canvas.dataset.skyEvent = "";
  const hook = {
    events: defs.map((d) => d.name),
    trigger,
    current: (): string | null => (cur ? cur.def.name : null),
    /** Debug: progress 0..1 of the active event (-1 when none). */
    progress: (): number => (cur ? cur.t / cur.dur : -1),
  };
  const w = window as unknown as { __mdcSky?: typeof hook };
  w.__mdcSky = hook;

  let timer = 0;
  const q = new URLSearchParams(window.location.search).get("sky");
  if (q) timer = window.setTimeout(() => { trigger(q); }, 1500);

  return {
    update,
    draw,
    /** Reduced-motion: no events at all. */
    disable() { enabled = false; cur = null; canvas.dataset.skyEvent = ""; },
    dispose() {
      window.clearTimeout(timer);
      cur = null;
      canvas.dataset.skyEvent = "";
      if (w.__mdcSky === hook) delete w.__mdcSky;
    },
  };
}
