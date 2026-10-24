/** The home-page amoeba: the friend group as one single-celled creature.
 *
 *  Primary renderer is a WebGL fragment shader on one full-screen triangle (no
 *  libraries) covering the whole viewport: a 2D signed-distance field of a smooth-
 *  unioned noisy membrane with long pseudopods, shaded as a translucent iridescent
 *  cell. Inside it live N contributor colours (one per person, by index only), each
 *  a nucleus with two orbiting organelles and a coloured current in the cytoplasm,
 *  sized and lit by that person's share of the tracks. Every ~14-20 s a subset of
 *  4-8 of them gathers, fuses and pulses once ("a night"), then disperses.
 *
 *  On top of that it breathes and drifts through palettes, and now and then does one thing
 *  (bloom, split, reach, jelly, shimmer, sneeze; scheduled in amoebabehaviours.ts, one at a
 *  time, eased in and out). Under reduced motion only the slow colour drift remains.
 *
 *  If WebGL is missing, too slow (software renderer), lost, or the shader will not
 *  compile, a Canvas-2D approximation takes over. Both backends draw from the same
 *  `Frame`, so everything that moves is decided once, in `createAmoeba` (springs,
 *  smoothed drivers), and the backends only paint.
 */
import { personColour } from "./colours.ts";
import { BEHAVIOURS, createScheduler, type BehaviourName } from "./amoebabehaviours.ts";

export interface Amoeba {
  readonly backend: "webgl" | "canvas2d";
  /** Pointer over the viewport: -1..1 each way, y up. Touch counts. */
  setPointer(x: number, y: number): void;
  clearPointer(): void;
  /** A click/tap: a bright ring of colour bursts from the point (same -1..1 space). */
  burst(x: number, y: number): void;
  /** A wrong answer: the cell recoils and shivers. */
  flinch(): void;
  /** Success: reach a pseudopod toward (x, y), then swell to engulf the view. */
  surge(x: number, y: number): void;
  /** Contributor shares (relative, any scale); the creature has one colour per entry (max 12). */
  setWeights(weights: number[]): void;
  /** Start a behaviour now (or right after the one running). False for an unknown name. Dev check. */
  behave(name: string): boolean;
  /** False pauses rendering (the tab being hidden pauses it regardless). */
  setActive(active: boolean): void;
  dispose(): void;
}

export interface AmoebaOptions {
  reduced: boolean;
  /** CSS px diameter of the click target the body is sized to (about 0.83 of it). */
  hero: () => number;
  /** A night begins (k colours gathering) / ends (0). Fires twice per cycle. */
  onNight?: (k: number) => void;
  /** Where the body's centre is, in CSS px from the middle of the host (it wanders). */
  onCentre?: (dx: number, dy: number) => void;
}

const MAXC = 12;   // contributor colours
const NPOD = 5;    // pseudopods
const MIN_GAP = 12;  // ms between shader frames: about 80 fps at most

interface Frame {
  t: number;
  /** Canvas size (px) and canvas px per shader unit. */
  w: number; h: number; unit: number;
  /** Body centre, in shader units from the viewport centre (y up). Everything below is relative to it. */
  cx: number; cy: number;
  ptrX: number; ptrY: number; ptrAmt: number; ptrSpd: number; purr: number;
  /** Shimmer ring progress 0..1, or -1 when idle. */
  pulse: number;
  surge: number; sx: number; sy: number; swell: number;
  /** Entrance scale 0..1 (a point growing into the cell). */
  grow: number;
  gather: number; beat: number; flinch: number;
  burstX: number; burstY: number; burstAge: number;
  core: [number, number, number];
  n: number;
  /** n * (x, y, radius, glow) */
  nuc: Float32Array;
  /** n * (r, g, b) */
  col: Float32Array;
  /** NPOD * (x, y, radius, extension 0..1) */
  pods: Float32Array;
  halfW: number; halfH: number;
  /** Palette offset (drifts between palettes), the clock the colour waves ride, and brightness breathing -1..1. */
  hue: number; phase: number; breath: number;
  /** Running behaviour: 1-based id (0 none), eased strength, progress, seed, and its direction (length = reach). */
  bid: number; be: number; bp: number; bseed: number; bdx: number; bdy: number;
}

interface Backend {
  resize(w: number, h: number): void;
  draw(f: Frame): void;
  dispose(): void;
}

// ------------------------------------------------------------------ palette
// The app's colours in the order the membrane cycles through them.
const PAL: [number, number, number][] = [
  [0.384, 0.91, 1.0],   // cyan   #62e8ff
  [0.588, 0.47, 1.0],   // violet #9678ff
  [1.0, 0.373, 0.635],  // pink   #ff5fa2
  [1.0, 0.75, 0.3],     // amber
  [0.43, 0.96, 0.75],   // green
];
const sstep = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};
/** Same ramp as `pal` in the shader. */
function palRamp(x: number): [number, number, number] {
  const u = (x - Math.floor(x)) * 5;
  let c = PAL[0];
  for (let i = 0; i < 5; i++) {
    const k = sstep(i, i + 1, u), b = PAL[(i + 1) % 5];
    c = [c[0] + (b[0] - c[0]) * k, c[1] + (b[1] - c[1]) * k, c[2] + (b[2] - c[2]) * k];
  }
  return c;
}
const rgba = (c: number[], a: number) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;

