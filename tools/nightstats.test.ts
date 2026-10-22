/** Per-person and per-phase numbers for a night's page. */
import assert from "node:assert/strict";
import { nightStats } from "../src/nightstats.ts";
import type { Phase, Track } from "../src/catalog.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const tr = (id: string, personId: string | null, phaseId: string | null, dur: number, over: Partial<Track> = {}) =>
  ({ id, eventId: "e", personId, phaseId, durationSec: dur, played: true, flags: [], ...over }) as Track;
const ph = (id: string, position: number, personId = "ada") =>
  ({ id, eventId: "e", personId, clean: id, bucket: "other", position }) as Phase;

test("a named list and its anonymised twin are counted once", () => {
  // The distiller marks the named copy played and the anon twin not.
  const tracks = [
    tr("n1", "ada", "p1", 200), tr("n2", "ada", "p1", 300),
    tr("a1", "ada", "p1", 200.4, { flags: ["anon"], played: false }),
    tr("a2", "ada", "p1", 300.4, { flags: ["anon"], played: false }),
  ];
  const s = nightStats(tracks, [ph("p1", 0)]);
  assert.equal(s.songs, 2);
  assert.equal(s.seconds, 500);
  assert.equal(s.persons[0].songs, 2);
  assert.equal(s.persons[0].byPhase[0].songs, 2);
});

test("an anonymised list with no named twin still counts, because it was played", () => {
  const s = nightStats([tr("a1", "cy", null, 100, { flags: ["anon"] })], []);
  assert.equal(s.persons[0].songs, 1);
});

test("phases come in position order, with the phaseless remainder last", () => {
  const tracks = [
    tr("a", "ada", "late", 100), tr("b", "ada", null, 50), tr("c", "ada", "early", 300),
  ];
  const s = nightStats(tracks, [ph("late", 2), ph("early", 0)]);
  const p = s.persons[0];
  assert.deepEqual(p.byPhase.map((x) => x.key), ["early", "late", ""]);
  assert.equal(p.phases, 2, "the remainder is not a phase");
  assert.equal(p.seconds, 450);
  assert.ok(Math.abs(p.byPhase.reduce((n, x) => n + x.share, 0) - 1) < 1e-9);
  assert.ok(Math.abs(p.byPhase[0].share - 300 / 450) < 1e-9);
});

test("a phase whose tracks were all unplayed is not counted as a phase", () => {
  const tracks = [tr("a", "ada", "p1", 100), tr("b", "ada", "p2", 100, { played: false })];
  const s = nightStats(tracks, [ph("p1", 0), ph("p2", 1)]);
  assert.equal(s.persons[0].phases, 1);
  assert.equal(s.phases, 1);
});

test("people are ordered by songs and night totals add up across them", () => {
  const tracks = [
    tr("a", "ada", "p1", 100), tr("b", "bo", null, 60), tr("c", "bo", null, 40),
    tr("d", null, null, 10),
  ];
  const s = nightStats(tracks, [ph("p1", 0)]);
  assert.deepEqual(s.persons.map((p) => p.personId), ["bo", "ada", null]);
  assert.equal(s.songs, 4);
  assert.equal(s.seconds, 210);
  assert.equal(s.phases, 1);
});

test("tracks without a running time still get a share", () => {
  const tracks = [tr("a", "ada", "p1", 0, { durationSec: null }), tr("b", "ada", "p2", 0, { durationSec: null })];
  const s = nightStats(tracks, [ph("p1", 0), ph("p2", 1)]);
  assert.equal(s.persons[0].byPhase[0].share, 0.5);
});

console.log(`nightstats: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
