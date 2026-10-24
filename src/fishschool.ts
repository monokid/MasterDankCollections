/** Schools of arrows for the background sky: pure parameters and motion, no canvas.
 *
 *  A school is one record of numbers rolled once at spawn (`spawnSchool`, which fills a
 *  pooled record in place); every member's pose is then a pure function of the school,
 *  the member index and the school's age (`memberPose`), deterministic from the seed.
 *
 *  Motion: the school's head travels a straight line from off-screen right to off-screen
 *  left. Unless it is a "straight" one, the whole school sways sideways (a sine, with a
 *  phase lag along its length so it ripples), swings in slow wide turns, its spacing
 *  breathes, and each member drifts a little along and across. Depth (0 far .. 1 near)
 *  sets size, brightness and how quickly it crosses.
 */

/** Total arrows alive at once. */
export const MAX_PARTICLES = 250;
/** About one in four schools or lone arrows flies a straight line, no sway. */
export const STRAIGHT_FRACTION = 0.25;
/** Of everything spawned, this share is a lone arrow rather than a school. */
export const LONE_FRACTION = 0.15;
export const MIN_SCHOOL = 5;
export const MAX_SCHOOL = 40;
/** Seconds to cross the screen: far schools take the long end, near ones the short. */
export const CROSS_SECONDS: [number, number] = [12, 40];
/** Straight ones are quicker, as the old single streaks were. */
export const STRAIGHT_SECONDS: [number, number] = [4, 10];

const TAU = Math.PI * 2;

export interface School {
  n: number;
  straight: boolean;
  /** 0 far .. 1 near. */
  depth: number;
  /** Arrow size multiplier and peak opacity. */
  scale: number;
  alpha: number;
  hue: number;
  seed: number;
  /** Head start (px), unit heading, speed (px/s) and lifetime (s). */
  x0: number; y0: number; dx: number; dy: number; speed: number; life: number;
  /** School length and half-width (px). */
  len: number; width: number;
  swayAmp: number; swayW: number; swayPhase: number; swayK: number;
  turnAmp: number; turnW: number; turnPhase: number;
  breathAmp: number; breathW: number; breathPhase: number;
  driftAmp: number; driftW: number;
}

export function newSchool(): School {
  return {
    n: 0, straight: false, depth: 0, scale: 1, alpha: 0.5, hue: 0, seed: 0,
    x0: 0, y0: 0, dx: -1, dy: 0, speed: 0, life: 1, len: 0, width: 0,
    swayAmp: 0, swayW: 0, swayPhase: 0, swayK: 0, turnAmp: 0, turnW: 0, turnPhase: 0,
    breathAmp: 0, breathW: 0, breathPhase: 0, driftAmp: 0, driftW: 0,
  };
}

