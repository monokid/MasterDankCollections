/** Tests for src/analytics.ts -- the figures behind the Insights page.
 *
 *  Each is named after the way the number would quietly go wrong, because a
 *  wrong chart looks exactly like a right one.
 */
import assert from "node:assert/strict";
import {
  artistYears, cast, comebacks, cumulative, discovery, genreCoverage, inRange,
  isEventLabel, lifespans, lowest, nightsOf, playedOf, realGenres, tastemakers,
  evolutions, oneOffs, soloArtists, soloSongs, trendBreaks,
  qualityByYear, qualityCoverage, upgradeCandidates, weakestNights,
} from "../src/analytics.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

// A small library: four nights, two songs, three people.
const ev = (id: string, date: string, people: string[], over: object = {}) =>
  ({ id, date, kind: "event", people, types: [], ...over });
const tr = (id: string, eventId: string, songId: string | null, personId: string | null, over: object = {}) =>
  ({ id, eventId, songId, personId, flags: [], genre: null, ...over });
const song = (id: string, nights: string[], date: Record<string, string>) => ({
  id, artist: "A", title: id, variants: [], plays: nights.length, nights,
  people: [], firstPlayed: date[nights[0]], lastPlayed: date[nights[nights.length - 1]],
});

const DATES: Record<string, string> = {
  n1: "2016-01-02", n2: "2018-06-01", n3: "2021-05-04", n4: "2026-04-04",
};
const events = [
  ev("n1", DATES.n1, ["p1", "p2"]), ev("n2", DATES.n2, ["p1"]),
  ev("n3", DATES.n3, ["p1", "p2", "p3"]), ev("n4", DATES.n4, ["p1", "p3"]),
  { id: "shelf", date: null, kind: "collection", people: [], types: [] },
];
const songs = [
  song("s1", ["n1", "n2", "n3", "n4"], DATES),   // sticks around the whole span
  song("s2", ["n1", "n4"], DATES),               // gone ten years, then back
];
const tracks = [
  tr("t1", "n1", "s1", "p1"), tr("t2", "n1", "s1", "p2"),   // both start s1
  tr("t3", "n2", "s1", "p1"), tr("t4", "n3", "s1", "p3"), tr("t5", "n4", "s1", "p3"),
  tr("t6", "n1", "s2", "p1"), tr("t7", "n4", "s2", "p1"),
  tr("t8", "n3", null, "p2"),
  tr("anon", "n2", "s1", "p1", { flags: ["anon"] }),
  tr("shelf-1", "shelf", "s1", null),
];
const cat = {
  events, songs, tracks, people: [], artists: [
    { id: "a1", name: "A", nights: ["n1", "n2", "n4"], songs: 2, plays: 5, people: [], firstPlayed: null, lastPlayed: null },
    { id: "a2", name: "B", nights: ["n1", "n1", "n2"], songs: 1, plays: 3, people: [], firstPlayed: null, lastPlayed: null },
  ],
} as never;

test("a range is inclusive at both ends and open when absent", () => {
  assert.equal(inRange("2018-06-01", { from: "2018-06-01", to: "2018-06-01" }), true);
  assert.equal(inRange("2018-06-02", { from: "2018-06-01", to: "2018-06-01" }), false);
  assert.equal(inRange("2018-06-02", null), true);
  assert.equal(inRange(null, { from: "2018-01-01", to: "2018-12-31" }), false);
});

test("collections are shelves, never nights", () => {
  assert.deepEqual(nightsOf(cat).map((e) => e.id), ["n1", "n2", "n3", "n4"]);
});

test("anonymised copies and shelf tracks are not played tracks", () => {
  const ids = playedOf(cat).map((t) => t.id);
  assert.ok(!ids.includes("anon"), "an anonymised copy is the same playlist again");
  assert.ok(!ids.includes("shelf-1"), "a shelf is not a night");
});

test("a song is new only the first time, judged on all of history", () => {
  // s1 was first played in 2016. Looking at 2021 alone must not make it new.
  const y = (r: { from: string; to: string } | null) =>
    Object.fromEntries(discovery(cat, r).map((d) => [d.year, d]));
  assert.equal(y(null)["2016"].fresh, 3, "t1, t2 and t6 are all on the night it began");
  const only2021 = y({ from: "2021-01-01", to: "2021-12-31" });
  assert.equal(only2021["2021"].fresh, 0, "s1 is not new in 2021 just because 2016 is out of view");
});

