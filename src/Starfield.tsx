/** The background: a side-scrolling night that never quite holds still.
 *
 *  Six layers, back to front, all on one canvas behind the interface:
 *    1. nebula clouds   - big soft blobs drifting left, crossfading through hues
 *    2. ribbons         - slow aurora-like sine bands, their colour cycling
 *    3. stars           - three parallax depths scrolling sideways
 *    4. spores          - small glowing orbs that pulse and wander (the organic bit)
 *    5. ripples         - rings that bloom and fade now and then (the groove)
 *    6. comets          - pixelated ones, thin stray streaks, the odd shower
 *    7. schools         - flocks of small arrows crossing right to left, swaying as one
 *                         (the maths is in fishschool.ts; here they are pooled and blitted)
 *
 *  Two rules keep it from fighting the content above it. Everything soft is a
 *  *pre-rendered sprite* drawn with drawImage, so a frame costs a few hundred
 *  cheap blits rather than per-frame gradients and blurs. And the whole thing
 *  stops dead for anyone who asked their system for reduced motion.
 */
import { useEffect, useRef } from "react";
import { createSky } from "./sky";
import { MAX_PARTICLES, memberPose, newSchool, spawnSchool, type Pose, type School } from "./fishschool";

const TAU = Math.PI * 2;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** Violet, magenta, cyan, teal, amber -- amber sparingly, as a warm accent. */
const HUES = [264, 296, 326, 190, 166, 34];
const PIXEL = 3;
/** Twinkle brightness is bucketed so every star colour is a string built once, not per frame. */
const LEVELS = 24;
const LAYER_ALPHA = [0.45, 0.67, 0.89];       // white stars, by depth
const LAYER_ALPHA_HUED = [0.55, 0.75, 0.95];  // coloured stars
/** Minimum ms between painted frames: caps a 144 Hz display at about 80 fps. */
const GAP_FULL = 12;
/** ...and on a machine that cannot keep up, about 30 fps. */
const GAP_WEAK = 32;
const RIBBON_ALPHA = [0.042, 0.068, 0.105];
const RIBBON_WIDTH = [92, 50, 18];

/** `hi` indexes HUES, or -1 for the common cool-white star. */
interface Star { x: number; y: number; layer: 0 | 1 | 2; size: number; phase: number; hi: number }
interface Blob { sprite: number; x: number; y: number; size: number; speed: number; phase: number; bob: number }
interface Spore { sprite: number; x: number; y: number; size: number; speed: number; phase: number; bob: number }
interface Ring { x: number; y: number; born: number; hue: number; reach: number; life: number }
interface Comet { x: number; y: number; vx: number; vy: number; hue: number; size: number; spin: number }
interface Streak { x: number; y: number; vx: number; vy: number; len: number; hue: number; width: number }

const ARROW_W = 44, ARROW_H = 10;
/** Schools alive at most (MAX_PARTICLES arrows between them). */
const FISH_SLOTS = 24;

/** One arrow in one hue, head at the right edge: a tapering tail fading to nothing, a bright chevron head. */
function makeArrow(hue: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = ARROW_W; c.height = ARROW_H;
  const g = c.getContext("2d")!;
  const tail = g.createLinearGradient(0, 0, ARROW_W, 0);
  tail.addColorStop(0, `hsla(${hue}, 100%, 70%, 0)`);
  tail.addColorStop(0.7, `hsla(${hue + 18}, 100%, 74%, 0.55)`);
  tail.addColorStop(1, "rgba(255, 255, 255, 0.95)");
  g.fillStyle = tail;
  g.beginPath();
  g.moveTo(0, ARROW_H / 2); g.lineTo(ARROW_W - 8, ARROW_H / 2 - 1.6); g.lineTo(ARROW_W - 8, ARROW_H / 2 + 1.6);
  g.closePath(); g.fill();
  g.fillStyle = `hsla(${hue + 10}, 100%, 88%, 0.95)`;
  g.beginPath();
  g.moveTo(ARROW_W, ARROW_H / 2); g.lineTo(ARROW_W - 13, 0.5); g.lineTo(ARROW_W - 9, ARROW_H / 2); g.lineTo(ARROW_W - 13, ARROW_H - 0.5);
  g.closePath(); g.fill();
  return c;
}

