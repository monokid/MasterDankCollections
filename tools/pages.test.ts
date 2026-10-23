/** The pages' pure logic: formatting, search grouping and sorting, setlists,
 *  CSV, and the scroll-spy / keyboard arithmetic. */
import assert from "node:assert/strict";
import type { Catalog, Event, Song, Track } from "../src/catalog.ts";
import { fmtCount, fmtDur, fmtSpan, pct, plural, yearSpan } from "../src/format.ts";
import {
  csvCell, csvFilename, groupHits, lookups, sectionAt, setlistText, sortGroups, splitSet,
  spotifyUrl, stepIndex, toCsv,
} from "../src/pagehelpers.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const ev = (id: string, date: string | null, types: string[] = ["roll"], over: Partial<Event> = {}) =>
  ({ id, date, types, title: "", folder: id, kind: "event", ...over }) as Event;
const tr = (id: string, eventId: string, songId: string | null, over: Partial<Track> = {}) =>
  ({ id, eventId, songId, personId: null, phaseId: null, artist: "A", title: "T", flags: [], played: true, ...over }) as Track;
const song = (id: string, title: string, artist: string) =>
  ({ id, title, artist, variants: [], nights: [] }) as unknown as Song;

const events = new Map([
  ["e18", ev("e18", "2018-02-03")],
  ["e21", ev("e21", "2021-06-05", ["trip"])],
  ["e19", ev("e19", "2019-01-01")],
]);
const songs = new Map([["s1", song("s1", "Ghost Love Score", "Nightwish")], ["s2", song("s2", "Aurora", "Zed")]]);
const peopleName = new Map([["p1", "Dov"], ["p2", "Cal"]]);
const ctx = { events, songs, peopleName };

// ------------------------------------------------------------- formatting

test("a track length that rounds up to the next minute reads 1:00, not 0:60", () => {
  assert.equal(fmtDur(59.6), "1:00");
  assert.equal(fmtDur(119.5), "2:00");
});
test("track lengths: plain, unknown and zero", () => {
  assert.equal(fmtDur(185), "3:05");
  assert.equal(fmtDur(null), "");
  assert.equal(fmtDur(0), "");
});
test("running times round to the minute across the hour", () => {
  assert.equal(fmtSpan(3590), "1h 00m");
  assert.equal(fmtSpan(2040), "34m");
  assert.equal(fmtSpan(8040), "2h 14m");
});
test("counts and plurals", () => {
  assert.equal(plural(1, "song"), "1 song");
  assert.equal(plural(2, "song"), "2 songs");
  assert.equal(plural(0, "time"), "0 times");
  assert.equal(plural(1, "night"), "1 night");
  assert.equal(fmtCount(2904).replace(/\D/g, ""), "2904");
  assert.equal(pct(0.426), "43%");
});
test("year spans: one year, several, none", () => {
  assert.equal(yearSpan(["2018-02-03", "2018-12-01"]), "2018");
  assert.equal(yearSpan(["2021-06-05", "2018-02-03", "2019-01-01"]), "2018–21");
  assert.equal(yearSpan([]), "");
});

// ---------------------------------------------------------------- grouping

const hits = [
  tr("t1", "e21", "s1", { personId: "p1" }),
  tr("t2", "e18", "s1", { personId: "p2" }),
  tr("t3", "e18", "s1", { personId: "p1" }),     // same song, same night, same person
  tr("t4", "e19", "s2", { personId: "p1" }),
  tr("t5", "e19", null, { title: null, artist: null }),
].map((track) => ({ track }));

test("the same song on several nights is one group, newest play first", () => {
  const { groups, plays } = groupHits(hits, ctx);
  assert.equal(groups.length, 3);
  assert.equal(plays, 5);
  const g = groups.find((x) => x.key === "s1")!;
  assert.equal(g.tracks.length, 3);
  assert.equal(g.nights, 2);
  assert.equal(g.tracks[0].id, "t1");
  assert.equal(g.latest, "2021-06-05");
  assert.equal(g.span, "2018–21");
  assert.deepEqual(g.people, ["Dov", "Cal"]);
  assert.equal(g.title, "Ghost Love Score");
});
test("groups keep the order the scorer ranked them", () => {
  assert.deepEqual(groupHits(hits, ctx).groups.map((g) => g.key), ["s1", "s2", "t:t5"]);
});
test("a track with no song id and no title is shown as untitled, not dropped", () => {
  assert.equal(groupHits(hits, ctx).groups[2].title, "(untitled)");
});
test("the year and kind-of-night filters count plays as well as songs", () => {
  const y = groupHits(hits, ctx, { year: "2018" });
  assert.equal(y.plays, 2);
  assert.equal(y.groups.length, 1);
  const k = groupHits(hits, ctx, { type: "trip" });
  assert.equal(k.plays, 1);
  assert.equal(k.groups[0].key, "s1");
});

test("sorting: best match keeps rank, falls back to most nights with no query", () => {
  const { groups } = groupHits(hits, ctx);
  assert.deepEqual(sortGroups(groups, "match", true).map((g) => g.key), ["s1", "s2", "t:t5"]);
  assert.equal(sortGroups(groups, "match", false)[0].key, "s1");   // 2 nights beats 1
});
test("sorting: A to Z and newest play", () => {
  const { groups } = groupHits(hits, ctx);
  assert.deepEqual(sortGroups(groups, "az", true).map((g) => g.title), ["(untitled)", "Aurora", "Ghost Love Score"]);
  assert.deepEqual(sortGroups(groups, "newest", true).map((g) => g.key), ["s1", "s2", "t:t5"]);
});
test("sorting copies: the ranked list is not rearranged underneath the caller", () => {
  const { groups } = groupHits(hits, ctx);
  const before = groups.map((g) => g.key);
  sortGroups(groups, "az", true);
  assert.deepEqual(groups.map((g) => g.key), before);
});