test("everyone who had a song on its first night starts it", () => {
  const t = tastemakers(cat, 3);
  assert.equal(t.songs, 1, "only s1 reached three nights");
  assert.deepEqual(Object.fromEntries(t.rows.map((r) => [r.personId, r.count])), { p1: 1, p2: 1 });
});

test("a song played on two nights has not stuck", () => {
  assert.equal(tastemakers(cat, 3).rows.some((r) => r.count > 1), false);
  assert.equal(tastemakers(cat, 2).songs, 2);
});

test("a lifespan runs from the first year to the last", () => {
  const l = lifespans(cat);
  assert.equal(l[0].song.id, "s1");
  assert.equal(l[0].years, 10);
});

test("a comeback is a long gap, not merely a long life", () => {
  // s1 is played every few years, so it never vanished; s2 was gone ten years.
  const c = comebacks(cat, 5);
  assert.deepEqual(c.map((x) => x.song.id), ["s2"]);
  assert.ok(c[0].gapYears > 10.2 && c[0].gapYears < 10.3, "ten years and about three months");
});

test("an artist's loyalty counts years, not nights", () => {
  const l = artistYears(cat);
  const byName = Object.fromEntries(l.map((x) => [x.artist.name, x.years]));
  assert.equal(byName.A, 3, "2016, 2018, 2026");
  assert.equal(byName.B, 2, "three nights but only two different years");
});

test("the cast per year averages people per night", () => {
  const c = Object.fromEntries(cast(cat).map((y) => [y.year, y]));
  assert.equal(c["2021"].avgPeople, 3);
  assert.equal(c["2026"].people, 2);
});

test("an event label is not a genre, and a real genre that contains one is kept", () => {
  for (const label of ["Roll afterglow", "Trip afterglow", "20251108 Roll", "Roll", "Candyflip"]) {
    assert.equal(isEventLabel(label), true, label);
  }
  for (const real of ["Metal", "Alternative", "Trip Hop", "Folk", "Soundtrack"]) {
    assert.equal(isEventLabel(real), false, real);
  }
});

test("the genre chart drops labels and reports how little of it is genuine", () => {
  const ts = [
    tr("a", "n1", "s1", "p1", { genre: "Roll afterglow" }),
    tr("b", "n1", "s1", "p1", { genre: "Metal" }),
    tr("c", "n1", "s1", "p1", { genre: "Metal" }),
    tr("d", "n1", "s1", "p1", { genre: null }),
  ] as never[];
  assert.deepEqual(realGenres(ts), [{ genre: "Metal", count: 2 }]);
  assert.equal(genreCoverage(ts), 0.5);
});

test("the canon counts a song only once it has been played three times", () => {
  const { nights, at } = cumulative(cat);
  assert.deepEqual(nights.map((n) => n.id), ["n1", "n2", "n3", "n4"]);
  assert.equal(at[1].canon, 0, "s1 has been played twice");
  assert.equal(at[2].canon, 1, "the third night makes it canon");
  assert.equal(at[3].songs, 2);
  assert.equal(at[3].people, 3);
});

// ------------------------------------------------------------- the unusual

/** Nights per year, e.g. { "2014": 4, "2016": 1 }, each eight hours with two people. */
const yearsCat = (counts: Record<string, number>) => {
  const events: object[] = [];
  for (const [y, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) {
      events.push(ev(`${y}-${i}`, `${y}-0${1 + i}-10`, ["p1", "p2"],
        { durationSec: 8 * 3600, playedCount: 20, debuts: 10 }));
    }
  }
  return { events, songs: [], tracks: [], artists: [], people: [] } as never;
};
const trend = (c: never, key: string, r: { from: string; to: string } | null = null) =>
  trendBreaks(c, r).find((t) => t.key === key)!;
const flaggedYears = (c: never, key = "nights") =>
  trend(c, key).points.filter((p) => p.flagged).map((p) => p.year);

test("a steady decade breaks no trend", () => {
  const steady = yearsCat({ 2014: 4, 2015: 4, 2016: 4, 2017: 4, 2018: 4, 2019: 4, 2020: 4 });
  for (const t of trendBreaks(steady)) assert.deepEqual(t.breaks, [], t.key);
});