/** A person's colour (by index only) as linear-ish 0..1 rgb, parsed from the app's palette. */
function personRgb(i: number): [number, number, number] {
  const m = /hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/.exec(personColour(i));
  const h = m ? +m[1] : (i * 41 + 250) % 360, s = 0.95, l = 0.52;   // the app's hue, pushed to a saturated glow (the palette's pastel 66% reads white once lit)
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

// ------------------------------------------------------------------- shader

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform float u_time;
uniform vec2 u_res;        // canvas px
uniform float u_unit;      // canvas px per shader unit
uniform vec2 u_centre;     // body centre, shader units from the viewport centre
uniform vec2 u_ptr;        // pointer relative to the body centre
uniform float u_ptrAmt;    // pointer presence 0..1
uniform float u_ptrSpd;    // pointer speed 0..1
uniform float u_purr;      // resting on the creature 0..1
uniform float u_pulse;
uniform float u_surge;
uniform vec2 u_surgeDir;
uniform float u_swell;
uniform float u_grow;
uniform float u_gather;    // 0..1: this night's colours are fused
uniform float u_beat;      // heartbeat envelope
uniform float u_flinch;    // seconds since a flinch, or -1
uniform vec3 u_burst;      // click ring: x, y relative to the centre, age (s) or -1
uniform vec3 u_core;       // blended colour of the gathered members
uniform float u_n;         // colours in use
uniform vec4 u_nuc[12];    // x, y, radius, glow
uniform vec3 u_col[12];
uniform vec4 u_pods[5];    // x, y, tip radius, extension
uniform float u_hue;       // palette offset: the whole ramp slides round as this drifts
uniform float u_phase;     // clock for the colour waves (still ticks under reduced motion)
uniform float u_breath;    // brightness breathing -1..1
uniform vec4 u_bh;         // running behaviour: id (0 none, 1 bloom 2 split 3 reach 4 jelly 5 shimmer 6 sneeze), eased strength, progress, seed
uniform vec2 u_bdir;       // its direction in body space; the length is how far it reaches

vec2 PTR;
float HS, BI, BE, BP;      // hue offset and the behaviour, copied from the uniforms
vec2 DC;                   // where the split's daughter sits
bool isB(float k) { return abs(BI - k) < 0.5; }

const vec3 CY = vec3(0.384, 0.910, 1.000);
const vec3 VI = vec3(0.588, 0.470, 1.000);
const vec3 PK = vec3(1.000, 0.373, 0.635);
const vec3 AM = vec3(1.000, 0.750, 0.300);
const vec3 GR = vec3(0.430, 0.960, 0.750);

// The app palette as a loop: x wraps, so any drifting number cycles the colours.
vec3 pal(float x) {
  x = fract(x + HS) * 5.0;
  vec3 c = mix(CY, VI, smoothstep(0.0, 1.0, x));
  c = mix(c, PK, smoothstep(1.0, 2.0, x));
  c = mix(c, AM, smoothstep(2.0, 3.0, x));
  c = mix(c, GR, smoothstep(3.0, 4.0, x));
  return mix(c, CY, smoothstep(4.0, 5.0, x));
}

// sin-free hash: sin() hashes fall apart on low-precision GPUs
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
float sq(float x) { return x * x; }
vec3 sat(vec3 c, float k) { return max(mix(vec3(dot(c, vec3(0.3, 0.59, 0.11))), c, k), 0.0); }
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
// a tapered arm from the centre out to tip: radius r0 at the root, r1 at the tip
float arm(vec2 q, vec2 tip, float r0, float r1) {
  float h = clamp(dot(q, tip) / (dot(tip, tip) + 1e-4), 0.0, 1.0);
  return length(q - tip * h) - mix(r0, r1, h * h);
}

// The membrane. Negative inside. Everything that moves the outline lives here.
// All drivers arrive already smoothed from the CPU; the noise here is low-frequency.
float map(vec2 p) {
  float t = u_time;
  // noise-warp the space itself so no edge is ever a clean curve
  vec2 w = vec2(vnoise(p * 1.7 + vec2(t * 0.10, -t * 0.08)),
                vnoise(p * 1.7 + vec2(-t * 0.09, t * 0.11) + 5.3)) - 0.5;
  vec2 q = p + w * 0.12;
  float bx = 0.0;   // extra radius from the running behaviour
  if (isB(4.0)) {   // jelly: squeeze one way and stretch the other, twice, then settle
    float sq2 = BE * sin(BP * 12.566);
    q = vec2(q.x * (1.0 + 0.18 * sq2), q.y * (1.0 - 0.18 * sq2));
    bx -= 0.03 * sq2;
  }
  float r = length(q);
  float a = atan(q.y, q.x);
  float fa = u_flinch >= 0.0 ? u_flinch : 9.0;
  float fe = exp(-fa * 2.8) * smoothstep(0.0, 0.1, fa);   // flinch envelope
  float breath = 0.016 * sin(t * 0.7) + 0.009 * sin(t * 1.3 + 1.0);
  if (isB(1.0)) bx += 0.03 * BE * exp(-sq((0.4 - BP * 1.15) * 5.5)) * (1.0 + 0.4 * sin(a * 5.0 + t));   // bloom: the rim swells as the ring passes
  if (isB(6.0)) bx += -0.03 * smoothstep(0.05, 0.28, BP) * (1.0 - smoothstep(0.3, 0.36, BP)) + 0.05 * exp(-sq((BP - 0.34) * 14.0));   // sneeze: breathe in, then pop
  float R = 0.40 + bx + breath + u_swell * 1.4 + 0.05 * u_gather + 0.045 * u_beat
          - 0.06 * fe + 0.010 * u_purr * sin(t * 2.4);
  R += 0.030 * sin(a * 3.0 + t * 0.35) + 0.020 * sin(a * 5.0 - t * 0.45 + 1.7)
     + 0.010 * sin(a * 8.0 + t * 0.6) + 0.014 * fe * sin(a * 9.0 + fa * 34.0);
  float d = r - R;

  // pseudopods: long tapered arms, positions sprung on the CPU
  for (int i = 0; i < 5; i++) {
    vec4 pd = u_pods[i];
    d = smin(d, arm(q, pd.xy, 0.085 - 0.03 * pd.w, pd.z), 0.17);
  }
  if (isB(2.0)) {   // split: a daughter swells, pinches off and drifts, then the group blends back
    float dl = length(DC);
    d = smin(d, length(q - DC) - (0.12 + 0.03 * sin(t * 1.3)) * smoothstep(0.0, 0.3, BE), mix(0.22, 0.03, smoothstep(0.25, 0.55, dl)));
  }
  if (isB(3.0)) {   // reach: a long arm, with a shorter one either side, wobbling as it stretches
    float c1 = cos(0.5 + 0.1 * sin(t * 1.7)), s1 = sin(0.5 + 0.1 * sin(t * 1.7));
    vec2 bd = u_bdir * BE;
    d = smin(d, arm(q, bd, 0.075, 0.035 + 0.02 * BE), 0.2);
    d = smin(d, arm(q, vec2(c1 * bd.x - s1 * bd.y, s1 * bd.x + c1 * bd.y) * 0.7, 0.06, 0.03), 0.2);
    d = smin(d, arm(q, vec2(c1 * bd.x + s1 * bd.y, -s1 * bd.x + c1 * bd.y) * 0.55, 0.055, 0.028), 0.2);
  }
  // the membrane bulges toward the pointer
  float pl = length(PTR);
  float near = u_ptrAmt * smoothstep(1.4, 0.3, pl);
  if (near > 0.002) {
    vec2 bt = PTR / max(pl, 0.001) * min(pl * 0.9, 0.58);
    d = smin(d, arm(q, bt, 0.06 * near, (0.045 + 0.06 * (0.5 + u_ptrSpd)) * near), 0.2);
  }
  // the success click: a neck and a tip reaching for the click point
  if (u_surge > 0.0) {
    vec2 tip = u_surgeDir * (0.40 + 0.55 * u_surge);
    d = smin(d, arm(q, tip, 0.07 + 0.05 * u_surge, 0.04 + 0.13 * u_surge), 0.2);
  }

  // ripples around the pointer, and the occasional shimmer ring from the centre
  float pd2 = length(p - PTR);
  d += 0.010 * sin(pd2 * 30.0 - t * 4.0) * smoothstep(0.55, 0.0, pd2) * u_ptrAmt * (0.4 + u_ptrSpd);
  if (u_pulse >= 0.0) {
    float x = (length(p) - u_pulse * 1.1) * 7.0;
    d += 0.022 * sin(x * 4.5) * exp(-x * x) * (1.0 - u_pulse);
  }
  return d;
}

void main() {
  float t = u_time;
  if (u_grow <= 0.0) { gl_FragColor = vec4(0.0); return; }
  HS = u_hue; BI = u_bh.x; BE = u_bh.y; BP = u_bh.z;
  DC = u_bdir * BE + 0.04 * BE * vec2(sin(u_phase * 0.9), cos(u_phase * 1.1));
  float G = max(u_grow, 0.02);
  vec2 pw = (gl_FragCoord.xy - 0.5 * u_res) / u_unit;   // viewport, shader units
  vec2 p = (pw - u_centre) / G;                          // body space
  PTR = u_ptr / G;

  float d = map(p);
  float ang = atan(p.y, p.x) / 6.2832;
  // slow palette waves travelling through the body: out from the middle, and round it
  float wave = 0.6 * sin(length(p) * 6.0 - u_phase * 0.8) + 0.4 * sin(ang * 12.566 + u_phase * 0.35 + length(p) * 3.0);
  float n1 = vnoise(p * 2.0 + t * 0.10);
  float pulseE = u_pulse >= 0.0 ? exp(-sq((length(p) - u_pulse * 1.1) * 6.0)) * (1.0 - u_pulse) : 0.0;
  float pd = length(p - PTR);
  float lit = (1.0 + 0.2 * u_gather + 0.3 * u_beat) * (1.0 + 0.1 * u_breath);      // whole-cell brightening

  // cursor colour pulses (travelling waves) and the purr (a slow rhythmic pulse)
  float wamp = u_ptrAmt * (0.25 + 0.75 * u_ptrSpd) * exp(-pd * 1.5);
  float wv = wamp * (0.5 + 0.5 * sin(pd * 16.0 - t * 3.2));
  float purr = u_purr * (0.5 + 0.5 * sin(t * 2.4 - pd * 5.0)) * exp(-pd * 1.1);
  float wvt = clamp(wv + 0.7 * purr, 0.0, 1.0);

  vec3 add = vec3(0.0);   // body emission (glows, currents): luminance-capped at the end
  vec3 rim = vec3(0.0);   // the thin bright line and glints: allowed to be bright
  vec3 rgb = vec3(0.0);   // body tint (straight, weighted by a)
  float a = 0.0;

  // outer halo bloom, tinted by where on the rim it is
  float halo = exp(-max(d, 0.0) * 5.5) * (0.5 + 0.1 * sin(t * 1.0)) * (1.0 + 0.7 * u_swell + 0.8 * u_gather + 1.0 * u_beat + 0.2 * u_breath);
  add += pal(ang + t * 0.03 + 0.25 * n1) * halo * 0.55;
  // a soft glow where the cursor is
  add += pal(pd * 0.5 - t * 0.2) * exp(-pd * 4.5) * exp(-max(d, 0.0) * 7.0) * u_ptrAmt * (0.25 + 0.4 * u_ptrSpd);

  if (d < 0.5) {
    float inside = smoothstep(0.012, -0.012, d);
    // outward normal from the field's gradient (forward differences: 2 extra map calls)
    float e = 0.006;
    vec2 n = normalize(vec2(map(p + vec2(e, 0.0)) - d, map(p + vec2(0.0, e)) - d) + 1e-5);
    float z = smoothstep(0.0, 0.26, -d);          // 0 at the rim, 1 deep inside
    vec3 n3 = normalize(vec3(n * (1.0 - z), z + 0.05));
    float fres = pow(1.0 - z, 2.5);

    // cytoplasm: domain-warped fbm, ridged into flowing streaks (slow, low frequency)
    vec2 fl2 = p * 1.8 + vec2(t * 0.04, -t * 0.03);
    vec2 wq = vec2(fbm(fl2 + vec2(0.0, t * 0.06)), fbm(fl2 + vec2(5.2, 1.3) - t * 0.05));
    float f = fbm(fl2 + 2.2 * wq + t * 0.025);
    float streak = pow(1.0 - abs(2.0 * f - 1.0), 2.5);

    // ---- the contributors: currents, nuclei, organelles
    float sa = u_gather * (2.2 + 0.5 * sin(t * 0.5)) * exp(-dot(p, p) * 2.2);   // gathered colours swirl
    vec2 fp = p + (wq - 0.5) * 0.5;
    fp = vec2(cos(sa) * fp.x - sin(sa) * fp.y, sin(sa) * fp.x + cos(sa) * fp.y);
    vec2 nz = 0.02 * (vec2(vnoise(p * 4.0 + t * 0.25), vnoise(p * 4.0 - t * 0.25)) - 0.5);
    vec3 tint = vec3(0.0); float tw = 0.0;
    float ndU = 9.0; vec3 ncs = vec3(0.0); float nws = 0.0;
    vec3 emit = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      if (float(i) >= u_n) break;
      vec4 nu = u_nuc[i];
      vec3 c = u_col[i];
      float ge = nu.w;
      float fi = float(i);
      // the coloured current: more energy colours more cytoplasm
      vec2 df = fp - nu.xy;
      float infl = ge * exp(-dot(df, df) / (0.05 + 0.2 * ge));
      tint += c * infl; tw += infl;
      // the nucleus (smooth union, so near ones visibly fuse)
      vec2 dn = p - nu.xy + nz;
      float nd = length(dn) - nu.z;
      ndU = smin(ndU, nd, 0.05);
      float wi = exp(-max(nd, 0.0) * 28.0) * (0.25 + ge);
      ncs += c * wi; nws += wi;
      // max, not sum: overlapping glows keep their own hue instead of piling up to white
      emit = max(emit, c * (exp(-max(nd, 0.0) * 8.0) * 0.45 + exp(-abs(nd) * 40.0) * 0.4) * min(ge, 1.3));
      rim += c * exp(-sq(length(dn - nu.z * vec2(-0.3, 0.4)) / (nu.z * 0.3 + 0.004))) * 0.12 * ge;
      // two organelles orbiting each nucleus
      float o1 = t * 0.35 + fi * 1.9, o2 = -t * 0.27 + fi * 2.7 + 2.0;
      float l1 = length(p - nu.xy - nu.z * 1.9 * vec2(cos(o1), sin(o1)));
      float l2 = length(p - nu.xy - nu.z * 2.5 * vec2(cos(o2), sin(o2)));
      emit = max(emit, c * max(exp(-sq(l1 / (nu.z * 0.3 + 0.006))), 0.7 * exp(-sq(l2 / (nu.z * 0.22 + 0.005)))) * min(0.5 + ge, 1.2) * 0.8);
    }
    vec3 tcol = sat(tint / max(tw, 1e-4), 1.5);
    // gathered colours mix into a swirl of iridescence (hue travels round the palette, never to grey)
    tcol = mix(tcol, pal(ang * 1.5 + length(p) * 2.5 - t * 0.12), 0.5 * u_gather * exp(-dot(p, p) * 3.0));
    // the cursor's pulses sweep the cytoplasm through the palette
    tcol = mix(tcol, pal(pd * 0.7 - t * 0.3 + ang * 0.5), wvt * 0.55);
    float cover = clamp(tw * 1.7, 0.0, 0.95);

    // slow swirling colour bands
    float band = 0.5 + 0.5 * sin(ang * 12.566 + length(p) * 9.0 - t * 0.22 + 3.0 * f);
    vec3 deep = vec3(0.07, 0.03, 0.22);
    vec3 hueBase = pal(band * 0.3 + t * 0.03 + f * 0.7 + length(p) * 0.4 + wvt * 0.25 + 0.1 * wave);
    vec3 hue = mix(hueBase, tcol * (0.7 + 0.45 * streak), cover);
    rgb = mix(deep, hue, 0.25 + 0.55 * band * (0.5 + streak)) * (0.55 + 0.7 * streak);
    rgb *= 1.0 + 0.25 * wvt;
    a = 0.55 + 0.25 * streak + 0.25 * (1.0 - z) * (1.0 - z) + 0.2 * u_swell + 0.12 * u_gather;
    // a bright core where the night's colours have fused
    float core = exp(-sq(length(p) / 0.17)) * (0.5 * u_gather * u_gather + 0.8 * u_beat);
    add += sat(u_core, 1.3) * core * 0.5;

    // thin-film rim: the colour walks round the palette with angle, time, and viewing angle
    float shift = ang * 1.5 + t * 0.05 + fres * 0.7 + n1 * 0.4 + dot(n, vec2(0.7, 0.3)) * 0.3 + pulseE * 0.3 + wvt * 0.15 + 0.08 * wave;
    vec3 film = mix(pal(shift), tcol, cover * 0.45);
    float wet = exp(-abs(d) * 110.0);
    rim += film * (fres * 0.5 + exp(-abs(d) * 80.0) * 0.85) * (1.0 + pulseE * 0.6 + 0.3 * wvt) * min(lit, 1.3) * inside;
    rim += mix(film, vec3(1.0), 0.3) * wet * 0.4;   // the thin bright line
    // the membrane glows softly where the cursor presses on it
    add += film * exp(-pd * 5.0) * exp(-abs(d) * 18.0) * u_ptrAmt * (0.2 + 0.3 * u_ptrSpd) * inside;
    a = max(a, wet);

    // specular: a key light and a coloured back light
    vec3 H1 = normalize(normalize(vec3(-0.45, 0.6, 0.65)) + vec3(0.0, 0.0, 1.0));
    vec3 H2 = normalize(normalize(vec3(0.6, -0.5, 0.55)) + vec3(0.0, 0.0, 1.0));
    rim += vec3(1.0) * pow(max(dot(n3, H1), 0.0), 70.0) * 0.2 * inside;
    rim += pal(shift + 0.5) * pow(max(dot(n3, H2), 0.0), 28.0) * 0.3 * inside;

    // nuclei (fused where they overlap)
    float inner = smoothstep(0.0, 0.07, -d);
    float nm = smoothstep(0.012, -0.012, ndU) * smoothstep(0.0, 0.06, -d);
    vec3 nc = sat(ncs / max(nws, 1e-4), 1.5) * (0.5 + 0.5 * smoothstep(-0.1, 0.0, ndU));
    rgb = mix(rgb, nc, nm * 0.95);
    a = max(a, nm * 0.92);
    add += emit * inner;

    // vacuoles: drifting bubbles that brighten and drift toward the cursor
    for (int i = 0; i < 8; i++) {
      float fi = float(i);
      vec2 c = vec2(sin(t * (0.05 + 0.015 * fi) + fi * 2.39), cos(t * (0.06 + 0.012 * fi) + fi * 1.71))
               * (0.12 + 0.2 * fract(fi * 0.618));
      float rad = 0.022 + 0.03 * fract(fi * 0.37 + 0.2);
      if (i < 2) {   // two big, slowly drifting ones
        c = 0.2 * vec2(sin(t * 0.07 + fi * 3.1), cos(t * 0.05 + fi * 1.9));
        rad = 0.07 + 0.03 * fi;
      }
      vec2 toP = PTR - c;
      float pr = exp(-dot(toP, toP) * 2.5) * u_ptrAmt;
      c += toP * 0.3 * pr;
      float l = length(p - c);
      float ring = exp(-sq((l - rad) / 0.004));
      float fill = smoothstep(rad, rad * 0.2, l);
      vec3 vc = mix(pal(fi * 0.17 + t * 0.03), u_col[i], 0.45);
      add += vc * (ring * 0.9 + fill * 0.16) * (1.0 + 1.3 * pr) * inner;
      rim += vec3(1.0) * exp(-sq(length(p - (c + rad * vec2(-0.35, 0.4))) / (rad * 0.22))) * 0.18 * inner;
    }
    // granules: tiny sparks in a drifting grid
    vec2 gp = p * 13.0 + vec2(t * 0.2, t * 0.14);
    vec2 id = floor(gp), gf = fract(gp) - 0.5;
    float h = hash(id);
    vec2 off = (vec2(hash(id + 1.0), hash(id + 2.0)) - 0.5) * 0.5
             + 0.12 * vec2(sin(t * 0.6 + h * 40.0), cos(t * 0.5 + h * 30.0));
    float gr = exp(-dot(gf - off, gf - off) * 200.0) * (0.5 + 0.5 * sin(t * 1.5 + h * 50.0));
    add += pal(h * 3.0 + t * 0.04) * gr * step(0.82, h) * 0.6 * inner;

    // ---- behaviours (uniform branches: a calm frame skips all of this)
    if (BI > 0.5) {
      float r0 = length(p);
      if (isB(1.0)) {   // bloom: colour flushes out from the nucleus in a ring
        float ringE = exp(-sq((r0 - BP * 1.15) * 5.5)) * BE;
        vec3 bc = sat(pal(ang + r0 * 0.8 - BP * 0.6 + 0.2), 1.3);
        rgb = mix(rgb, bc * 0.9, ringE * 0.5);
        add += bc * ringE * 0.5 * inner;
        rim += bc * ringE * exp(-abs(d) * 40.0) * 0.5 * inside;
      } else if (isB(2.0)) {   // split: a glowing core in the daughter
        float dl = length(p - DC);
        add += sat(pal(0.4 + u_phase * 0.05), 1.3) * exp(-sq(dl / 0.05)) * 0.5 * BE * inner;
      } else if (isB(4.0)) {   // jelly: a flush of brightness on each contraction
        add += pal(ang + u_phase * 0.1) * exp(-r0 * 3.0) * 0.25 * abs(sin(BP * 12.566)) * BE * inner;
      } else if (isB(5.0)) {   // shimmer: a sheen of iridescence sweeps across
        vec2 sd = normalize(u_bdir + 1e-4);
        float sp = dot(p, sd) - (BP * 2.2 - 1.1);
        float band = exp(-sq(sp * 4.5)) * BE;
        vec3 sc = sat(pal(dot(p, vec2(-sd.y, sd.x)) * 1.3 + sp * 0.8 + u_phase * 0.1), 1.4);
        add += sc * band * 0.45 * inside;
        rim += sc * band * exp(-abs(d) * 60.0) * 0.6 * inside;
      }
    }

    a *= inside;
    rgb *= (1.0 + 0.15 * u_swell + 0.1 * u_gather + 0.15 * u_beat) * (1.0 + 0.08 * u_breath);
  }

  // the click: a bright ring of colour from the click point
  if (u_burst.z >= 0.0) {
    vec2 bq = p - u_burst.xy;
    float bd = length(bq);
    float ring = exp(-sq((bd - u_burst.z * 1.25) * 16.0)) * (1.0 - smoothstep(0.0, 1.6, u_burst.z));
    float ins = smoothstep(0.02, -0.02, d);
    add += sat(pal(atan(bq.y, bq.x) / 6.2832 + u_burst.z * 0.5 + bd * 0.3), 1.2) * ring * (0.3 + 0.2 * ins);
  }

  // spores: droplets shed from the membrane that drift off and fade
  for (int i = 0; i < 9; i++) {
    float fi = float(i);
    float cyc = t * 0.08 + fi / 9.0;
    float ph = fract(cyc);
    float sid = floor(cyc) + fi * 7.0;
    float sa2 = hash(vec2(sid, 1.0)) * 6.2832;
    vec2 sp = vec2(cos(sa2), sin(sa2)) * (0.42 + 0.6 * ph)
            + 0.03 * vec2(sin(t * 0.7 + fi), cos(t * 0.5 + fi * 2.0));
    float sr = 0.014 * (1.0 - ph * 0.6) * (0.6 + hash(vec2(sid, 2.0)));
    float sl = length(p - sp);
    float sf = smoothstep(0.0, 0.12, ph) * smoothstep(1.0, 0.6, ph);
    add += pal(sa2 / 6.2832 + t * 0.04) * (exp(-sq(sl / sr)) * 0.9 + exp(-sl * 40.0) * 0.12) * sf;
  }

  // sneeze: a spray of tiny sparkles from the membrane that dissolve
  if (isB(6.0)) {
    float base = atan(u_bdir.y, u_bdir.x);
    float sp0 = max(0.0, BP - 0.3) / 0.7;
    float gate = smoothstep(0.3, 0.36, BP) * (1.0 - sp0 * sp0);
    for (int i = 0; i < 14; i++) {
      float fi = float(i);
      float h1 = hash(vec2(fi, u_bh.w * 17.0)), h2 = hash(vec2(fi + 31.0, u_bh.w * 17.0 + 3.0));
      float an = base + (h1 - 0.5) * 1.5;
      float dist = 0.38 + (0.25 + 0.85 * h2) * (1.0 - (1.0 - sp0) * (1.0 - sp0));
      vec2 spk = vec2(cos(an), sin(an)) * dist + vec2(0.0, -0.12 * sp0 * sp0 * h2);
      float sl = length(p - spk), sr = 0.012 * (0.5 + h2);
      float tw = 0.6 + 0.4 * sin(u_phase * 14.0 + fi * 5.0);
      add += sat(pal(h1 * 2.0 + u_phase * 0.1), 1.3) * (exp(-sq(sl / sr)) * 1.1 + exp(-sl * 35.0) * 0.1) * gate * tw;
    }
  }

  // keep the colour: pull emission toward saturation, then cap it well short of white
  // Keep the colour, never the white: saturate the emission, cap the body's total luminance
  // (hue-preserving, so a bright place gets richer rather than paler), then lay the thin rim on top.
  add = sat(add, 1.3);
  vec3 body = rgb * a + add;
  float bl = dot(body, vec3(0.3, 0.59, 0.11));
  body *= min(1.0, 0.62 * (1.0 + 0.1 * u_breath) / max(bl, 1e-4));
  rim = min(rim, 0.85);
  float alpha = clamp(a + 0.35 * max(add.r, max(add.g, add.b)) + 0.3 * max(rim.r, max(rim.g, rim.b)), 0.0, 1.0);
  vec4 col = vec4(body + rim, alpha);
  col *= smoothstep(0.0, 0.25, u_grow);
  col.rgb += (hash(gl_FragCoord.xy + t) - 0.5) / 255.0 * col.a;   // dither the long halo gradient
  gl_FragColor = col;
}
`;

function glBackend(canvas: HTMLCanvasElement, onLost: () => void): Backend {
  const gl = canvas.getContext("webgl", {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    powerPreference: "high-performance",
    // A software renderer would run this at a slideshow pace; the 2D fallback is kinder.
    failIfMajorPerformanceCaveat: true,
  });
  if (!gl) throw new Error("no webgl");
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      gl.deleteShader(s);
      throw new Error("shader: " + log);
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "a");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const U = (n: string) => gl.getUniformLocation(prog, n);
  const u = {
    time: U("u_time"), res: U("u_res"), unit: U("u_unit"), centre: U("u_centre"),
    ptr: U("u_ptr"), ptrAmt: U("u_ptrAmt"), ptrSpd: U("u_ptrSpd"), purr: U("u_purr"),
    pulse: U("u_pulse"), surge: U("u_surge"), dir: U("u_surgeDir"), swell: U("u_swell"), grow: U("u_grow"),
    gather: U("u_gather"), beat: U("u_beat"), flinch: U("u_flinch"), burst: U("u_burst"), core: U("u_core"),
    n: U("u_n"), nuc: U("u_nuc"), col: U("u_col"), pods: U("u_pods"),
    hue: U("u_hue"), phase: U("u_phase"), breath: U("u_breath"), bh: U("u_bh"), bdir: U("u_bdir"),
  };
  gl.clearColor(0, 0, 0, 0);
  const lost = (e: Event) => { e.preventDefault(); onLost(); };
  canvas.addEventListener("webglcontextlost", lost);
  const nucBuf = new Float32Array(MAXC * 4), colBuf = new Float32Array(MAXC * 3);
  let cw = 1, ch = 1;

  return {
    resize(w, h) { canvas.width = w; canvas.height = h; cw = w; ch = h; gl.viewport(0, 0, w, h); },
    draw(f) {
      if (gl.isContextLost()) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      nucBuf.set(f.nuc.subarray(0, Math.min(f.nuc.length, nucBuf.length)));
      colBuf.set(f.col.subarray(0, Math.min(f.col.length, colBuf.length)));
      gl.uniform1f(u.time, f.t);
      gl.uniform2f(u.res, cw, ch);
      gl.uniform1f(u.unit, f.unit);
      gl.uniform2f(u.centre, f.cx, f.cy);
      gl.uniform2f(u.ptr, f.ptrX, f.ptrY);
      gl.uniform1f(u.ptrAmt, f.ptrAmt);
      gl.uniform1f(u.ptrSpd, f.ptrSpd);
      gl.uniform1f(u.purr, f.purr);
      gl.uniform1f(u.pulse, f.pulse);
      gl.uniform1f(u.surge, f.surge);
      gl.uniform2f(u.dir, f.sx, f.sy);
      gl.uniform1f(u.swell, f.swell);
      gl.uniform1f(u.grow, f.grow);
      gl.uniform1f(u.gather, f.gather);
      gl.uniform1f(u.beat, f.beat);
      gl.uniform1f(u.flinch, f.flinch);
      gl.uniform3f(u.burst, f.burstX, f.burstY, f.burstAge);
      gl.uniform3f(u.core, f.core[0], f.core[1], f.core[2]);
      gl.uniform1f(u.n, f.n);
      gl.uniform4fv(u.nuc, nucBuf);
      gl.uniform3fv(u.col, colBuf);
      gl.uniform4fv(u.pods, f.pods);
      gl.uniform1f(u.hue, f.hue);
      gl.uniform1f(u.phase, f.phase);
      gl.uniform1f(u.breath, f.breath);
      gl.uniform4f(u.bh, f.bid, f.be, f.bp, f.bseed);
      gl.uniform2f(u.bdir, f.bdx, f.bdy);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", lost);
      gl.deleteBuffer(buf); gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}

// ----------------------------------------------------------- canvas-2D backup

function angDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** A simplified cell: same colours and energies, no cytoplasm shading. */
function canvas2dBackend(canvas: HTMLCanvasElement): Backend {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  const g = ctx;
  let W = 1, H = 1;
  return {
    resize(w, h) { canvas.width = w; canvas.height = h; W = w; H = h; },
    draw(f) {
      const t = f.t;
      const pal = (x: number) => palRamp(x + f.hue);   // the drifting palette
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, W, H);
      g.setTransform(f.unit, 0, 0, -f.unit, W / 2, H / 2);   // shader units, y up
      g.globalAlpha = sstep(0, 0.25, f.grow);
      g.translate(f.cx, f.cy);
      const gs = Math.max(f.grow, 0.02);
      g.scale(gs, gs);

      // the group's mean colour, weighted by glow
      let mr = 0, mg = 0, mb = 0, mw = 0;
      for (let i = 0; i < f.n; i++) {
        const w = f.nuc[i * 4 + 3];
        mr += f.col[i * 3] * w; mg += f.col[i * 3 + 1] * w; mb += f.col[i * 3 + 2] * w; mw += w;
      }
      const mean = mw > 0 ? [mr / mw, mg / mw, mb / mw] : pal(t * 0.04);

      const jelly = f.bid === 4 ? 0.03 * f.be * Math.sin(f.bp * 12.566) : 0;
      const R = 0.4 + 0.016 * Math.sin(t * 0.7) + f.swell * 1.4 + 0.05 * f.gather + 0.045 * f.beat
        - 0.06 * (f.flinch >= 0 ? Math.exp(-f.flinch * 2.8) : 0) - jelly + 0.02 * f.breath;
      const halo = g.createRadialGradient(0, 0, 0.2, 0, 0, 1.0);
      halo.addColorStop(0, rgba(mean, 0.3 + 0.2 * f.gather));
      halo.addColorStop(0.5, rgba(pal(t * 0.04 + 0.4), 0.1));
      halo.addColorStop(1, rgba(pal(t * 0.04 + 0.4), 0));
      g.fillStyle = halo;
      g.fillRect(-2.5, -2.5, 5, 5);

      // outline: the shader's sines, plus a bump for each pseudopod
      const ap = Math.atan2(f.ptrY, f.ptrX), as = Math.atan2(f.sy, f.sx);
      g.beginPath();
      const N = 120;
      for (let i = 0; i <= N; i++) {
        const a = (i / N) * Math.PI * 2;
        let r = R + 0.03 * Math.sin(a * 3 + t * 0.35) + 0.02 * Math.sin(a * 5 - t * 0.45 + 1.7)
          + 0.01 * Math.sin(a * 8 + t * 0.6);
        for (let k = 0; k < NPOD; k++) {
          const px = f.pods[k * 4], py = f.pods[k * 4 + 1], rad = f.pods[k * 4 + 2];
          const len = Math.hypot(px, py), bump = len + rad * 0.7 - R;
          if (bump > 0) r += bump * Math.exp(-(angDiff(a, Math.atan2(py, px)) ** 2) / (2 * Math.max(rad / (len + 0.01), 0.1) ** 2));
        }
        r += 0.12 * f.ptrAmt * Math.exp(-(angDiff(a, ap) ** 2) / 0.2);
        r += 0.55 * f.surge * Math.exp(-(angDiff(a, as) ** 2) / 0.05);
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath();
      const body = g.createRadialGradient(f.ptrX * 0.08, f.ptrY * 0.08, 0, 0, 0, R + 0.2);
      body.addColorStop(0, rgba(mean, 0.5));
      body.addColorStop(0.6, rgba(pal(t * 0.03 + 0.2), 0.3));
      body.addColorStop(1, rgba(pal(t * 0.03 + 0.7), 0.7));
      g.fillStyle = body;
      g.fill();
      g.lineWidth = 0.014;
      const cg = (g as CanvasRenderingContext2D & { createConicGradient?: (a: number, x: number, y: number) => CanvasGradient })
        .createConicGradient?.(t * 0.2, 0, 0);
      if (cg) {
        for (let i = 0; i <= 8; i++) cg.addColorStop(i / 8, rgba(pal(i / 8 + t * 0.05), 0.95));
        g.strokeStyle = cg;
      } else g.strokeStyle = rgba(pal(t * 0.05), 0.9);
      g.stroke();

      if (f.bid === 1) {   // bloom: a ring of colour spreading outward
        g.lineWidth = 0.05;
        g.strokeStyle = rgba(pal(f.bp * 0.6 + 0.2), 0.45 * f.be);
        g.beginPath(); g.arc(0, 0, f.bp * 1.15, 0, Math.PI * 2); g.stroke();
      }

      // the contributors: a glowing nucleus each, sized and lit by share
      for (let i = 0; i < f.n; i++) {
        const x = f.nuc[i * 4], y = f.nuc[i * 4 + 1], r = f.nuc[i * 4 + 2], ge = f.nuc[i * 4 + 3];
        const c = [f.col[i * 3], f.col[i * 3 + 1], f.col[i * 3 + 2]];
        const ng = g.createRadialGradient(x, y, 0, x, y, r * 2.4);
        ng.addColorStop(0, rgba(c, Math.min(0.85, 0.3 + 0.4 * ge)));
        ng.addColorStop(1, rgba(c, 0));
        g.fillStyle = ng;
        g.beginPath(); g.arc(x, y, r * 2.4, 0, Math.PI * 2); g.fill();
        g.fillStyle = rgba(c, 0.9);
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        const o = t * 0.35 + i * 1.9;
        g.fillStyle = rgba(c, 0.8);
        g.beginPath(); g.arc(x + r * 1.9 * Math.cos(o), y + r * 1.9 * Math.sin(o), r * 0.28, 0, Math.PI * 2); g.fill();
      }
      if (f.gather > 0.01 || f.beat > 0.01) {
        const cg2 = g.createRadialGradient(0, 0, 0, 0, 0, 0.22);
        const k = Math.min(1, 0.5 * f.gather * f.gather + 0.8 * f.beat);
        cg2.addColorStop(0, rgba(f.core, 0.8 * k)); cg2.addColorStop(1, rgba(f.core, 0));
        g.fillStyle = cg2;
        g.beginPath(); g.arc(0, 0, 0.22, 0, Math.PI * 2); g.fill();
      }

      // the cursor's glow and the click ring
      if (f.ptrAmt > 0.01) {
        const pg = g.createRadialGradient(f.ptrX, f.ptrY, 0, f.ptrX, f.ptrY, 0.35);
        pg.addColorStop(0, rgba(pal(t * 0.2), 0.3 * f.ptrAmt)); pg.addColorStop(1, rgba(pal(t * 0.2), 0));
        g.fillStyle = pg;
        g.beginPath(); g.arc(f.ptrX, f.ptrY, 0.35, 0, Math.PI * 2); g.fill();
      }
      if (f.burstAge >= 0 && f.burstAge < 1.6) {
        g.lineWidth = 0.025;
        g.strokeStyle = rgba(pal(f.burstAge * 0.5), 0.8 * (1 - f.burstAge / 1.6));
        g.beginPath(); g.arc(f.burstX, f.burstY, f.burstAge * 1.25, 0, Math.PI * 2); g.stroke();
      }

      g.lineWidth = 0.005;
      for (let i = 0; i < 6; i++) {
        const cyc = t * 0.05 + i / 6, ph = cyc - Math.floor(cyc), a = i * 2.1 + Math.floor(cyc) * 1.3;
        g.fillStyle = rgba(pal(a / 6.28 + t * 0.05), 0.8 * Math.sin(ph * Math.PI));
        g.beginPath(); g.arc(Math.cos(a) * (0.5 + 0.55 * ph), Math.sin(a) * (0.5 + 0.55 * ph), 0.014, 0, Math.PI * 2); g.fill();
      }
    },
    dispose() { /* nothing held */ },
  };
}

// --------------------------------------------------------------- controller

const easeOut = (x: number) => 1 - (1 - x) ** 3;
const easeInOut = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
/** Exponential approach rate -> per-frame blend factor. */
const rate = (dt: number, r: number) => 1 - Math.exp(-dt * r);

/** Zipf-ish shares for when the teaser has none. */
const defaultWeights = (n: number) => Array.from({ length: n }, (_, i) => 1 / (i + 1.6));

/** A very slow wandering number in -1..1: three incommensurate sines. */
const drift = (t: number, s: number) =>
  clamp((Math.sin(t * 0.043 + s) + 0.6 * Math.sin(t * 0.071 + s * 2.3 + 1) + 0.4 * Math.sin(t * 0.117 + s * 3.7 + 2)) / 1.6, -1, 1);

export function createAmoeba(host: HTMLElement, opts: AmoebaOptions): Amoeba {
  let canvas: HTMLCanvasElement;
  let backend: Backend;
  let kind: "webgl" | "canvas2d" = "webgl";
  let disposed = false;

  const mount = (prefer2d: boolean) => {
    canvas = document.createElement("canvas");
    canvas.className = "amoeba-canvas";
    host.appendChild(canvas);
    if (!prefer2d) {
      try { backend = glBackend(canvas, onLost); kind = "webgl"; return; }
      catch (e) {
        console.warn("amoeba: WebGL unavailable, using canvas fallback.", e);
        canvas.remove();
        canvas = document.createElement("canvas");   // a canvas that has asked for GL cannot give a 2D context
        canvas.className = "amoeba-canvas";
        host.appendChild(canvas);
      }
    }
    backend = canvas2dBackend(canvas);
    kind = "canvas2d";
  };
  // Context loss: swap in the 2D canvas rather than leave a hole.
  function onLost() {
    if (disposed) return;
    backend.dispose(); canvas.remove();
    mount(true); fit(); frame();
  }

  // ---- geometry: shader units are tied to the click target, so the body stays the same size on any screen
  let W = 1, H = 1, unitPx = 300, halfW = 1.6, halfH = 0.93, cvW = 1;
  let res = (window.devicePixelRatio || 1) > 1.25 ? 0.6 : 0.75;   // canvas px per CSS px, lowered by the frame guard
  const fit = () => {
    W = host.clientWidth || window.innerWidth; H = host.clientHeight || window.innerHeight;
    const hero = opts.hero() || Math.min(0.52 * H, 0.62 * W);
    unitPx = Math.max(60, hero) / 0.96;
    halfW = W / (2 * unitPx); halfH = H / (2 * unitPx);
    let k = kind === "webgl" ? res : Math.min(res, 0.5);
    k = Math.min(k, 1500 / Math.max(W, H));
    const cw = Math.max(64, Math.round(W * k)), ch = Math.max(64, Math.round(H * k));
    cvW = cw;
    backend.resize(cw, ch);
  };

  // ---- the colours
  const nx = new Float32Array(MAXC), ny = new Float32Array(MAXC);
  const nvx = new Float32Array(MAXC), nvy = new Float32Array(MAXC);
  const nr = new Float32Array(MAXC), nglow = new Float32Array(MAXC);
  const nph = new Float32Array(MAXC), nprox = new Float32Array(MAXC);
  const colour = new Float32Array(MAXC * 3);
  for (let i = 0; i < MAXC; i++) { const c = personRgb(i); colour.set(c, i * 3); }
  let n = 0;
  let energy: number[] = [];            // share / largest share, 0..1
  const nucOut = new Float32Array(MAXC * 4);

  // ---- animation state
  let t = 7.3, growT = opts.reduced ? 99 : 0;
  let px = 0, py = 0, tx = 0, ty = 0, ltx = 0, lty = 0, amt = 0, spd = 0, purr = 0, hasPtr = false;
  let pulseAt = -1, nextShimmer = 8;
  let surgeAt = -1, sx = 0, sy = 1;
  let burstAt = -1, bx = 0, by = 0;
  let flinchAt = -1;
  let cx = 0, cy = 0, lastDx = 1e9, lastDy = 1e9;
  const core: [number, number, number] = [1, 1, 1];

  // ---- pseudopods: sprung, so no jump is ever visible
  const pods = new Float32Array(NPOD * 4);
  const podPos = new Float32Array(NPOD * 2), podVel = new Float32Array(NPOD * 2), podRad = new Float32Array(NPOD);

  // ---- colour life and behaviours
  const sched = createScheduler();
  let phase = 0, breath = 0, hue = 0, hueTarget = 0, nextHue = 20 + Math.random() * 10;
  let bdx = 0, bdy = 0, btx = 0, bty = 0, lastBid = 0;

  /** Slow colour drift: brightness breathing, and the whole palette sliding on to another every ~30 s. */
  function driftColour(dt: number) {
    phase += dt;
    breath = 0.6 * Math.sin(phase * 0.55) + 0.4 * Math.sin(phase * 0.23 + 1);
    if (phase >= nextHue) { hueTarget += 0.12 + Math.random() * 0.2; nextHue = phase + 22 + Math.random() * 14; }
    hue += (hueTarget - hue) * rate(dt, 0.25);
  }

  const TITLE_PX = 190, HINT_PX = 190;   // the bands of the page the body keeps its limbs out of
  /** Longest reach `want` along `ang` that stays on screen and out of the title and hint bands. */
  function fitLen(ang: number, want: number) {
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let L = want;
    if (ux > 1e-3) L = Math.min(L, (halfW - 0.15 - cx) / ux); else if (ux < -1e-3) L = Math.min(L, (halfW - 0.15 + cx) / -ux);
    if (uy > 1e-3) L = Math.min(L, (halfH - 0.15 - TITLE_PX / unitPx - cy) / uy);
    else if (uy < -1e-3) L = Math.min(L, (halfH - 0.15 - HINT_PX / unitPx + cy) / -uy);
    return Math.max(0.3, L);
  }

  /** A behaviour just began: pick where it points. */
  function aim(name: BehaviourName | null) {
    const rnd = Math.random;
    if (name === "split") {
      const right = rnd() < (halfW - cx) / (2 * halfW);
      const ang = (right ? 0 : Math.PI) + (rnd() - 0.5) * 0.7;
      const L = fitLen(ang, 0.62);
      btx = Math.cos(ang) * L; bty = Math.sin(ang) * L;
    } else if (name === "reach") {
      const ang = -Math.PI / 2 + (rnd() - 0.5) * Math.PI * 1.4;   // down and to the sides, away from the title
      const L = fitLen(ang, 0.85);
      btx = Math.cos(ang) * L; bty = Math.sin(ang) * L;
    } else if (name === "shimmer" || name === "sneeze") {
      const ang = name === "sneeze" ? -Math.PI / 2 + (rnd() - 0.5) * 2.4 : rnd() * Math.PI * 2;
      btx = Math.cos(ang); bty = Math.sin(ang);
    } else { btx = bty = 0; }
  }

  // ---- the night
  let cycleStart = t, cycleLen = 14 + Math.random() * 6;
  let members: number[] = [];
  let recent = new Set<number>();
  let beatAt = -1, beatDone = false, captionOn = false;
  let gather = 0, beat = 0;

  const homePos = (i: number): [number, number] => {
    const rank = (i + 0.5 * ((i * 0.618) % 1)) / Math.max(n, 1);
    const rho = (0.08 + 0.18 * Math.pow(rank, 0.8)) * (1 + 0.16 * Math.sin(t * 0.13 + i * 1.3));
    const a = i * 2.39996 + t * (i % 2 ? 1 : -1) * (0.05 + 0.03 * ((i * 0.37) % 1));
    return [Math.cos(a) * rho + 0.03 * Math.sin(t * 0.09 + i * 2.1), Math.sin(a) * rho + 0.03 * Math.cos(t * 0.07 + i * 1.3)];
  };
  const baseR = (i: number) => Math.max(0.04, 0.135 * Math.sqrt(energy[i]));
  const baseGlow = (i: number) => 0.15 + 0.85 * energy[i];

  function pickNight() {
    const k = Math.min(n, 4 + Math.floor(Math.random() * 5));
    const pool = Array.from({ length: n }, (_, i) => i);
    const chosen: number[] = [];
    while (chosen.length < k && pool.length) {
      const w = pool.map((i) => (0.35 + energy[i]) * (recent.has(i) ? 0.35 : 1));
      let r = Math.random() * w.reduce((a, b) => a + b, 0), j = 0;
      for (; j < pool.length - 1; j++) { r -= w[j]; if (r <= 0) break; }
      chosen.push(pool.splice(j, 1)[0]);
    }
    members = chosen; recent = new Set(chosen);
  }

  function setWeights(w: number[]) {
    let ws = w.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a).slice(0, MAXC);
    if (!ws.length) ws = defaultWeights(10);
    energy = ws.map((x) => x / ws[0]);
    const old = n;
    n = ws.length;
    for (let i = old; i < n; i++) {
      const [hx, hy] = homePos(i);
      nx[i] = hx; ny[i] = hy; nvx[i] = nvy[i] = 0; nph[i] = i * 1.7;
      nr[i] = baseR(i); nglow[i] = baseGlow(i);
    }
    for (let i = 0; i < n; i++) if (i < old) { nr[i] = nr[i] || baseR(i); }
    pickNight();
  }
  setWeights(defaultWeights(10));

  const wanderAmp = () => (opts.reduced ? 0 : easeInOut(clamp01(growT / 5)));

  /** Advance every driver by dt. `snap` jumps springs to their targets (first frame, reduced motion). */
  function update(dt: number, snap: boolean) {
    // pointer, smoothed so a twitchy mouse never reaches the picture
    const k = rate(dt, 5);
    px += (tx - px) * k; py += (ty - py) * k;
    amt += ((hasPtr ? 1 : 0) - amt) * rate(dt, 3);
    if (dt > 0) {
      const sp = Math.hypot(tx - ltx, ty - lty) / dt;
      const target = hasPtr ? clamp01(sp / 2.5) : 0;
      spd += (target - spd) * rate(dt, target > spd ? 8 : 2.5);
    }
    ltx = tx; lty = ty;

    // the centre wanders: about +-12% of the viewport, very slowly
    const wa = wanderAmp();
    cx = 0.12 * 2 * halfW * drift(t, 0.7) * wa;
    cy = 0.12 * 2 * halfH * drift(t, 4.1) * wa;
    if (opts.onCentre) {
      const dx = cx * unitPx, dy = -cy * unitPx;
      if (Math.abs(dx - lastDx) > 0.05 || Math.abs(dy - lastDy) > 0.05) { lastDx = dx; lastDy = dy; opts.onCentre(dx, dy); }
    }
    const rx = px - cx, ry = py - cy;                 // pointer relative to the body
    const over = hasPtr && Math.hypot(rx, ry) < 0.6;
    const purrT = over ? 1 - sstep(0.08, 0.4, spd) : 0;
    purr += (purrT - purr) * rate(dt, purrT > purr ? 0.7 : 2.5);

    // behaviours: one at a time, none once the click-through has begun or under reduced motion
    if (!opts.reduced && surgeAt < 0) {
      sched.step(dt);
      if (sched.id !== lastBid) { lastBid = sched.id; aim(sched.name); }
      if (sched.name === "reach") {
        const pl2 = Math.hypot(rx, ry);
        if (hasPtr && amt > 0.3 && pl2 < 1.6 && pl2 > 0.05) {   // the cursor is near: reach for it
          const ang = Math.atan2(ry, rx), L = fitLen(ang, clamp(pl2 * 0.9, 0.5, 0.9));
          btx = Math.cos(ang) * L; bty = Math.sin(ang) * L;
        }
      }
      const kb = snap ? 1 : rate(dt, 4);
      bdx += (btx - bdx) * kb; bdy += (bty - bdy) * kb;
    }

    const fa = flinchAt < 0 ? 9 : t - flinchAt;
    const fe = Math.exp(-fa * 2.8) * sstep(0, 0.1, fa);

    // the night: gather, fuse, one heartbeat, disperse
    if (opts.reduced) { gather = 0; beat = 0; }
    else {
      if (t - cycleStart >= cycleLen) {
        cycleStart = t; cycleLen = 14 + Math.random() * 6; pickNight(); beatDone = false;
      }
      const u = (t - cycleStart) / cycleLen;
      gather = sstep(0.1, 0.46, u) * (1 - sstep(0.56, 0.9, u));
      if (!beatDone && u >= 0.5) { beatAt = t; beatDone = true; }
      const tau = beatAt < 0 ? -1 : t - beatAt;
      beat = tau < 0 ? 0 : sstep(0, 0.18, tau) * Math.exp(-tau * 2.6);
      if (!captionOn && gather > 0.15) { captionOn = true; opts.onNight?.(members.length); }
      else if (captionOn && gather < 0.06 && u > 0.5) { captionOn = false; opts.onNight?.(0); }
    }

    // nuclei: springs toward home (drifting), or toward the fuse point if in tonight's gathering
    let cr = 0, cg = 0, cb = 0, cw = 0;
    const k2 = rate(dt, 6), k3 = rate(dt, 3.5);
    for (let i = 0; i < n; i++) {
      const mi = members.indexOf(i);
      const mem = mi >= 0 ? 1 : 0;
      let [hx, hy] = homePos(i);
      hx *= 1 + 0.3 * gather * (1 - mem); hy *= 1 + 0.3 * gather * (1 - mem);
      let tgx = hx, tgy = hy;
      if (mem) {
        const a = (mi / members.length) * Math.PI * 2 + t * 0.8, rr = 0.045 + 0.02 * (mi % 3);
        const gx = Math.cos(a) * rr, gy = Math.sin(a) * rr;
        tgx = hx + (gx - hx) * gather; tgy = hy + (gy - hy) * gather;
        const wgt = energy[i] + 0.2;
        cr += colour[i * 3] * wgt; cg += colour[i * 3 + 1] * wgt; cb += colour[i * 3 + 2] * wgt; cw += wgt;
      }
      // organelles drift toward the cursor, and brighten
      const dxp = rx - tgx, dyp = ry - tgy;
      const prox = amt * Math.exp(-(dxp * dxp + dyp * dyp) * 3);
      tgx += dxp * 0.22 * prox; tgy += dyp * 0.22 * prox;
      nprox[i] += (prox - nprox[i]) * k3;
      if (snap) { nx[i] = tgx; ny[i] = tgy; nvx[i] = nvy[i] = 0; }
      else {
        const w = 1.7;                                   // critically damped spring
        nvx[i] += (w * w * (tgx - nx[i]) - 2 * w * nvx[i]) * dt; nx[i] += nvx[i] * dt;
        nvy[i] += (w * w * (tgy - ny[i]) - 2 * w * nvy[i]) * dt; ny[i] += nvy[i] * dt;
      }
      nph[i] += dt * (0.7 + 2.6 * energy[i]);            // pulse rate scales with share
      const tr = baseR(i) * (1 + 0.08 * Math.sin(nph[i])) * (1 + 0.28 * gather * mem + 0.12 * beat * mem);
      const tgl = baseGlow(i) * (0.8 + 0.2 * Math.sin(nph[i] + 1)) * (1 + 0.9 * gather * mem + 0.6 * beat * mem)
        * (1 + 0.9 * nprox[i]) * (1 - 0.18 * gather * (1 - mem)) * (1 - 0.4 * fe);
      if (snap) { nr[i] = tr; nglow[i] = tgl; } else { nr[i] += (tr - nr[i]) * k2; nglow[i] += (tgl - nglow[i]) * k3; }
    }
    if (cw > 0) {
      const kc = rate(dt, 3);
      core[0] += (cr / cw - core[0]) * kc; core[1] += (cg / cw - core[1]) * kc; core[2] += (cb / cw - core[2]) * kc;
    }

    // pseudopods: slow, rarely very long; the one facing the cursor reaches for it
    const pl = Math.hypot(rx, ry), dirx = rx / (pl || 1), diry = ry / (pl || 1);
    for (let i = 0; i < NPOD; i++) {
      const ang = i * 1.2566 + t * (i % 2 ? 1 : -1) * (0.035 + 0.02 * i) + 0.8 * Math.sin(t * 0.11 + i * 2.1);
      const env = 0.5 + 0.5 * Math.sin(t * (0.11 + 0.045 * i) + i * 2.3);
      const ext = env * env * env;
      const reach = (0.36 + 0.52 * ext) * (1 - 0.6 * fe);
      let gx = Math.cos(ang) * reach, gy = Math.sin(ang) * reach;
      let rad = 0.075 + 0.045 * env;
      let extN = ext;
      if (hasPtr && pl > 0.05) {
        const lean = amt * sstep(0.5, 0.95, Math.cos(ang) * dirx + Math.sin(ang) * diry);
        const tip = clamp(pl * 0.8, 0.42, 0.85) * (1 - 0.6 * fe);
        gx += (dirx * tip - gx) * lean * 0.85; gy += (diry * tip - gy) * lean * 0.85;
        extN = Math.max(extN, lean * clamp((tip - 0.4) / 0.45, 0, 1));
      }
      // keep the tip inside the viewport (the fade is beyond the visible edge)
      const m = 0.14 + rad;
      const lx = Math.max(0.2, halfW - m);
      const yTop = Math.max(0.2, halfH - m - TITLE_PX / unitPx);     // keep arms off the title (two lines now)...
      const yBot = Math.max(0.2, halfH - m - HINT_PX / unitPx);     // ...and off the hint and stats
      gx = clamp(gx + cx, -lx, lx) - cx; gy = clamp(gy + cy, -yBot, yTop) - cy;
      const o = i * 2;
      if (snap) { podPos[o] = gx; podPos[o + 1] = gy; podVel[o] = podVel[o + 1] = 0; podRad[i] = rad; }
      else {
        const w = 1.5;
        podVel[o] += (w * w * (gx - podPos[o]) - 2 * w * podVel[o]) * dt; podPos[o] += podVel[o] * dt;
        podVel[o + 1] += (w * w * (gy - podPos[o + 1]) - 2 * w * podVel[o + 1]) * dt; podPos[o + 1] += podVel[o + 1] * dt;
        podRad[i] += (rad - podRad[i]) * rate(dt, 2);
      }
      pods[i * 4] = podPos[o]; pods[i * 4 + 1] = podPos[o + 1]; pods[i * 4 + 2] = podRad[i];
      pods[i * 4 + 3] = extN;
    }
  }

  const frame = () => {
    const pulseK = pulseAt < 0 ? -1 : (t - pulseAt) / 2.4;
    const sk = surgeAt < 0 ? 0 : t - surgeAt;
    for (let i = 0; i < n; i++) {
      nucOut[i * 4] = nx[i]; nucOut[i * 4 + 1] = ny[i]; nucOut[i * 4 + 2] = nr[i]; nucOut[i * 4 + 3] = nglow[i];
    }
    const ba = burstAt < 0 ? -1 : t - burstAt;
    const fa = flinchAt < 0 ? -1 : t - flinchAt;
    const bOn = !opts.reduced && surgeAt < 0;
    backend.draw({
      t, w: cvW, h: 0, unit: unitPx * (cvW / W), cx, cy,
      ptrX: px - cx, ptrY: py - cy, ptrAmt: amt, ptrSpd: spd, purr,
      pulse: pulseK > 1 ? -1 : pulseK,
      surge: easeOut(clamp01(sk / 0.55)), sx, sy,
      swell: surgeAt < 0 ? 0 : easeInOut(clamp01((sk - 0.25) / 1.1)),
      grow: opts.reduced ? 1 : easeOut(clamp01(growT / 1.2)) * 0.98 + 0.02 * clamp01(growT * 8),
      gather, beat, flinch: fa > 3 ? -1 : fa,
      burstX: bx, burstY: by, burstAge: ba > 2 ? -1 : ba,
      core, n, nuc: nucOut, col: colour, pods, halfW, halfH,
      hue, phase, breath,
      bid: bOn ? sched.id : 0, be: bOn ? sched.env : 0, bp: bOn ? sched.progress : 0, bseed: sched.seed, bdx, bdy,
    });
  };

  // ---- loop
  let raf = 0, last = 0, active = true;
  // Frame guard. Display refresh sets the floor on frame time (16.7 ms at 60 Hz),
  // so "too slow" is judged against the fastest interval seen, not a fixed 14 ms.
  let ema = 0, floor = 1e9, seen = 0, cooldown = 0;

  const tick = (now: number) => {
    raf = 0;
    if (!running()) return;
    const raw = now - last;
    // A 120/144 Hz display gets no benefit from a heavier-than-60 fps shader.
    if (raw < (opts.reduced ? 100 : MIN_GAP)) { raf = requestAnimationFrame(tick); return; }
    const dt = Math.min(raw / 1000, 0.1);
    last = now;
    driftColour(dt);
    if (opts.reduced) {   // nothing moves but the colour, slowly (~10 fps is plenty)
      frame();
      raf = requestAnimationFrame(tick);
      return;
    }
    t += dt; growT += dt;
    if (t >= nextShimmer) { pulseAt = t; nextShimmer = t + 15 + Math.random() * 15; }
    update(dt, false);
    frame();

    if (raw > 0 && raw < 200) {
      seen++;
      ema = ema ? ema * 0.9 + raw * 0.1 : raw;
      if (seen > 5) floor = Math.min(floor, raw);
      if (cooldown > 0) cooldown--;
      else if (seen > 45 && ema > Math.max(14, floor * 1.5) && res > 0.4) {
        res = Math.max(0.4, res - 0.1);
        cooldown = 60; ema = 0; fit();
      }
    }
    raf = requestAnimationFrame(tick);
  };
  const running = () => !disposed && active && !document.hidden;
  const sync = () => {
    if (running() && !raf) { last = performance.now(); raf = requestAnimationFrame(tick); }
    else if (!running() && raf) { cancelAnimationFrame(raf); raf = 0; }
  };

  mount(false);
  fit();
  update(0, true);
  const ro = new ResizeObserver(() => { fit(); update(0, opts.reduced); if (!raf) frame(); });
  ro.observe(host);
  document.addEventListener("visibilitychange", sync);
  sync();
  frame();

  /** Viewport -1..1 (y up) to absolute shader units. */
  const toUnits = (x: number, y: number): [number, number] => [x * halfW, y * halfH];

  return {
    get backend() { return kind; },
    setPointer(x, y) { [tx, ty] = toUnits(x, y); if (!hasPtr) { px = tx; py = ty; ltx = tx; lty = ty; } hasPtr = true; },
    clearPointer() { hasPtr = false; },
    burst(x, y) {
      const [ux, uy] = toUnits(x, y);
      bx = ux - cx; by = uy - cy; burstAt = t;
      if (opts.reduced) frame();
    },
    flinch() { flinchAt = t; if (opts.reduced) frame(); },
    surge(x, y) {
      const [ux, uy] = toUnits(x, y);
      const dx = ux - cx, dy = uy - cy, l = Math.hypot(dx, dy) || 1;
      sx = dx / l; sy = dy / l;
      if (!Number.isFinite(sx) || (dx === 0 && dy === 0)) { sx = 0; sy = 1; }
      surgeAt = t; pulseAt = t;
      if (opts.reduced) frame();
    },
    setWeights(w) { setWeights(w); update(0, opts.reduced); if (!raf) frame(); },
    behave(name) {
      if (opts.reduced || surgeAt >= 0 || !(BEHAVIOURS as readonly string[]).includes(name)) return false;
      sched.trigger(name as BehaviourName);
      return true;
    },
    setActive(a) { active = a; sync(); },
    dispose() {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener("visibilitychange", sync);
      backend.dispose();
      canvas.remove();
    },
  };
}