// ---------------------------------------------------------------- setlists

test("a set splits into phases in the order given, then the loose tracks", () => {
  const played = [
    tr("a", "e", null, { phaseId: "late" }), tr("b", "e", null, { phaseId: "early" }),
    tr("c", "e", null), tr("d", "e", null, { phaseId: "ghost" }), tr("e2", "e", null, { phaseId: "early" }),
  ];
  const s = splitSet(played, ["early", "late"]);
  assert.deepEqual(s.ordered.map((t) => t.id), ["b", "e2", "a", "c", "d"]);
  assert.deepEqual(s.loose.map((t) => t.id), ["c", "d"]);
});
test("anonymised files in a partly named list are set apart, and an all-anonymous list is left whole", () => {
  const anon = (id: string) => tr(id, "e", null, { flags: ["anon"] });
  const mixed = splitSet([tr("a", "e", null), anon("x"), tr("b", "e", null), anon("y")], []);
  assert.deepEqual(mixed.loose.map((t) => t.id), ["a", "b"], "named songs keep their order");
  assert.deepEqual(mixed.unnamed.map((t) => t.id), ["x", "y"], "the unnamed files follow, apart");
  assert.deepEqual(mixed.ordered.map((t) => t.id), ["a", "b"], "and stay out of a copied setlist");
  const whole = splitSet([anon("p"), anon("q")], []);
  assert.deepEqual(whole.loose.map((t) => t.id), ["p", "q"]);
  assert.equal(whole.unnamed.length, 0);
});
test("setlist text: Artist - Title per line, title alone when the artist is unknown", () => {
  assert.equal(
    setlistText([{ artist: "Nightwish", title: "Ghost Love Score" }, { artist: null, title: "Aurora" }, { artist: "X", title: null }]),
    "Nightwish - Ghost Love Score\nAurora\nX - (untitled)");
  assert.equal(setlistText([]), "");
});
test("Spotify links come only from plain track ids", () => {
  assert.equal(spotifyUrl("spotify:track:4uLU6hMCjMI75M1A2tKUQC"), "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(spotifyUrl("javascript:alert(1)"), null);
  assert.equal(spotifyUrl(undefined), null);
});

// --------------------------------------------------------------------- CSV

test("csv cells: quoting, doubled quotes, numbers and blanks", () => {
  assert.equal(csvCell('Hello, "World"'), '"Hello, ""World"""');
  assert.equal(csvCell("line\nbreak"), '"line\nbreak"');
  assert.equal(csvCell(-3.5), "-3.5");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(NaN), "");
});
test("csv cells that a spreadsheet would run as a formula are defused", () => {
  assert.equal(csvCell("=HYPERLINK(\"x\")"), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("@sum"), "'@sum");
  assert.equal(csvCell("Nightwish"), "Nightwish");
});
test("csv: header, rows, CRLF, and a file name from the chart title", () => {
  assert.equal(toCsv(["label", "value"], [["a", 1], ["b, c", 2]]), 'label,value\r\na,1\r\n"b, c",2\r\n');
  assert.equal(csvFilename("Songs that keep coming back"), "songs-that-keep-coming-back.csv");
  assert.equal(csvFilename("Quality (files) — by year", "2018-01-01_2019-12-31"), "quality-files-by-year-2018-01-01_2019-12-31.csv");
  assert.equal(csvFilename("???"), "chart.csv");
});

// ------------------------------------------------------- scroll-spy, keys

test("scroll-spy: before the first section none is current, then the last one passed", () => {
  assert.equal(sectionAt([300, 900, 1500], 100), -1);
  assert.equal(sectionAt([300, 900, 1500], 300), 0);
  assert.equal(sectionAt([300, 900, 1500], 1000), 1);
  assert.equal(sectionAt([], 0), -1);
});
test("scroll-spy: at the bottom the last section wins even if its top never reached the line", () => {
  assert.equal(sectionAt([300, 900, 1500], 1000, true), 2);
  assert.equal(sectionAt([], 0, true), -1);
});
test("arrow keys stop at both ends and -1 means back to the box", () => {
  assert.equal(stepIndex(-1, 1, 5), 0);
  assert.equal(stepIndex(0, -1, 5), -1);
  assert.equal(stepIndex(4, 1, 5), 4);
  assert.equal(stepIndex(-1, -1, 5), -1);
});

// ------------------------------------------------------------------ lookups

test("lookup tables are built once per catalogue", () => {
  const cat = {
    events: [ev("e18", "2018-02-03")], songs: [song("s1", "T", "A")], artists: [],
    people: [{ id: "p1", name: "Dov" }],
  } as unknown as Catalog;
  const a = lookups(cat);
  assert.equal(a, lookups(cat));
  assert.equal(a.peopleName.get("p1"), "Dov");
  assert.equal(a.events.get("e18")?.date, "2018-02-03");
});

if (failures.length) {
  console.error(`pages: ${failures.length} failed, ${passed} passed\n  ` + failures.join("\n  "));
  process.exit(1);
}
console.log(`pages: ${passed} tests passed`);
