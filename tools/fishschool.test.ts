/** Fish-school arrows: spawn params in range, deterministic poses, no NaN, straight fraction. */
import assert from "node:assert/strict";
import {
  CROSS_SECONDS, LONE_FRACTION, MAX_SCHOOL, MIN_SCHOOL, STRAIGHT_FRACTION, STRAIGHT_SECONDS,
  hash01, memberPose, newSchool, spawnSchool, type Pose,
} from "../src/fishschool.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIZES: [number, number][] = [[1440, 900], [390, 844], [2560, 1440], [320, 480]];

test("spawn params stay in range at every viewport size", () => {
  const r = rng(11);
  const s = newSchool();
  for (let k = 0; k < 4000; k++) {
    const [w, h] = SIZES[k % SIZES.length];
    assert.ok(spawnSchool(r, w, h, 6, 250, s));
    const lone = s.n === 1;
    assert.ok(lone || (s.n >= MIN_SCHOOL && s.n <= MAX_SCHOOL), `n ${s.n}`);
    const secs = s.straight ? STRAIGHT_SECONDS : CROSS_SECONDS;
    assert.ok(s.life >= secs[0] - 1e-9 && s.life <= secs[1] + 1e-9, `life ${s.life}`);
    assert.ok(s.depth >= 0 && s.depth <= 1 && s.alpha > 0 && s.alpha < 1 && s.scale > 0);
    assert.ok(s.hue >= 0 && s.hue < 6 && Number.isInteger(s.hue));
    assert.ok(s.x0 > w, "starts off the right edge");
    assert.ok(s.dx < 0, "heads left");
    assert.ok(Math.abs(Math.hypot(s.dx, s.dy) - 1) < 1e-9, "unit heading");
    assert.ok(s.y0 >= 0 && s.y0 <= h);
    assert.ok(s.len <= 0.45 * w + 1e-9);
    // the head ends fully off the left edge when its life is up
    assert.ok(s.x0 + s.dx * s.speed * s.life < 0, "leaves left");
    if (s.straight) assert.ok(s.swayAmp === 0 && s.turnAmp === 0 && s.breathAmp === 0 && s.driftAmp === 0);
    else assert.ok(s.swayAmp > 0 && s.turnAmp > 0);
  }
});

test("spawn respects the cap: never more than `room`, and refuses when too small for a school", () => {
  const r = rng(5);
  const s = newSchool();
  let refused = 0, ok = 0;
  for (let k = 0; k < 2000; k++) {
    const room = k % 12;
    if (spawnSchool(r, 1200, 800, 6, room, s)) { ok++; assert.ok(s.n <= room); }
    else refused++;
  }
  assert.ok(refused > 0 && ok > 0);
  assert.equal(spawnSchool(r, 1200, 800, 6, 0, s), false);
});

test("straight fraction is about one in four, and lone arrows remain", () => {
  const r = rng(99);
  const s = newSchool();
  let straight = 0, lone = 0;
  const N = 20000;
  for (let k = 0; k < N; k++) {
    spawnSchool(r, 1440, 900, 6, 250, s);
    if (s.straight) straight++;
    if (s.n === 1) lone++;
  }
  assert.ok(Math.abs(straight / N - STRAIGHT_FRACTION) < 0.02, `straight ${straight / N}`);
  assert.ok(Math.abs(lone / N - LONE_FRACTION) < 0.02, `lone ${lone / N}`);
});

test("most spawns are schools of 5-40", () => {
  const r = rng(3);
  const s = newSchool();
  let schools = 0, big = 0;
  for (let k = 0; k < 5000; k++) {
    spawnSchool(r, 1440, 900, 6, 250, s);
    if (s.n >= MIN_SCHOOL) schools++;
    if (s.n >= 30) big++;
  }
  assert.ok(schools / 5000 > 0.8);
  assert.ok(big > 0);
});

test("poses are deterministic from the seed and never NaN", () => {
  const r = rng(21);
  const s = newSchool();
  const a: Pose = { x: 0, y: 0, angle: 0 }, b: Pose = { x: 0, y: 0, angle: 0 };
  for (let k = 0; k < 300; k++) {
    const [w, h] = SIZES[k % SIZES.length];
    spawnSchool(r, w, h, 6, 250, s);
    for (const calm of [1, 0]) {
      for (const f of [0, 0.25, 0.5, 1]) {
        for (let i = 0; i < s.n; i++) {
          memberPose(s, i, f * s.life, calm, a);
          memberPose(s, i, f * s.life, calm, b);
          assert.deepEqual(a, b);
          assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.angle), "NaN pose");
        }
      }
    }
  }
});

test("members stay within the school's bounds and the school ripples", () => {
  const r = rng(8);
  const s = newSchool();
  const p: Pose = { x: 0, y: 0, angle: 0 };
  let found = 0;
  while (found < 20) {
    spawnSchool(r, 1440, 900, 6, 250, s);
    if (s.straight || s.n < 20) continue;
    found++;
    const reach = s.len + s.width + 2 * (s.swayAmp + s.turnAmp + 2 * s.driftAmp) + 1;
    for (let f = 0; f <= 1; f += 0.1) {
      const t = f * s.life;
      const hx = s.x0 + s.dx * s.speed * t, hy = s.y0 + s.dy * s.speed * t;
      for (let i = 0; i < s.n; i++) {
        memberPose(s, i, t, 1, p);
        assert.ok(Math.hypot(p.x - hx, p.y - hy) <= reach * 1.3, "member strayed from its school");
      }
    }
    // ripple: with a lag along the school, members at different depths along it are not in step sideways
    const px = -s.dy, py = s.dx;
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < s.n; i++) {
      memberPose(s, i, s.life * 0.4, 1, p);
      const hx = s.x0 + s.dx * s.speed * s.life * 0.4, hy = s.y0 + s.dy * s.speed * s.life * 0.4;
      const side = (p.x - hx) * px + (p.y - hy) * py;
      min = Math.min(min, side); max = Math.max(max, side);
    }
    assert.ok(max - min > 5, "school is a flat line");
  }
});

test("calm 0 stops all sideways sway: members hold their formation", () => {
  const r = rng(13);
  const s = newSchool();
  const p0: Pose = { x: 0, y: 0, angle: 0 }, p1: Pose = { x: 0, y: 0, angle: 0 };
  for (let k = 0; k < 100; k++) {
    spawnSchool(r, 1440, 900, 6, 250, s);
    if (s.straight) continue;
    for (let i = 0; i < s.n; i++) {
      memberPose(s, i, 3, 0, p0);
      memberPose(s, i, 9, 0, p1);
      // moved along the heading only, by exactly speed * dt
      const mx = p1.x - p0.x, my = p1.y - p0.y;
      assert.ok(Math.abs(mx - s.dx * s.speed * 6) < 1e-6 && Math.abs(my - s.dy * s.speed * 6) < 1e-6);
      assert.ok(Math.abs(p0.angle - Math.atan2(s.dy, s.dx)) < 1e-9);
    }
  }
});

test("hash01 is in [0,1) and well spread", () => {
  let sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) {
    const v = hash01(12345, i, i % 4);
    assert.ok(v >= 0 && v < 1);
    sum += v;
  }
  assert.ok(Math.abs(sum / N - 0.5) < 0.02);
});

if (failures.length) {
  console.error(`fishschool: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`fishschool: ${passed} passed`);