test("a huge year and a quiet year are flagged and their calm neighbours are not", () => {
  // The decade this library has: one enormous 2016 and a lone night in 2017.
  const c = yearsCat({ 2014: 3, 2015: 10, 2016: 1, 2017: 3, 2018: 3, 2019: 3 });
  assert.deepEqual(flaggedYears(c), ["2015", "2016"]);
});

test("a break reads as 'Nx fewer' against the years around it", () => {
  const c = yearsCat({ 2017: 6, 2018: 6, 2019: 2, 2020: 6, 2021: 6 });
  assert.equal(trend(c, "nights").breaks[0].reading,
    "2019: 3x fewer nights than the years around it (2 against 6)");
});

test("one night against two is not a break, however many times over", () => {
  assert.deepEqual(flaggedYears(yearsCat({ 2014: 2, 2015: 2, 2016: 1, 2017: 2, 2018: 2 })), []);
});

test("a year with no nights at all is a break of zero, not a missing point", () => {
  const c = yearsCat({ 2014: 4, 2015: 4, 2017: 4, 2018: 4 });
  const b = trend(c, "nights").breaks;
  assert.deepEqual(b.map((x) => x.year), ["2016"]);
  assert.equal(b[0].reading, "2016: none, where the years around it had 4");
  assert.equal(trend(c, "cast").points.some((p) => p.year === "2016"), false, "an average of nothing has no value");
});

test("narrowing the range narrows the series", () => {
  const c = yearsCat({ 2014: 3, 2015: 10, 2016: 1, 2017: 3, 2018: 3, 2019: 3 });
  const t = trend(c, "nights", { from: "2016-01-01", to: "2019-12-31" });
  assert.deepEqual(t.points.map((p) => p.year), ["2016", "2017", "2018", "2019"]);
});

test("the lowest results count ties and skip a night with no running time", () => {
  const n = (id: string, date: string, people: string[], sec: number) =>
    ev(id, date, people, { durationSec: sec, playedCount: 20, debuts: 10 });
  const c = {
    events: [n("a", "2016-01-01", ["p1", "p2"], 0), n("b", "2016-02-01", ["p1", "p2"], 7200),
      n("c", "2017-01-01", ["p1", "p2", "p3"], 9000)],
    songs: [], tracks: [], artists: [], people: [],
  } as never;
  const low = Object.fromEntries(lowest(c).map((l) => [l.key, l]));
  assert.equal(low.short.at.kind === "night" && low.short.at.id, "b", "a zero-length night is a data hole, not the shortest");
  assert.equal(low.small.ties, 1, "two nights share the smallest cast");
  assert.deepEqual(low.quiet.at, { kind: "year", year: "2017" });
});

// Three nights, p1 and p2, and what they brought.
const uc = () => {
  const events = [ev("u1", "2016-01-01", ["p1", "p2"]), ev("u2", "2017-01-01", ["p1", "p2"]), ev("u3", "2018-01-01", ["p1", "p2"])];
  const tracks = [
    tr("1", "u1", "a|x", "p1"), tr("2", "u2", "a|x", "p1"), tr("3", "u3", "a|x", "p1"),    // only p1
    tr("4", "u1", "b|y", "p1"), tr("5", "u2", "b|y", "p2"), tr("6", "u3", "b|y", "p1"),    // two people
    tr("7", "u1", "c|z", "p2"), tr("8", "u2", "c|z", "p2"), tr("9", "u3", "c|z", null),    // one unknown play
    tr("10", "u1", "d|w", "p1"), tr("11", "u2", "d|w", "p1"),                               // only two nights
    tr("12", "u1", "e|once", "p2"), tr("13", "u2", "e|twice", "p2"), tr("14", "u3", "e|twice", "p2"),
    tr("15", "u3", "f|dup", "p1"), tr("16", "u3", "f|dup", "p1"),                           // twice, same night
  ];
  const song = (id: string, nights: string[]) => ({ id, artist: id, title: id, variants: [], plays: nights.length,
    nights, people: [], firstPlayed: null, lastPlayed: null });
  const songs = [song("a|x", ["u1", "u2", "u3"]), song("b|y", ["u1", "u2", "u3"]), song("c|z", ["u1", "u2", "u3"]),
    song("d|w", ["u1", "u2"]), song("e|once", ["u1"]), song("e|twice", ["u2", "u3"]), song("f|dup", ["u3"])];
  const artists = ["a", "b", "c", "d", "e", "f"].map((id) => ({
    id, name: id.toUpperCase(), nights: songs.filter((s) => s.id.startsWith(id + "|")).flatMap((s) => s.nights),
    plays: 0, songs: 0, people: [], firstPlayed: null, lastPlayed: null,
  }));
  return { events, songs, tracks, artists, people: [] } as never;
};