/** Deterministic 0..1 from (seed, member, channel): an integer hash, no state. */
export function hash01(seed: number, i: number, k: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const isStraight = (r: () => number): boolean => r() < STRAIGHT_FRACTION;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

/** How many arrows to spawn: a lone one, or a school of MIN_SCHOOL..MAX_SCHOOL skewed small. */
export function pickCount(r: () => number, lone: boolean): number {
  if (lone) return 1;
  return Math.min(MAX_SCHOOL, MIN_SCHOOL + Math.floor((MAX_SCHOOL - MIN_SCHOOL + 1) * Math.pow(r(), 1.7)));
}

/** Roll a new school into `out`. `room` is how many arrows may still be added (the cap).
 *  Returns false, leaving `out` untouched, when there is no room for even a small school. */
export function spawnSchool(
  r: () => number, w: number, h: number, hueCount: number, room: number, out: School,
): boolean {
  const lone = r() < LONE_FRACTION;
  const n = Math.min(pickCount(r, lone), Math.floor(room));
  if (n < 1 || (!lone && n < MIN_SCHOOL) || !(w > 0) || !(h > 0)) return false;
  const straight = isStraight(r);
  const depth = r();
  const scale = 0.55 + 0.85 * depth;
  const len = lone ? 0 : Math.min(0.45 * w, (40 + n * 9) * scale);
  const margin = 40 * scale + 20;
  const span = w + 2 * margin + len;
  const secs = straight ? STRAIGHT_SECONDS : CROSS_SECONDS;
  const dur = Math.min(secs[1], Math.max(secs[0],
    lerp(secs[1], secs[0], Math.pow(depth, 0.8)) * (0.85 + 0.3 * r())));
  const y0 = h * (0.06 + 0.88 * r());
  const y1 = h * (0.06 + 0.88 * r());
  const dyTravel = Math.max(-0.45 * span, Math.min(0.45 * span, y1 - y0));
  const norm = Math.hypot(span, dyTravel);

  out.n = n; out.straight = straight; out.depth = depth; out.scale = scale;
  out.alpha = 0.28 + 0.5 * depth;
  out.hue = Math.floor(r() * hueCount) % hueCount;
  out.seed = Math.floor(r() * 4294967296) >>> 0;
  out.x0 = w + margin; out.y0 = y0;
  out.dx = -span / norm; out.dy = dyTravel / norm;
  out.speed = norm / dur; out.life = dur;
  out.len = len;
  out.width = lone ? 0 : len * 0.18 + 14 * scale;

  const calmFlight = straight ? 0 : 1;
  out.swayAmp = calmFlight * (10 + 30 * r()) * scale;
  out.swayW = TAU / (5 + 6 * r());
  out.swayPhase = r() * TAU;
  out.swayK = lone ? 0 : (0.8 + 1.6 * r()) / Math.max(len, 40);   // ~1-2.4 rad of lag along the school
  out.turnAmp = calmFlight * (20 + 60 * r()) * scale;
  out.turnW = TAU / (18 + 20 * r());
  out.turnPhase = r() * TAU;
  out.breathAmp = calmFlight * 0.14;
  out.breathW = TAU / (6 + 6 * r());
  out.breathPhase = r() * TAU;
  out.driftAmp = calmFlight * (3 + 7 * r()) * scale;
  out.driftW = TAU / (7 + 8 * r());
  return true;
}

export interface Pose { x: number; y: number; angle: number }

/** Where member `i` of school `s` is at age `t` seconds, and which way it points.
 *  `calm` scales every sideways motion: 1 normal, 0 none (reduced motion). */
export function memberPose(s: School, i: number, t: number, calm: number, out: Pose): void {
  // Position in the school: the head is member 0; the rest trail behind, the school widening toward the back.
  const u = i === 0 ? 0 : hash01(s.seed, i, 0);
  const breathe = 1 + calm * s.breathAmp * Math.sin(s.breathW * t + s.breathPhase);
  const along = -s.len * u * breathe
    + calm * s.driftAmp * Math.sin(s.driftW * t + hash01(s.seed, i, 2) * TAU);
  const across = (hash01(s.seed, i, 1) - 0.5) * 2 * s.width * (0.25 + 0.75 * u) * breathe
    + calm * s.driftAmp * 0.6 * Math.sin(s.driftW * 0.8 * t + hash01(s.seed, i, 3) * TAU);

  const a1 = s.swayW * t + s.swayPhase + s.swayK * along;   // `along` is negative: the tail lags the head
  const a2 = s.turnW * t + s.turnPhase;
  const lat = calm * (s.swayAmp * Math.sin(a1) + s.turnAmp * Math.sin(a2));
  const latV = calm * (s.swayAmp * s.swayW * Math.cos(a1) + s.turnAmp * s.turnW * Math.cos(a2));

  const hx = s.x0 + s.dx * s.speed * t, hy = s.y0 + s.dy * s.speed * t;
  const px = -s.dy, py = s.dx;   // sideways unit vector
  out.x = hx + s.dx * along + px * (across + lat);
  out.y = hy + s.dy * along + py * (across + lat);
  out.angle = Math.atan2(s.dy * s.speed + py * latV, s.dx * s.speed + px * latV);
}

/** True once the whole school has left (head and tail, with sway to spare). */
export const isGone = (s: School, t: number): boolean => t >= s.life;
