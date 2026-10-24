/** Amoeba behaviour scheduling: no repeats, never two at once, eased envelope, calm idles. */
import assert from "node:assert/strict";
import {
  BEHAVIOURS, DURATION, FIRST_IDLE, IDLE, createScheduler, envelope, pickBehaviour, type BehaviourName,
} from "../src/amoebabehaviours.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

/** Deterministic rng (mulberry32). */
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

test("envelope is 0 at both ends, 1 in the middle, never outside 0..1, rises then falls", () => {
  assert.equal(envelope(0), 0);
  assert.equal(envelope(1), 0);
  assert.equal(envelope(0.5), 1);
  assert.equal(envelope(NaN), 0);
  let prev = 0, peaked = false;
  for (let i = 0; i <= 200; i++) {
    const e = envelope(i / 200);
    assert.ok(e >= 0 && e <= 1);
    if (e < prev - 1e-12) peaked = true;
    else assert.ok(!peaked, "rose again after falling");
    prev = e;
  }
});

test("pickBehaviour never returns the last one, even at the extremes of rand", () => {
  for (const last of BEHAVIOURS) {
    for (const r of [0, 0.0001, 0.3, 0.5, 0.9999, 1]) {
      assert.notEqual(pickBehaviour(() => r, last, null), last);
    }
  }
});

test("pickBehaviour reaches every other behaviour, and the one before last is rarer", () => {
  const r = rng(7);
  const count: Record<string, number> = {};
  for (let i = 0; i < 6000; i++) { const n = pickBehaviour(r, "bloom", "jelly"); count[n] = (count[n] ?? 0) + 1; }
  assert.equal(count.bloom, undefined);
  for (const n of BEHAVIOURS) if (n !== "bloom") assert.ok(count[n] > 0, `${n} never picked`);
  assert.ok(count.jelly < count.shimmer, `jelly ${count.jelly} vs shimmer ${count.shimmer}`);
});

test("scheduler: one at a time, no immediate repeats, durations and idles in range, all get used", () => {
  const r = rng(42);
  const s = createScheduler(r);
  const seen = new Set<BehaviourName>();
  let prevName: BehaviourName | null = null, lastEnded: BehaviourName | null = null;
  let runStart = 0, idleStart = 0, time = 0, runs = 0, firstStart = -1;
  const dt = 1 / 30;
  for (let i = 0; i < 30 * 3600; i++) {
    time += dt;
    s.step(dt);
    const n = s.name;
    assert.ok(s.env >= 0 && s.env <= 1 && s.progress >= 0 && s.progress <= 1);
    assert.equal(s.id > 0, n !== null);
    if (n && !prevName) {
      if (firstStart < 0) { firstStart = time; assert.ok(time >= FIRST_IDLE[0] - 0.1 && time <= FIRST_IDLE[1] + 0.1, `first at ${time}`); }
      else assert.ok(time - idleStart >= IDLE[0] - 0.1 && time - idleStart <= IDLE[1] + 0.1, `idle ${time - idleStart}`);
      assert.notEqual(n, lastEnded, "immediate repeat");
      runStart = time; runs++; seen.add(n);
    }
    if (!n && prevName) {
      const len = time - runStart;
      assert.ok(len >= DURATION[prevName][0] - 0.1 && len <= DURATION[prevName][1] + 0.1, `${prevName} ran ${len}`);
      lastEnded = prevName; idleStart = time;
    }
    if (n && prevName && n !== prevName) assert.fail("two behaviours without a calm gap");
    prevName = n;
  }
  assert.ok(runs > 100, `only ${runs} runs in an hour`);
  assert.equal(seen.size, BEHAVIOURS.length);
});

test("trigger starts at once when calm, and queues behind a running behaviour", () => {
  const s = createScheduler(rng(1));
  s.trigger("sneeze");
  assert.equal(s.name, "sneeze");
  s.trigger("bloom");
  assert.equal(s.name, "sneeze", "must not replace a running one");
  for (let i = 0; i < 30 * 4; i++) s.step(1 / 30);
  assert.equal(s.name, "bloom", "queued one follows");
});

test("a huge, zero or NaN dt does not break the state", () => {
  const s = createScheduler(rng(3));
  s.step(0); s.step(NaN); s.step(-1);
  s.trigger("jelly");
  s.step(1000);
  assert.equal(s.name, null);
  assert.equal(s.env, 0);
});

if (failures.length) {
  console.error(`amoebabehaviours: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`amoebabehaviours: ${passed} passed`);