test("'only Dov plays this' needs every play attributed to the same person", () => {
  const c = uc();
  assert.deepEqual(soloSongs(c).map((s) => [s.id, s.personId]), [["a|x", "p1"]],
    "b|y has two people, c|z has a play nobody claimed, d|w is only on two nights");
  // Artist e is p2's across two songs and three nights, though neither song reaches three.
  assert.deepEqual(soloArtists(c).map((s) => s.id), ["a", "e"]);
});

test("a song played twice on one night was not played once", () => {
  const o = oneOffs(uc());
  assert.equal(o.total, 1, "only e|once; f|dup was played twice, d|w on two nights");
  assert.equal(o.rows[0].song.id, "e|once");
});

test("a rising artist appears on more of the later nights than the earlier ones", () => {
  // Ten nights; "up" is on the last five, "down" on the first five, "flat" on all.
  const events = Array.from({ length: 10 }, (_, i) => ev(`e${i}`, `20${String(14 + i)}-01-01`, ["p1"]));
  const tracks: object[] = [];
  events.forEach((e: any, i) => {
    tracks.push(tr(`f${i}`, e.id, "flat|s", "p1"));
    tracks.push(tr(`${i > 4 ? "u" : "d"}${i}`, e.id, i > 4 ? "up|s" : "down|s", "p1"));
  });
  const artists = ["flat", "up", "down"].map((id) => ({ id, name: id, nights: [], plays: 0, songs: 0, people: [], firstPlayed: null, lastPlayed: null }));
  const c = { events, tracks, artists, songs: [], people: [] } as never;
  const e = evolutions(c, null, 5);
  assert.deepEqual(e.rising.map((t) => t.artist.id), ["up"]);
  assert.deepEqual(e.fading.map((t) => t.artist.id), ["down"]);
  assert.equal(e.rising[0].early, 0);
  assert.equal(e.rising[0].late, 1);
  assert.equal(evolutions(c, null, 6).rising.length, 0, "five nights is not enough when six are required");
});

// ------------------------------------------------------------------ sound quality

const au = (kbps: number | null, lossless = false) => ({ format: "mp3", lossless, kbps, sampleRate: 44100, bits: null });
const fileOf = (id: string, eventId: string, audio: object | undefined, over: object = {}) =>
  tr(id, eventId, null, "p1", { audio, source: "lib", ...over });

test("a lossless file is its own rung, and does not drag the lossy median", () => {
  const cat = { events, songs: [], tracks: [
    fileOf("a", "n1", au(320)), fileOf("b", "n1", au(128)), fileOf("c", "n1", au(900, true)),
  ] } as never;
  const [y] = qualityByYear(cat);
  assert.equal(y.lossless, 1);
  assert.equal(y.medianKbps, 320, "the median is of the two lossy files, 128 and 320");
});

test("a track that exists only in a Spotify playlist is not a file", () => {
  const cat = { events, songs: [], tracks: [
    fileOf("a", "n1", au(320)), fileOf("b", "n1", undefined, { source: "spotify" }),
  ] } as never;
  assert.deepEqual(qualityCoverage(cat), { files: 1, known: 1, noFile: 1 });
});

test("one rip does not make a small night the weakest", () => {
  const small = [fileOf("s", "n1", au(96))];
  const big = Array.from({ length: 12 }, (_, i) => fileOf(`b${i}`, "n2", au(i < 6 ? 96 : 320)));
  const w = weakestNights({ events, songs: [], tracks: [...small, ...big] } as never);
  assert.deepEqual(w.map((x) => x.event.id), ["n2"], "n1 has one file, below the floor");
});

test("a song with a lossless anonymised twin is not worth replacing", () => {
  // The named copy is a 96 kbps rip, but its anonymised twin is lossless: the
  // library already holds a good copy of the song.
  const cat = {
    events, songs: [song("s1", ["n1"], DATES)],
    tracks: [
      fileOf("named", "n1", au(96), { songId: "s1", twinId: "anon" }),
      fileOf("anon", "n1", au(900, true), { songId: null, twinId: "named", flags: ["anon"] }),
    ],
  } as never;
  assert.equal(upgradeCandidates(cat).total, 0);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
