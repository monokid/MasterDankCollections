/** Tests for src/playpace.ts. Each is named after the way the pace would go wrong. */
import assert from "node:assert/strict";
import { BASE_SECONDS, CHAIN_CAP_MS, FLOOR, createPacer, dwellMs, paceFactor, type Stop } from "../src/playpace.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const START = 0, END = 1_000_000;
const at = (frac: number) => START + frac * (END - START);
const mk = (stops: Stop[]) => createPacer({ start: START, end: END, stops });
/** Run to the end in 16 ms frames; returns real ms taken. */
function runOut(p: ReturnType<typeof mk>, speed: number, pause: boolean, cap = 10_000_000): number {
  let t = 0;
  while (t < cap) { t += 16; if (p.step(16, { speed, pause }).done) return t; }
  throw new Error("never finished");
}

test("no milestones means constant speed: BASE_SECONDS at 1x, half that at 2x", () => {
  const t1 = runOut(mk([]), 1, true), t2 = runOut(mk([]), 2, true);
  assert.ok(Math.abs(t1 - BASE_SECONDS * 1000) < 40, `1x took ${t1}`);
  assert.ok(Math.abs(t2 - BASE_SECONDS * 500) < 40, `2x took ${t2}`);
});

test("turning 'pause on milestones' off means constant speed even with milestones", () => {
  const stops = [0.2, 0.5, 0.8].map((f) => ({ pos: at(f), chars: 80 }));
  const t = runOut(mk(stops), 1, false);
  assert.ok(Math.abs(t - BASE_SECONDS * 1000) < 40, `took ${t}`);
});

test("a milestone night slows the playhead to the floor and then lets it go again", () => {
  const p = mk([{ pos: at(0.3), chars: 60 }]);
  let guard = 0;
  while (p.pos < at(0.3) && guard++ < 1e6) p.step(16, { speed: 1, pause: true });
  assert.ok(p.dwell, "should be dwelling on the crossing");
  assert.equal(paceFactor(0, 5000), 1);
  assert.ok(Math.abs(paceFactor(2500, 5000) - FLOOR) < 1e-9);
  const free = p.dwell!.total;
  p.step(free + 100, { speed: 1, pause: true });
  assert.equal(p.dwell, null);
});

test("dwell length follows the text length, within 1.5 to 6 s", () => {
  assert.equal(dwellMs(0, 1), 1500);
  assert.equal(dwellMs(100, 1), 1200 + 4500);
  assert.equal(dwellMs(10_000, 1), 6000);
  assert.ok(dwellMs(40, 1) < dwellMs(80, 1));
});

test("speed multipliers scale dwell: 2x halves it, 0.5x doubles it", () => {
  assert.equal(dwellMs(60, 2), dwellMs(60, 1) / 2);
  assert.equal(dwellMs(60, 0.5), dwellMs(60, 1) * 2);
  const extra = (sp: number) =>
    runOut(mk([{ pos: at(0.1), chars: 60 }]), sp, true) - runOut(mk([]), sp, true);
  const d1 = extra(1), d4 = extra(4);
  assert.ok(d4 < d1 / 2, `dwell at 4x (${d4}) should be far shorter than at 1x (${d1})`);
});

test("adjacent milestone nights don't compound into a stall longer than 8 s", () => {
  const stops = Array.from({ length: 12 }, (_, i) => ({ pos: at(0.4 + i * 0.0005), chars: 200 }));
  const extra = runOut(mk(stops), 1, true) - runOut(mk([]), 1, true);
  assert.ok(extra <= CHAIN_CAP_MS + 100, `stalled ${extra} ms`);
  const extra2 = runOut(mk(stops), 2, true) - runOut(mk([]), 2, true);
  assert.ok(extra2 <= CHAIN_CAP_MS / 2 + 100, `stalled ${extra2} ms at 2x`);
});

test("pausing mid-dwell resumes the remainder (a pause costs no dwell time)", () => {
  const p = mk([{ pos: at(0.3), chars: 60 }]);
  while (!p.dwell) p.step(16, { speed: 1, pause: true });
  p.step(800, { speed: 1, pause: true });
  const before = p.dwell!;
  // paused: the caller does not step at all
  const after = p.dwell!;
  assert.equal(after.elapsed, before.elapsed);
  assert.equal(after.total, before.total);
  p.step(100, { speed: 1, pause: true });
  assert.ok(Math.abs(p.dwell!.elapsed - (before.elapsed + 100)) < 17);
});

test("jumping or seeking cancels the dwell and skips stops behind the new position", () => {
  const stops = [{ pos: at(0.3), chars: 60 }, { pos: at(0.6), chars: 60 }];
  const p = mk(stops);
  while (!p.dwell) p.step(16, { speed: 1, pause: true });
  p.seek(at(0.7));
  assert.equal(p.dwell, null);
  const r = p.step(16, { speed: 1, pause: true });
  assert.deepEqual(r.crossed, []);
  assert.equal(p.dwell, null);
  p.seek(START);
  let n = 0;
  for (let i = 0; i < 100_000 && n < 2; i++) n += p.step(16, { speed: 1, pause: true }).crossed.length;
  assert.equal(n, 2, "after a restart both stops are crossed again");
});

test("dwell never makes play end never: even a stop at every step finishes, and bounded", () => {
  const stops = Array.from({ length: 400 }, (_, i) => ({ pos: at((i + 1) / 401), chars: 500 }));
  const t = runOut(mk(stops), 1, true);
  const plain = BASE_SECONDS * 1000;
  assert.ok(t < plain / FLOOR + 1000, `took ${t}`);
  for (const sp of [0.5, 1, 2, 4]) assert.ok(runOut(mk(stops), sp, true) < 10_000_000);
});

test("the rate never reaches zero, even deep in a dwell", () => {
  for (let e = 0; e <= 5000; e += 10) assert.ok(paceFactor(e, 5000) >= FLOOR - 1e-9);
});

test("a huge frame (tab was hidden) still crosses each stop once", () => {
  const stops = [0.1, 0.2, 0.3].map((f) => ({ pos: at(f), chars: 10 }));
  const r = mk(stops).step(40_000, { speed: 1, pause: true });
  assert.deepEqual(r.crossed, [0, 1, 2]);
});

if (failures.length) {
  console.error(`playpace: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`playpace: ${passed} passed`);