/** A soft round glow in one hue, drawn once. */
function makeGlow(hue: number, px: number, strength: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = px;
  const g = c.getContext("2d")!;
  const r = px / 2;
  const grad = g.createRadialGradient(r, r, 0, r, r, r);
  grad.addColorStop(0, `hsla(${hue}, 95%, 66%, ${strength})`);
  grad.addColorStop(0.35, `hsla(${hue + 14}, 90%, 52%, ${strength * 0.45})`);
  grad.addColorStop(1, `hsla(${hue + 30}, 90%, 40%, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  return c;
}

export default function Starfield() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Sprites, built once.
    const nebula = HUES.map((h) => makeGlow(h, 256, 0.9));
    const orb = HUES.map((h) => makeGlow(h, 64, 1));
    const arrow = HUES.map((h) => makeArrow(h));

    // Colour strings for the stars, built once: [hue index + 1][layer][level].
    const starStyle: string[][][] = [-1, ...HUES.keys()].map((hi) =>
      [0, 1, 2].map((layer) => Array.from({ length: LEVELS + 1 }, (_, lv) => {
        const tw = lv / LEVELS;
        return hi < 0
          ? `rgba(236, 230, 255, ${tw * LAYER_ALPHA[layer]})`
          : `hsla(${HUES[hi]}, 100%, 78%, ${tw * LAYER_ALPHA_HUED[layer]})`;
      })));
    const whiteStyle = Array.from({ length: LEVELS + 1 }, (_, lv) => `rgba(255, 255, 255, ${lv / LEVELS})`);

    let w = 0, h = 0, dpr = 1, dprCap = 1.5;
    let stars: Star[] = [];
    let blobs: Blob[] = [];
    let spores: Spore[] = [];
    const rings: Ring[] = [];
    const comets: Comet[] = [];
    const streaks: Streak[] = [];
    // The school pool: records are reused, nothing is allocated after this.
    const fish = Array.from({ length: FISH_SLOTS }, () => ({ s: newSchool() as School, age: 0, on: false }));
    const pose: Pose = { x: 0, y: 0, angle: 0 };
    const calm = reduced ? 0 : 1;      // sideways sway, off under reduced motion
    let sky: CanvasGradient | null = null;

    let raf = 0;
    let last = 0;
    let clock = 0;                 // seconds since start, advanced by dt
    let nextRing = 4, nextComet = 2.2, nextStreak = 0.9, nextShower = 18, nextSchool = 1;
    let lite = false;              // flips on if frames get expensive (and back off, with hysteresis)
    let minGap = GAP_FULL;
    let workMs = 0, frames = 0;

    function build() {
      dpr = Math.min(window.devicePixelRatio || 1, dprCap);
      w = canvas!.clientWidth;
      h = canvas!.clientHeight;
      canvas!.width = Math.floor(w * dpr);
      canvas!.height = Math.floor(h * dpr);
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);

      sky = ctx!.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, "#04030d");
      sky.addColorStop(0.5, "#0a0722");
      sky.addColorStop(1, "#05040f");

      const area = w * h;
      const total = Math.min(Math.max(area / 3400, 150), 520);
      stars = Array.from({ length: Math.round(total) }, () => {
        const r = Math.random();
        const layer = (r < 0.56 ? 0 : r < 0.86 ? 1 : 2) as 0 | 1 | 2;
        return {
          x: Math.random() * w, y: Math.random() * h, layer,
          size: layer === 0 ? rand(0.6, 1.2) : layer === 1 ? rand(1, 1.8) : rand(1.5, 2.6),
          phase: Math.random() * TAU,
          hi: Math.random() < 0.18 ? Math.floor(Math.random() * HUES.length) : -1,
        };
      });

      // Schools in flight were laid out for the old size: start a fresh, part-crossed set.
      for (const f of fish) f.on = false;
      for (let i = 0; i < 6; i++) {
        const f = spawnFish();
        if (f) f.age = Math.random() * f.s.life * 0.85;
      }

      const span = w + 800;
      blobs = Array.from({ length: Math.max(5, Math.round(w / 260)) }, (_, i) => ({
        sprite: i % nebula.length,
        x: Math.random() * span - 400, y: Math.random() * h,
        size: rand(380, 760), speed: rand(4, 11), phase: Math.random() * TAU,
        bob: rand(20, 60),
      }));
      spores = Array.from({ length: Math.max(10, Math.round(w / 90)) }, () => ({
        sprite: Math.floor(Math.random() * orb.length),
        x: Math.random() * w, y: Math.random() * h,
        size: rand(10, 34), speed: rand(6, 20), phase: Math.random() * TAU,
        bob: rand(14, 46),
      }));
    }

    // ---------------------------------------------------------------- layers

    function drawNebula(dt: number) {
      ctx!.globalCompositeOperation = "lighter";
      for (const b of blobs) {
        b.x -= b.speed * dt;
        if (b.x < -b.size) { b.x = w + b.size * 0.5; b.y = Math.random() * h; }
        // Each blob breathes on its own beat, so the colour of the whole sky
        // slowly changes without ever cutting.
        const a = 0.09 + 0.17 * (0.5 + 0.5 * Math.sin(clock * 0.19 + b.phase));
        ctx!.globalAlpha = a;
        const y = b.y + Math.sin(clock * 0.11 + b.phase) * b.bob;
        ctx!.drawImage(nebula[b.sprite], b.x - b.size / 2, y - b.size / 2, b.size, b.size);
      }
      ctx!.globalAlpha = 1;
    }

    function drawRibbons() {
      ctx!.globalCompositeOperation = "lighter";
      ctx!.lineCap = "round";
      ctx!.lineJoin = "round";
      const count = lite ? 2 : 3;
      const passes = lite ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const base = h * (0.24 + i * 0.26) + Math.sin(clock * 0.07 + i) * 24;
        const amp = 34 + i * 16;
        const hue = (clock * 7 + i * 83) % 360;
        const scroll = clock * (22 + i * 9);            // waves travel left
        // One path and one gradient per ribbon, stroked once per glow pass; the
        // pass's strength rides on globalAlpha, which composes exactly like a
        // gradient whose stops carry the alpha.
        const path = new Path2D();
        for (let x = -30; x <= w + 30; x += 22) {
          const u = x + scroll;
          const y = base
            + Math.sin(u * 0.0048 + i * 1.9) * amp
            + Math.sin(u * 0.0013 - clock * 0.2 + i) * amp * 1.5
            + Math.sin(u * 0.011 + clock * 0.5) * amp * 0.12;
          if (x === -30) path.moveTo(x, y); else path.lineTo(x, y);
        }
        const grad = ctx!.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, `hsl(${hue}, 92%, 60%)`);
        grad.addColorStop(0.33, `hsl(${hue + 60}, 92%, 62%)`);
        grad.addColorStop(0.66, `hsl(${hue + 130}, 92%, 62%)`);
        grad.addColorStop(1, `hsl(${hue + 200}, 92%, 60%)`);
        ctx!.strokeStyle = grad;
        for (let p = 0; p < passes; p++) {
          ctx!.globalAlpha = RIBBON_ALPHA[p];
          ctx!.lineWidth = RIBBON_WIDTH[p] - i * 6;
          ctx!.stroke(path);
        }
      }
      ctx!.globalAlpha = 1;
    }

    function drawStars(dt: number) {
      ctx!.globalCompositeOperation = "source-over";
      // Pixels per second to the left. Near stars move faster, which is what
      // makes it read as depth rather than as a flat scroll.
      const speed = [9, 24, 58];
      for (const s of stars) {
        s.x -= speed[s.layer] * dt;
        if (s.x < -6) { s.x = w + 6; s.y = Math.random() * h; }
        const tw = 0.55 + 0.45 * Math.sin(clock * (0.9 + s.layer * 0.7) + s.phase);
        const y = s.y + Math.sin(clock * 0.25 + s.phase) * (1 + s.layer * 1.6);
        const lv = Math.round(tw * LEVELS);
        ctx!.fillStyle = starStyle[s.hi + 1][s.layer][lv];
        if (s.layer === 0) {
          ctx!.fillRect(s.x, y, s.size, s.size);
        } else {
          // A short smear behind the star, longer the nearer it is.
          const len = s.layer === 1 ? 5 : 13;
          ctx!.fillRect(s.x, y, s.size + len, Math.max(s.size * 0.7, 1));
          if (s.layer === 2) {
            ctx!.fillStyle = whiteStyle[lv];
            ctx!.fillRect(s.x, y - 0.2, s.size * 1.2, s.size);
          }
        }
      }
    }

    function drawSpores(dt: number) {
      ctx!.globalCompositeOperation = "lighter";
      const n = lite ? Math.floor(spores.length / 2) : spores.length;
      for (let i = 0; i < n; i++) {
        const sp = spores[i];
        sp.x -= sp.speed * dt;
        if (sp.x < -sp.size) { sp.x = w + sp.size; sp.y = Math.random() * h; }
        const pulse = 0.5 + 0.5 * Math.sin(clock * 0.8 + sp.phase);
        const y = sp.y + Math.sin(clock * 0.32 + sp.phase) * sp.bob;
        const size = sp.size * (0.8 + 0.5 * pulse);
        ctx!.globalAlpha = 0.24 + 0.5 * pulse;
        ctx!.drawImage(orb[sp.sprite], sp.x - size / 2, y - size / 2, size, size);
      }
      ctx!.globalAlpha = 1;
    }

    function drawRings() {
      ctx!.globalCompositeOperation = "lighter";
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        const p = (clock - r.born) / r.life;
        if (p >= 1) { rings.splice(i, 1); continue; }
        const ease = 1 - Math.pow(1 - p, 2.2);
        // Three rings a beat apart: a ripple, not a circle.
        for (let k = 0; k < 3; k++) {
          const q = p - k * 0.1;
          if (q <= 0) continue;
          const e = 1 - Math.pow(1 - q, 2.2);
          ctx!.strokeStyle = `hsla(${r.hue + k * 22}, 95%, 66%, ${0.2 * (1 - q) * (1 - q)})`;
          ctx!.lineWidth = 1.5 + 2 * (1 - q);
          ctx!.beginPath();
          ctx!.arc(r.x, r.y, 8 + r.reach * e, 0, TAU);
          ctx!.stroke();
        }
        void ease;
      }
    }

    function drawComets(dt: number) {
      ctx!.globalCompositeOperation = "lighter";
      for (let i = comets.length - 1; i >= 0; i--) {
        const c = comets[i];
        c.x += c.vx * dt; c.y += c.vy * dt;
        if (c.x < -140 || c.x > w + 140 || c.y < -140 || c.y > h + 140) { comets.splice(i, 1); continue; }
        // Drawn as blocks on a grid, so it reads as pixel art rather than as a
        // smooth streak. The tail drifts through hue as it fades.
        const tail = lite ? 9 : 15;
        const nx = -c.vx / Math.hypot(c.vx, c.vy), ny = -c.vy / Math.hypot(c.vx, c.vy);
        for (let t = 0; t < tail; t++) {
          const f = 1 - t / tail;
          const bx = Math.round((c.x + nx * t * 9) / PIXEL) * PIXEL;
          const by = Math.round((c.y + ny * t * 9 + Math.sin(clock * 6 + t * 0.7 + c.spin) * (t * 0.35)) / PIXEL) * PIXEL;
          ctx!.fillStyle = `hsla(${c.hue + t * 7}, 100%, ${58 + f * 30}%, ${f * 0.9})`;
          const s = PIXEL * Math.max(c.size * f, 0.7);
          ctx!.fillRect(bx, by, s, s);
        }
        ctx!.fillStyle = "rgba(255, 255, 255, 0.95)";
        ctx!.fillRect(Math.round(c.x / PIXEL) * PIXEL, Math.round(c.y / PIXEL) * PIXEL, PIXEL * 1.5, PIXEL * 1.5);
      }
    }

    function spawnFish() {
      const slot = fish.find((f) => !f.on);
      if (!slot) return null;
      let used = 0;
      for (const f of fish) if (f.on) used += f.s.n;
      if (!spawnSchool(Math.random, w, h, HUES.length, MAX_PARTICLES - used, slot.s)) return null;
      slot.age = 0; slot.on = true;
      return slot;
    }

    function drawSchools(dt: number) {
      ctx!.globalCompositeOperation = "lighter";
      const step = lite ? 2 : 1;          // a weak machine draws every other arrow
      for (const f of fish) {
        if (!f.on) continue;
        f.age += dt;
        const s = f.s;
        if (f.age >= s.life) { f.on = false; continue; }
        ctx!.globalAlpha = s.alpha;
        const img = arrow[s.hue];
        const k = dpr * s.scale * 0.8;
        for (let i = 0; i < s.n; i += step) {
          memberPose(s, i, f.age, calm, pose);
          if (pose.x < -60 || pose.x > w + 60 || pose.y < -30 || pose.y > h + 30) continue;
          const c = Math.cos(pose.angle) * k, sn = Math.sin(pose.angle) * k;
          ctx!.setTransform(c, sn, -sn, c, pose.x * dpr, pose.y * dpr);
          ctx!.drawImage(img, -ARROW_W, -ARROW_H / 2);
        }
      }
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.globalAlpha = 1;
    }

    function drawStreaks(dt: number) {
      ctx!.globalCompositeOperation = "lighter";
      ctx!.lineCap = "round";
      for (let i = streaks.length - 1; i >= 0; i--) {
        const s = streaks[i];
        s.x += s.vx * dt; s.y += s.vy * dt;
        const m = Math.hypot(s.vx, s.vy);
        const dx = s.vx / m, dy = s.vy / m;
        const tx = s.x - dx * s.len, ty = s.y - dy * s.len;
        if ((s.x < -s.len && s.vx < 0) || (s.x - s.len > w && s.vx > 0) ||
            (s.y < -s.len && s.vy < 0) || (s.y - s.len > h && s.vy > 0)) {
          streaks.splice(i, 1); continue;
        }
        const g = ctx!.createLinearGradient(tx, ty, s.x, s.y);
        g.addColorStop(0, `hsla(${s.hue}, 100%, 70%, 0)`);
        g.addColorStop(0.7, `hsla(${s.hue + 18}, 100%, 74%, 0.5)`);
        g.addColorStop(1, "rgba(255, 255, 255, 0.95)");
        ctx!.strokeStyle = g;
        ctx!.lineWidth = s.width;
        ctx!.beginPath();
        ctx!.moveTo(tx, ty);
        ctx!.lineTo(s.x, s.y);
        ctx!.stroke();
      }
    }

    // --------------------------------------------------------------- spawning

    function spawnComet() {
      const ltr = Math.random() < 0.5;
      const angle = rand(0.12, 0.62) * (Math.random() < 0.5 ? 1 : -1);
      const speed = rand(230, 520);
      comets.push({
        x: ltr ? -60 : w + 60, y: rand(h * 0.05, h * 0.95),
        vx: (ltr ? 1 : -1) * Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        hue: pick(HUES), size: rand(1.1, 2.4), spin: Math.random() * TAU,
      });
    }

    function spawnStreak(vx?: number, vy?: number, y?: number, hue?: number) {
      const ltr = Math.random() < 0.55;
      const speed = rand(760, 1500);
      const angle = rand(-0.28, 0.28);
      streaks.push({
        x: ltr ? -20 : w + 20, y: y ?? rand(-20, h * 0.9),
        vx: vx ?? (ltr ? 1 : -1) * Math.cos(angle) * speed,
        vy: vy ?? Math.sin(angle) * speed + rand(60, 220),
        len: rand(120, 340), hue: hue ?? pick(HUES), width: rand(0.9, 2.2),
      });
    }

    function spawnShower() {
      // Parallel streaks, as meteors really arrive: same direction, same hue.
      const ltr = Math.random() < 0.5;
      const speed = rand(900, 1300);
      const angle = rand(0.2, 0.45);
      const vx = (ltr ? 1 : -1) * Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const hue = pick(HUES);
      const n = Math.floor(rand(4, 8));
      for (let i = 0; i < n; i++) {
        streaks.push({
          x: (ltr ? -40 : w + 40) - (ltr ? 1 : -1) * rand(0, 260), y: rand(-60, h * 0.6),
          vx: vx * rand(0.9, 1.1), vy: vy * rand(0.9, 1.1),
          len: rand(110, 280), hue: hue + rand(-14, 14), width: rand(0.8, 1.9),
        });
      }
    }

    function spawnRing() {
      rings.push({
        x: rand(w * 0.1, w * 0.9), y: rand(h * 0.15, h * 0.85),
        born: clock, hue: pick(HUES), reach: rand(180, 340), life: rand(5, 8),
      });
    }

    // ------------------------------------------------------------------ frame

    function paint(dt: number) {
      ctx!.globalCompositeOperation = "source-over";
      ctx!.globalAlpha = 1;
      ctx!.fillStyle = sky!;
      ctx!.fillRect(0, 0, w, h);
      drawNebula(dt);
      drawRibbons();
      drawStars(dt);
      drawSpores(dt);
      drawRings();
      drawSchools(dt);
      skyEvents?.draw(dt);
      drawStreaks(dt);
      drawComets(dt);
      ctx!.globalCompositeOperation = "source-over";
    }

    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      const gap = last ? now - last : 16;
      if (last && gap < minGap) return;       // a faster display does not get a faster sky
      const t0 = performance.now();
      const dt = Math.min(0.05, gap / 1000);
      last = now;
      clock += dt;

      skyEvents?.update(dt);
      if ((nextRing -= dt) <= 0) { spawnRing(); nextRing = rand(6, 11); }
      if ((nextComet -= dt) <= 0) { spawnComet(); nextComet = rand(2.6, 6.5); }
      if ((nextStreak -= dt) <= 0) { spawnStreak(); nextStreak = rand(3.5, 8); }   // lone fast arrows; most now fly in schools
      if ((nextSchool -= dt) <= 0) { spawnFish(); nextSchool = rand(2, 5.5); }
      if ((nextShower -= dt) <= 0) { spawnShower(); nextShower = rand(22, 40); }

      paint(dt);

      // If frames get expensive on a weak machine, thin the soft layers rather
      // than drop below a smooth rate.
      workMs += performance.now() - t0;
      if (++frames === 60) {
        const avg = workMs / frames;
        canvas!.dataset.frameMs = avg.toFixed(2);
        // Hysteresis: thin the layers above 11 ms, restore them only well below
        // it, so the guard cannot flip every second.
        if (!lite && avg > 11) lite = true;
        else if (lite && avg < 6.5) lite = false;
        if (avg > 18) {
          minGap = GAP_WEAK;                                  // really weak: about 30 fps...
          if (dprCap > 1) { dprCap = 1; build(); }            // ...at 1x pixels
        } else if (avg < 9) minGap = GAP_FULL;
        workMs = 0; frames = 0;
      }
    }

    build();
    // Rare grand events (see sky.ts). Never under reduced motion.
    const skyEvents = createSky({
      canvas, ctx, hues: HUES, glow: nebula, orb, lite: () => lite,
      w: () => w, h: () => h,
    });
    if (reduced) skyEvents.disable();
    // Rebuilding re-rolls every star, so wait for the resize to settle and only
    // act if the size really changed.
    let resizeTimer = 0;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (canvas.clientWidth === w && canvas.clientHeight === h) return;
        build();
        if (reduced) paint(0);
      }, 120);
    };
    window.addEventListener("resize", onResize);

    if (reduced) {
      // One composed still: the texture without any of the motion.
      clock = 13;
      paint(0);
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      skyEvents.dispose();
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return <canvas ref={ref} className="starfield" aria-hidden="true" />;
}
