/** Moon phase tests, against well-known new and full moons (UTC):
 *    new   2000-01-06 18:14   full 2000-01-21 04:40
 *    new   2024-04-08 18:21 (the total eclipse)   full 2024-04-23 23:49
 *    new   2024-12-30 22:27   full 2025-01-13 22:27
 *  The mean-month model is within about half a day of these. */
import assert from "node:assert/strict";
import { moonAt, moonOnNight } from "../src/moon.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const NEW = [
  Date.UTC(2000, 0, 6, 18, 14), Date.UTC(2024, 3, 8, 18, 21), Date.UTC(2024, 11, 30, 22, 27),
];
const FULL = [
  Date.UTC(2000, 0, 21, 4, 40), Date.UTC(2024, 3, 23, 23, 49), Date.UTC(2025, 0, 13, 22, 27),
];

test("known new moons are dark and named new", () => {
  for (const t of NEW) {
    const m = moonAt(t);
    assert.ok(m.illumination < 0.02, `illumination ${m.illumination} at ${new Date(t).toISOString()}`);
    assert.equal(m.name, "New moon");
  }
});

test("known full moons are fully lit and named full", () => {
  for (const t of FULL) {
    const m = moonAt(t);
    assert.ok(m.illumination > 0.98, `illumination ${m.illumination} at ${new Date(t).toISOString()}`);
    assert.equal(m.name, "Full moon");
  }
});

test("a week after new is a waxing first quarter, a week after full a waning last quarter", () => {
  const week = 7.38 * 86400000;   // a quarter of the month
  const q1 = moonAt(NEW[1] + week), q3 = moonAt(FULL[1] + week);
  assert.equal(q1.name, "First quarter");
  assert.ok(q1.waxing && Math.abs(q1.illumination - 0.5) < 0.1);
  assert.equal(q3.name, "Last quarter");
  assert.ok(!q3.waxing && Math.abs(q3.illumination - 0.5) < 0.1);
});

test("dates before the epoch still land in a valid phase", () => {
  const m = moonAt(Date.UTC(1990, 5, 1));
  assert.ok(m.cycle >= 0 && m.cycle < 1 && m.phase >= 0 && m.phase < 8);
});

test("an evening on the day of a full moon reads as full", () => {
  assert.equal(moonOnNight("2025-01-13").name, "Full moon");
  assert.equal(moonOnNight("2024-12-30").name, "New moon");
});

console.log(`moon: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
