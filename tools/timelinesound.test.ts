/** Timeline "colour by sound" and Home enrichment lines. Each test is named after
 *  how the numbers go wrong. */
import assert from "node:assert/strict";
import {
  nightSounds, dominantFamily, medianDecade, yearRange, homeSound, homeLines, legendCounts,
  type PlayedTrack,
} from "../src/timelinesound.ts";
import type { EnrichMap, EnrichRecord } from "../src/enrich.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const rec = (songId: string, o: Partial<EnrichRecord> = {}): EnrichRecord => ({
  songId, confidence: "high", year: null, genres: [], family: null, country: null,
  releaseGroup: null, cover: false, ...o,
});
const map = (...rs: EnrichRecord[]): EnrichMap => Object.fromEntries(rs.map((r) => [r.songId, r]));
let n = 0;
const tr = (eventId: string, songId: string | null, o: Partial<PlayedTrack> = {}): PlayedTrack =>
  ({ id: `t${n++}`, eventId, personId: "p1", songId, played: true, ...o });

test("a tie between families picked whichever was seen first, so the colour changed between loads", () => {
  const a = dominantFamily(new Map([["pop", 2], ["rock", 2]]));
  const b = dominantFamily(new Map([["rock", 2], ["pop", 2]]));
  assert.equal(a, "rock"); assert.equal(b, "rock");     // rock precedes pop in FAMILY_ORDER
});
test("a tie between unlisted families was not broken by name", () => {
  assert.equal(dominantFamily(new Map([["zzz", 1], ["aaa", 1]])), "aaa");
});
test("a night's songs were counted once per copy: the anonymised twin doubled every count", () => {
  const e = map(rec("a", { family: "rock" }), rec("b", { family: "pop" }));
  const ts = [tr("n", "a"), tr("n", "a", { played: false }), tr("n", "a"), tr("n", "b"), tr("n", "b", { played: false })];
  const s = nightSounds(ts, e).get("n")!;
  assert.equal(s.total, 2); assert.equal(s.known, 2);
});
test("a duplicate of a song from one person counted twice, while two people bringing it counted once", () => {
  const e = map(rec("a", { family: "rock" }));
  const s = nightSounds([tr("n", "a", { personId: "p1" }), tr("n", "a", { personId: "p2" })], e).get("n")!;
  assert.equal(s.total, 2);       // once per person per night, by design
  const dup = nightSounds([tr("n", "a"), tr("n", "a")], e).get("n")!;
  assert.equal(dup.total, 1);
});
test("a 20% known night was coloured as confidently as a 100% one", () => {
  const e = map(rec("a", { family: "metal" }));
  const ts = [tr("n", "a"), tr("n", "x1"), tr("n", "x2"), tr("n", "x3"), tr("n", "x4")];
  const s = nightSounds(ts, e).get("n")!;
  assert.equal(s.dominant, "metal");
  assert.equal(s.enough, false);
  assert.ok(Math.abs(s.coverage - 0.2) < 1e-9);
});
test("exactly 30% known was rejected as too little", () => {
  const e = map(rec("a", { family: "metal" }), rec("b", { family: "metal" }), rec("c", { family: "metal" }));
  const ts = [..."abc"].map((x) => tr("n", x)).concat(Array.from({ length: 7 }, (_, i) => tr("n", `u${i}`)));
  assert.equal(nightSounds(ts, e).get("n")!.enough, true);
});
test("a night with no known songs got a dominant family from nowhere", () => {
  const s = nightSounds([tr("n", "x"), tr("n", "y")], map()).get("n")!;
  assert.equal(s.dominant, null); assert.equal(s.enough, false); assert.equal(s.share, 0); assert.equal(s.decade, null);
});
test("a no-match record (confidence none) still lent its family", () => {
  const e = map(rec("a", { confidence: "none", family: "rock" }));
  assert.equal(nightSounds([tr("n", "a")], e).get("n")!.known, 0);
});
test("empty or missing enrichment threw or invented nights", () => {
  assert.equal(nightSounds([tr("n", "a")], null).get("n")!.enough, false);
  assert.equal(nightSounds([], {}).size, 0);
  assert.equal(homeSound(null), null);
  assert.equal(homeSound({}), null);
  assert.deepEqual(homeLines(null), []);
});
test("untagged tracks with no song id were merged into one", () => {
  assert.equal(nightSounds([tr("n", null), tr("n", null)], map()).get("n")!.total, 2);
});
test("a suspect year pulled a night's median decade", () => {
  const e = map(
    rec("a", { year: 1995, family: "rock" }), rec("b", { year: 1999, family: "rock" }),
    rec("c", { year: 2031, yearSuspect: true, family: "rock" }));
  assert.equal(nightSounds([tr("n", "a"), tr("n", "b"), tr("n", "c")], e).get("n")!.decade, 1990);
});
test("an even count of years took the upper one instead of the middle", () => {
  assert.equal(medianDecade([1985, 1995]), 1990);
  assert.equal(medianDecade([]), null);
});
test("the legend counted nights that were too thin to colour", () => {
  const e = map(rec("a", { family: "rock" }));
  const m = nightSounds([tr("n1", "a"), tr("n2", "a"), tr("n2", "x1"), tr("n2", "x2"), tr("n2", "x3")], e);
  assert.deepEqual(legendCounts(m.values()), [{ family: "rock", nights: 1 }]);
});
test("a single 1957 release stretched the range back to 1957", () => {
  const ys = [1957, ...Array.from({ length: 60 }, (_, i) => 1990 + (i % 30))];
  const r = yearRange(ys)!;
  assert.equal(r.trimmed, true);
  assert.ok(r.from >= 1990);
});
test("three songs near the oldest year did not count as a real start", () => {
  const ys = [1960, 1962, 1965, ...Array.from({ length: 50 }, () => 2005)];
  const r = yearRange(ys)!;
  assert.equal(r.from, 1960); assert.equal(r.trimmed, false);
});
test("two old songs were enough to claim the range started there", () => {
  const ys = [1960, 1962, ...Array.from({ length: 200 }, () => 2005)];
  assert.equal(yearRange(ys)!.trimmed, true);
});
test("no known years produced a range line", () => {
  assert.equal(yearRange([]), null);
  assert.deepEqual(homeLines(homeSound({ a: rec("a") })), []);
});
test("suspect years were included in the Home range", () => {
  const e = map(rec("a", { year: 1900, yearSuspect: true }), rec("b", { year: 2000 }), rec("c", { year: 2001 }), rec("d", { year: 2002 }));
  assert.deepEqual(homeSound(e)!.range, { from: 2000, to: 2002, trimmed: false });
});
test("'other' and thin families were counted as genres", () => {
  const rs = [
    ...Array.from({ length: 5 }, (_, i) => rec(`r${i}`, { family: "rock" })),
    ...Array.from({ length: 4 }, (_, i) => rec(`p${i}`, { family: "pop" })),
    ...Array.from({ length: 9 }, (_, i) => rec(`o${i}`, { family: "other" })),
  ];
  assert.equal(homeSound(map(...rs))!.genres, 1);
});
test("art count included covers that cannot be shown, and the total ignored the library size", () => {
  const e = map(rec("a", { cover: true, coverUrl: "http://x/y.jpg" }), rec("b", { cover: true }), rec("c", { confidence: "none", cover: true, coverUrl: "u" }));
  const h = homeSound(e, 3031)!;
  assert.equal(h.art, 1); assert.equal(h.songs, 3031);
  assert.ok(homeLines(h).includes("1 of 3,031 songs have art on file") || homeLines(h).some((l) => /^1 of 3.031 songs/.test(l)));
});

console.log(`timelinesound: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
