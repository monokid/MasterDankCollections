/** Genre / decade filtering: the ways its numbers can go wrong. */
import assert from "node:assert/strict";
import type { EnrichMap, EnrichRecord } from "../src/enrich.ts";
import {
  coverage, factOf, filterNights, nightFacets, nightMatch, nightSound, passes, songFacets,
  summarise, summaryText, universe, type Fact, type Sel,
} from "../src/enrichfilter.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const rec = (songId: string, family: string | null, year: number | null, over: Partial<EnrichRecord> = {}): EnrichRecord =>
  ({ songId, confidence: "high", year, genres: [], family, country: null, releaseGroup: null, cover: false, ...over });
const map = (...rs: EnrichRecord[]): EnrichMap => Object.fromEntries(rs.map((r) => [r.songId, r]));
const F = (family: string | null, decade: string | null): Fact => ({ family, decade });
const sel = (families: string[] = [], decades: string[] = []): Sel => ({ families, decades });

// A small library: 4 rock (3 of them 1990s), 2 metal 2000s, 1 year-only, 1 family-only, 2 unknown.
const lib: Fact[] = [
  F("rock", "1990s"), F("rock", "1990s"), F("rock", "1990s"), F("rock", "1980s"),
  F("metal", "2000s"), F("metal", "2000s"),
  F(null, "1990s"), F("pop", null),
  F(null, null), F(null, null),
];

test("facts: a suspect year gives no decade but keeps the family", () => {
  const e = map(rec("a", "rock", 2031, { yearSuspect: true }));
  assert.deepEqual(factOf(e, "a"), F("rock", null));
});
test("facts: a song with a year but no family keeps its decade", () => {
  assert.deepEqual(factOf(map(rec("a", null, 1994)), "a"), F(null, "1990s"));
});
test("facts: an unmatched record (confidence none) is unknown, whatever it carries", () => {
  assert.deepEqual(factOf(map(rec("a", "rock", 1994, { confidence: "none" })), "a"), F(null, null));
});
test("facts: no enrichment at all, or a song id that is not there, is unknown", () => {
  assert.deepEqual(factOf(null, "a"), F(null, null));
  assert.deepEqual(factOf(map(), "zzz"), F(null, null));
  assert.deepEqual(factOf(map(), null), F(null, null));
});

test("empty selection passes every song, known or not", () => {
  assert.equal(lib.filter((f) => passes(f, sel())).length, lib.length);
  assert.deepEqual(summarise(lib, sel()), { total: 10, shown: 10, unknown: 0 });
});
test("rock + 1990s is an AND across rows", () => {
  assert.equal(lib.filter((f) => passes(f, sel(["rock"], ["1990s"]))).length, 3);
});
test("two families in one row are an OR", () => {
  assert.equal(lib.filter((f) => passes(f, sel(["rock", "metal"]))).length, 6);
});
test("a family filter hides the year-only song, a decade filter keeps it", () => {
  assert.equal(passes(F(null, "1990s"), sel(["rock"])), false);
  assert.equal(passes(F(null, "1990s"), sel([], ["1990s"])), true);
});

test("unknown-hidden count: songs the chips cannot judge are counted once", () => {
  // family chip: 3 songs have no family (year-only + 2 blanks).
  assert.deepEqual(summarise(lib, sel(["rock"])), { total: 10, shown: 4, unknown: 3 });
  // both rows: a song lacking both is one hidden song, not two.
  const s = summarise(lib, sel(["rock"], ["1990s"]));
  assert.equal(s.shown, 3);
  assert.equal(s.unknown, 4); // (null,1990s) (pop,null) (null,null) x2 -> 4, not 5 or 6
});
test("unknown-hidden count: songs outside the selection are not counted as unknown", () => {
  // 2 metal and the 1980s rock are known and simply not selected.
  assert.equal(summarise(lib, sel([], ["1990s"])).unknown, 3);
});
test("summary text names what is missing and agrees in number", () => {
  assert.equal(summaryText({ total: 212, shown: 37, unknown: 9 }, sel(["rock"])),
    "37 of 212 songs (9 songs have no genre on file and are hidden by these filters)");
  assert.match(summaryText({ total: 5, shown: 1, unknown: 1 }, sel([], ["1990s"])), /1 song has no year on file and is hidden/);
  assert.match(summaryText({ total: 5, shown: 1, unknown: 2 }, sel(["rock"], ["1990s"])), /no genre or year/);
  assert.equal(summaryText({ total: 5, shown: 5, unknown: 0 }, sel(["rock"])), "5 of 5 songs");
});

test("faceted counts: the family row ignores the family selection but obeys the decade one", () => {
  const f = songFacets(lib, sel(["rock"], ["1990s"]));
  assert.equal(f.families.get("rock"), 3);      // not 4: only 1990s songs
  assert.equal(f.families.get("metal"), undefined); // no 2000s metal under a 1990s filter
  assert.equal(f.families.has("pop"), false);   // pop has no decade, so a decade filter hides it
});
test("faceted counts: the decade row obeys the family selection, not its own", () => {
  const d = songFacets(lib, sel(["rock"], ["1990s"])).decades;
  assert.equal(d.get("1990s"), 3);
  assert.equal(d.get("1980s"), 1);
  assert.equal(d.get("2000s"), undefined);
});
test("faceted counts: with nothing selected they are plain totals; a year-only song is in decades only", () => {
  const f = songFacets(lib, sel());
  assert.equal(f.families.get("rock"), 4);
  assert.equal(f.decades.get("1990s"), 4);          // 3 rock + the year-only one
  assert.equal([...f.families.values()].reduce((a, b) => a + b, 0), 7); // 3 unknown family not counted
});
test("universe: families by size, decades oldest first, unknowns absent", () => {
  const u = universe(lib);
  assert.deepEqual(u.families.map((x) => x[0]), ["rock", "metal", "pop"]);
  assert.deepEqual(u.decades.map((x) => x[0]), ["1980s", "1990s", "2000s"]);
});
test("coverage: counts family, decade and either separately", () => {
  assert.deepEqual(coverage(lib), { total: 10, family: 7, decade: 7, either: 8 });
});

// ------------------------------------------------------------------ nights
const rockNight = (n: number, total: number): Fact[] =>
  [...Array(total)].map((_, i) => (i < n ? F("rock", "1990s") : F("pop", "2010s")));

test("night rule: 3 songs is enough on a big night, 2 is not", () => {
  assert.equal(nightMatch(rockNight(3, 100), sel(["rock"])).match, true);
  assert.equal(nightMatch(rockNight(2, 100), sel(["rock"])).match, false);
});
test("night rule: 10% of the known songs is enough on a small night", () => {
  assert.equal(nightMatch(rockNight(1, 10), sel(["rock"])).match, true);   // 1/10
  assert.equal(nightMatch(rockNight(1, 11), sel(["rock"])).match, false);  // 1/11 < 10%
});
test("night rule: songs with no data do not dilute the share", () => {
  const facts = [F("rock", "1990s"), ...Array(50).fill(F(null, null)), ...Array(5).fill(F("pop", null))];
  const r = nightMatch(facts, sel(["rock"]));
  assert.equal(r.judged, 6);   // the 50 blanks are not in the denominator (1/56 would fail)
  assert.equal(r.match, true); // 1 of 6 known >= 10%
});
test("night rule: a night with no data on the selected row cannot be judged and is reported", () => {
  const nights = [
    { key: "a", facts: rockNight(5, 6) },
    { key: "b", facts: [F(null, "1990s"), F(null, "1990s")] }, // years but no genre
    { key: "c", facts: [] },
  ];
  const r = filterNights(nights, sel(["rock"]));
  assert.deepEqual([...r.keep], ["a"]);
  assert.equal(r.unjudged, 2);
  // On a decade filter the year-only night is judged (and matches only with 1990s songs).
  assert.equal(filterNights(nights, sel([], ["1990s"])).unjudged, 1);
});
test("night rule: with an empty selection a night with songs is kept", () => {
  const r = filterNights([{ key: "a", facts: [F(null, null), F(null, null)] }], sel());
  assert.deepEqual([...r.keep], ["a"]);
});
test("night facets: counted under the decade row only", () => {
  const nights = [rockNight(5, 6), [F("rock", "1980s"), F("rock", "1980s"), F("rock", "1980s")]];
  const f = nightFacets(nights, sel(["metal"], ["1990s"]), { families: ["rock", "pop"], decades: ["1980s", "1990s"] });
  assert.equal(f.families.get("rock"), 1);  // the 1980s-only night drops out under 1990s
  assert.equal(f.decades.get("1980s"), 0);  // the decade row still obeys the family selection (metal)
});

test("sound: needs 30% of the night known, and says nothing below that", () => {
  const known = [F("rock", "1990s"), F("rock", "1990s"), F("rock", "2000s")];
  assert.equal(nightSound([...known, ...Array(8).fill(F(null, null))]), null);       // 3/11 = 27%
  assert.ok(nightSound([...known, ...Array(7).fill(F(null, null))]));                // 3/10 = 30%
});
test("sound: names the dominant family and the middle of the decades, neutrally", () => {
  const facts = [F("rock", "1990s"), F("rock", "1990s"), F("rock", "2000s"), F("pop", "2000s")];
  assert.equal(nightSound(facts)!.text, "mostly rock, 1990s–2000s");
});
test("sound: no majority says mixed; a lone odd old song does not stretch the range", () => {
  const facts = [F("rock", "1990s"), F("pop", "1990s"), F("metal", "1990s"), F("rock", "1990s"), F("jazz/funk/soul", "1960s")];
  assert.equal(nightSound(facts)!.text, "mixed, led by rock, 1990s");
});
test("sound: a year-only night still gets its decade, and 'other' is worded as genres", () => {
  assert.equal(nightSound([F(null, "1980s"), F(null, "1980s")])!.text, "1980s");
  assert.equal(nightSound([F("other", null), F("other", null)])!.text, "mostly other genres");
});

if (failures.length) {
  console.error(`enrichfilter: ${failures.length} failed, ${passed} passed\n  ` + failures.join("\n  "));
  process.exit(1);
}
console.log(`enrichfilter: ${passed} tests passed`);
