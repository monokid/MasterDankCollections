/** People profiles. Each test is named after the way a number could quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Event, Track } from "../src/catalog.ts";
import type { EnrichMap } from "../src/enrich.ts";
import {
  awayPhrase, awayStretches, collective, describe, galleryCards, musicProfile, neighbours,
  peopleIndex, profileOf, summaryText,
} from "../src/peoplestats.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

let n = 0;
const ev = (id: string, over: Partial<Event> = {}) =>
  ({ id, kind: "event", date: id, types: ["roll"], ...over }) as Event;
const tr = (eventId: string, personId: string | null, song: string | null, over: Partial<Track> = {}) =>
  ({
    id: `t${++n}`, eventId, personId, phaseId: null, artist: song?.split("|")[0] ?? null, title: song?.split("|")[1] ?? null,
    songId: song, twinId: null, playOrder: null, variant: null, played: true, flags: [], durationSec: 200, ...over,
  }) as Track;
const cat = (events: Event[], tracks: Track[], names = ["ann", "bo", "cy"]) =>
  ({
    events, tracks, phases: [], songs: [], artists: [],
    people: names.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  }) as unknown as Catalog;

const N = ["2016-01-01", "2016-02-01", "2017-01-01", "2018-01-01", "2019-01-01", "2020-01-01", "2020-06-01"];
const events = N.map((d) => ev(d));

test("an anonymised twin and its named copy count a song once", () => {
  const named = tr(N[0], "ann", "a|x", { id: "n1", twinId: "z1", played: false });
  const anon = tr(N[0], "ann", null, { id: "z1", twinId: "n1", flags: ["anon"] });
  const named2 = tr(N[1], "ann", "a|y", { id: "n2", twinId: "z2" });
  const anon2 = tr(N[1], "ann", null, { id: "z2", twinId: "n2", flags: ["anon"], played: false });
  const c = cat(events, [named, anon, named2, anon2]);
  const p = profileOf(c, "ann")!;
  assert.equal(p.plays, 2);
  assert.equal(p.songs, 2);   // the anon-only play took its twin's song
});

test("the same song twice in one person's night (plain and Live, Spotify duplicate) is one song, one play", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[0], "ann", "a|x", { variant: "Live" }), tr(N[0], "ann", "a|x", { source: "spotify" } as Partial<Track>)]);
  const p = profileOf(c, "ann")!;
  assert.equal(p.plays, 1);
  assert.equal(p.songs, 1);
});

test("a track with no song identity is a play but not a song", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[0], "ann", null), tr(N[0], "ann", null)]);
  const p = profileOf(c, "ann")!;
  assert.equal(p.plays, 3);
  assert.equal(p.songs, 1);
});

test("unplayed copies and collections never count", () => {
  const c = cat([...events, ev("favs", { kind: "collection", date: null })], [
    tr(N[0], "ann", "a|x", { played: false }), tr("favs", "ann", "a|y"),
  ]);
  assert.equal(profileOf(c, "ann")!.nights, 0);
});

test("an unattributed track belongs to nobody", () => {
  const c = cat(events, [tr(N[0], null, "a|x"), tr(N[0], null, null), tr(N[1], "ann", "a|y")]);
  assert.equal(profileOf(c, "ann")!.plays, 1);
  assert.equal(profileOf(c, "bo")!.nights, 0);
});

test("first brought: the earliest night in the library wins, ties credit everyone that night", () => {
  const c = cat(events, [
    tr(N[0], "cy", "o|opening"),                       // opening night: nothing before it
    tr(N[1], "ann", "a|x"), tr(N[1], "bo", "a|x"),     // same night: both introduced it
    tr(N[2], "cy", "a|x"),                              // later: not first
    tr(N[3], "cy", "a|solo"),
  ]);
  assert.deepEqual(profileOf(c, "ann")!.firstBrought.map((s) => s.songId), ["a|x"]);
  assert.deepEqual(profileOf(c, "bo")!.firstBrought.map((s) => s.songId), ["a|x"]);
  assert.deepEqual(profileOf(c, "cy")!.firstBrought.map((s) => s.songId), ["a|solo"]);
});

test("the library's opening night introduces nothing", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[1], "ann", "a|y")]);
  const p = profileOf(c, "ann")!;
  assert.deepEqual(p.firstBrought.map((s) => s.songId), ["a|y"]);
});

test("an earlier unattributed play means a later person did not introduce the song", () => {
  const c = cat(events, [tr(N[0], "cy", "o|z"), tr(N[1], null, "a|x"), tr(N[2], "ann", "a|x")]);
  assert.equal(profileOf(c, "ann")!.firstBrought.length, 0);
});

test("hits that stayed count nights AFTER the first, and need 3 of them", () => {
  const mk = (later: number) => cat(events, [
    tr(N[0], "cy", "o|z"), tr(N[1], "ann", "a|x"),
    ...N.slice(2, 2 + later).map((d) => tr(d, "bo", "a|x")),
  ]);
  assert.equal(profileOf(mk(2), "ann")!.seeds.length, 0);     // 3 nights in all, 2 after the first
  const s = profileOf(mk(3), "ann")!.seeds;
  assert.equal(s.length, 1);
  assert.equal(s[0].nightsAfter, 3);
  assert.equal(s[0].others, 1);                                // Bo carried it on
});

test("carriers of a seed exclude the person themself and count each person once", () => {
  const c = cat(events, [
    tr(N[0], "cy", "o|z"), tr(N[1], "ann", "a|x"), tr(N[2], "ann", "a|x"), tr(N[3], "ann", "a|x"),
    tr(N[4], "bo", "a|x"), tr(N[5], "bo", "a|x"),
  ]);
  const s = profileOf(c, "ann")!.seeds[0];
  assert.equal(s.nightsAfter, 4);
  assert.equal(s.others, 1);
});

test("attendance is measured against nights within the active span, not the decade", () => {
  const c = cat(events, [tr(N[2], "ann", "a|x"), tr(N[4], "ann", "a|y")]);
  const p = profileOf(c, "ann")!;
  assert.equal(p.possible, 3);   // 2017, 2018, 2019
  assert.equal(p.nights, 2);
  assert.ok(Math.abs(p.attendedShare - 2 / 3) < 1e-9);
  assert.equal(p.strip.filter((s) => s.inSpan).length, 3);
});

test("a person with no nights has an empty, non-crashing profile", () => {
  const p = profileOf(cat(events, [tr(N[0], "ann", "a|x")]), "bo")!;
  assert.equal(p.nights, 0);
  assert.equal(p.attendedShare, 0);
  assert.equal(p.line, null);
  assert.equal(p.span, "no nights on record");
  assert.deepEqual(p.outliers, []);
  assert.ok(summaryText(cat(events, []), "bo", null).includes("No nights"));
});

test("a catalogue with no nights does not divide by zero", () => {
  const c = cat([], []);
  assert.equal(collective(c).nights, 0);
  assert.equal(profileOf(c, "ann")!.attendedShare, 0);
  assert.equal(galleryCards(c).length, 3);
});

test("an unknown person id gives no profile", () => {
  assert.equal(profileOf(cat(events, []), "nobody"), null);
});

test("a single-night person: 'a presence in', no invented outliers or readings", () => {
  const c = cat(events, [tr(N[0], "cy", "o|z"), tr(N[1], "ann", "a|x"), tr(N[1], "ann", "a|y")]);
  const p = profileOf(c, "ann")!;
  assert.equal(p.line, "a presence in 2016");
  assert.equal(p.span, "only 2016");
  assert.equal(p.possible, 1);
  assert.deepEqual(p.outliers, []);
  assert.deepEqual(p.readings, []);
  assert.equal(p.away.length, 0);
});

test("people are listed by when they first appeared, ties by name", () => {
  const c = cat(events, [
    tr(N[3], "cy", "a|x"), tr(N[1], "bo", "a|y"), tr(N[1], "ann", "a|z"),
  ]);
  assert.deepEqual(galleryCards(c).map((x) => x.id), ["ann", "bo", "cy"]);
  const c2 = cat(events, [tr(N[3], "ann", "a|x"), tr(N[1], "cy", "a|y")]);
  assert.deepEqual(galleryCards(c2).map((x) => x.id), ["cy", "ann", "bo"]);   // never-seen last
});

test("colour follows the person's place in cat.people, not join order", () => {
  const c = cat(events, [tr(N[1], "cy", "a|x"), tr(N[3], "ann", "a|y")]);
  const cards = galleryCards(c);
  assert.equal(cards.find((x) => x.id === "cy")!.colourIndex, 2);
  assert.equal(cards.find((x) => x.id === "ann")!.colourIndex, 0);
});

test("prev/next neighbours follow join order and wrap", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[1], "bo", "a|y"), tr(N[2], "cy", "a|z")]);
  assert.equal(neighbours(c, "ann").prev!.id, "cy");
  assert.equal(neighbours(c, "bo").next!.id, "cy");
  assert.equal(neighbours(c, "zz").next, null);
});

test("away stretches are whole years with nights, and a year with no nights is not a break", () => {
  const years = [2016, 2017, 2018, 2020, 2021];             // nobody met in 2019
  assert.deepEqual(awayStretches(years, new Set([2016, 2021])), [{ from: 2017, to: 2020, backIn: 2021 }]);
  assert.deepEqual(awayStretches(years, new Set([2016, 2017, 2018, 2020])), []);
  assert.deepEqual(awayStretches(years, new Set([2016, 2018, 2021])), [
    { from: 2017, to: 2017, backIn: 2018 }, { from: 2020, to: 2020, backIn: 2021 }]);
  assert.deepEqual(awayStretches(years, new Set()), []);
  assert.equal(awayPhrase({ from: 2017, to: 2020, backIn: 2021 }), "away 2017–2020, back in 2021");
  assert.equal(awayPhrase({ from: 2017, to: 2017, backIn: 2018 }), "away in 2017, back in 2018");
});

test("the descriptive line only says what is true, one line, no superlatives", () => {
  const base = {
    nights: 5, firstYear: 2016, lastYear: 2020, libraryFirstYear: 2016, attendedOpening: false,
    away: [], onlyTheirsArtists: 0, artists: 40, yearsPresent: 4, yearsInSpan: 5,
  };
  assert.equal(describe({ ...base, nights: 0, firstYear: null, lastYear: null }), null);
  assert.equal(describe({ ...base, nights: 1 }), "a presence in 2016");
  assert.equal(describe({ ...base, firstYear: 2023, lastYear: 2025 }), "joined in 2023");
  assert.equal(describe({ ...base, attendedOpening: true }), "there from the start");
  assert.equal(describe({ ...base, away: [{ from: 2017, to: 2017, backIn: 2018 }, { from: 2019, to: 2019, backIn: 2020 }], attendedOpening: true }), "returns after long breaks");
  assert.equal(describe({ ...base, onlyTheirsArtists: 30, artists: 40 }), "brings music nobody else does");
  assert.equal(describe({ ...base, onlyTheirsArtists: 20, artists: 40 }), "there in 4 of the 5 years");     // under three quarters
  assert.equal(describe({ ...base, onlyTheirsArtists: 9, artists: 10 }), "there in 4 of the 5 years");      // under ten artists
  assert.equal(describe({ ...base, away: [{ from: 2018, to: 2019, backIn: 2020 }] }), "back in 2020 after time away");
  assert.equal(describe({ ...base, lastYear: 2016, yearsInSpan: 1, yearsPresent: 1 }), "a presence in 2016");   // several nights, one year
  // a first-year person who simply attended the opening night is not "joined"
  assert.notEqual(describe({ ...base, attendedOpening: true }), "joined in 2016");
});

test("'there from the start' needs the opening night, not just the first year", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[2], "ann", "a|y"), tr(N[1], "bo", "a|z"), tr(N[2], "bo", "a|w")]);
  assert.equal(profileOf(c, "ann")!.line, "there from the start");
  assert.notEqual(profileOf(c, "bo")!.line, "there from the start");
});

test("a year is only called out when it rests on 2+ nights and clears every other year", () => {
  // ann: 2016 two nights of 2 songs, 2017 one night of 10 songs, 2018 one night of 2: 2017 is a single night, so no call-out
  const t: Track[] = [];
  t.push(tr(N[0], "ann", "a|1"), tr(N[0], "ann", "a|2"), tr(N[1], "ann", "a|3"), tr(N[1], "ann", "a|4"));
  for (let i = 0; i < 10; i++) t.push(tr(N[2], "ann", `a|b${i}`));
  t.push(tr(N[3], "ann", "a|5"), tr(N[3], "ann", "a|6"));
  assert.deepEqual(profileOf(cat(events, t), "ann")!.readings.filter((r) => r.includes("sets")), []);

  // now 2017 has two long nights: it clears the others
  const t2: Track[] = [tr(N[0], "ann", "a|1"), tr(N[0], "ann", "a|2"), tr(N[3], "ann", "a|5"), tr(N[3], "ann", "a|6")];
  for (let i = 0; i < 8; i++) t2.push(tr(N[2], "ann", `a|b${i}`));
  t2.push(tr(N[4], "ann", "a|7"), tr(N[4], "ann", "a|8"));
  const c2 = cat([...events, ev("2017-02-01")], [...t2, ...Array.from({ length: 8 }, (_, i) => tr("2017-02-01", "ann", `a|c${i}`))]);
  const r = profileOf(c2, "ann")!.readings;
  assert.ok(r.includes("2017: longer sets than any other year of theirs"), r.join(" / "));
});

test("new music share ignores the opening night and counts ties as new for everyone", () => {
  const c = cat(events, [
    tr(N[0], "ann", "o|1"),                                   // opening night: not judged
    tr(N[1], "ann", "a|x"), tr(N[1], "bo", "a|x"), tr(N[1], "ann", "o|1"),
  ]);
  const y = profileOf(c, "ann")!.yearly.find((r) => r.year === 2016)!;
  assert.equal(y.newShare, 0.5);                              // a|x new, o|1 not; the opening night is out
  assert.equal(profileOf(c, "bo")!.yearly[0].newShare, 1);
});

test("outliers: the song only they ever brought, back on several nights, with a link", () => {
  const c = cat(events, [
    tr(N[0], "ann", "a|mine"), tr(N[1], "ann", "a|mine"), tr(N[2], "ann", "a|mine"),
    tr(N[0], "ann", "a|shared"), tr(N[1], "bo", "a|shared"), tr(N[2], "bo", "a|shared"),
  ]);
  const o = profileOf(c, "ann")!.outliers.filter((x) => x.songId);
  assert.deepEqual(o.map((x) => x.songId), ["a|mine"]);
  // an unattributed play of it means we cannot say nobody else brought it
  const c2 = cat(events, [...c.tracks, tr(N[3], null, "a|mine")]);
  assert.equal(profileOf(c2, "ann")!.outliers.filter((x) => x.songId).length, 0);
});

test("a gap with no nights in it is not a comeback", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[1], "ann", "a|y")]);
  assert.ok(!profileOf(c, "ann")!.outliers.some((o) => /back after/.test(o.text)));
  const c2 = cat(events, [tr(N[0], "ann", "a|x"), tr(N[5], "ann", "a|y")]);
  assert.ok(profileOf(c2, "ann")!.outliers.some((o) => /back after about 4 years away/.test(o.text)));
});

test("only-theirs artists are not claimed when an unattributed play of the artist exists", () => {
  const c = cat(events, [tr(N[0], "ann", "solo|a"), tr(N[1], "ann", "solo|b"), tr(N[1], "ann", "free|c"), tr(N[2], null, "free|d")]);
  assert.deepEqual(profileOf(c, "ann")!.onlyTheirs.map((a) => a.id), ["solo"]);
});

test("overlap is symmetrical, and counts artists, not plays", () => {
  const c = cat(events, [
    tr(N[0], "ann", "x|1"), tr(N[0], "ann", "x|2"), tr(N[0], "ann", "x|3"), tr(N[1], "ann", "y|1"),
    tr(N[0], "ann", "p|1"), tr(N[0], "ann", "q|1"), tr(N[0], "ann", "r|1"),
    tr(N[1], "bo", "x|9"), tr(N[1], "bo", "p|9"), tr(N[1], "bo", "q|9"), tr(N[1], "bo", "z|1"),
    tr(N[2], "cy", "x|8"),   // one artist in common is chance, not shown
  ]);
  const a = profileOf(c, "ann")!.overlaps.find((o) => o.id === "bo")!;
  const b = profileOf(c, "bo")!.overlaps.find((o) => o.id === "ann")!;
  assert.equal(a.shared, 3);
  assert.equal(a.union, 6);   // ann: x y p q r, bo: x p q z

  assert.equal(a.share, b.share);
  assert.equal(profileOf(c, "ann")!.overlaps.some((o) => o.id === "ann"), false);
  assert.equal(profileOf(c, "ann")!.overlaps.some((o) => o.id === "cy"), false);
});

test("decade and genre need 30% coverage and say how much they know", () => {
  const c = cat(events, [tr(N[0], "ann", "a|1"), tr(N[0], "ann", "a|2"), tr(N[0], "ann", "a|3"), tr(N[0], "ann", "a|4")]);
  const rec = (id: string, year: number | null, family: string | null) =>
    ({ songId: id, confidence: "high", year, genres: [], family, country: null, releaseGroup: null, cover: false });
  assert.equal(musicProfile(c, "ann", null), null);
  assert.equal(musicProfile(c, "ann", { "a|1": rec("a|1", 1987, "rock") } as EnrichMap), null);   // 1 of 4
  const m = musicProfile(c, "ann", {
    "a|1": rec("a|1", 1987, "rock"), "a|2": rec("a|2", 1989, "rock"), "a|3": rec("a|3", 2001, null),
    "a|4": { ...rec("a|4", 1950, "jazz"), confidence: "none" },                                   // no match: ignored
  } as EnrichMap)!;
  assert.equal(m.total, 4);
  assert.deepEqual(m.decades, [{ decade: "1980s", songs: 2 }, { decade: "2000s", songs: 1 }]);
  assert.deepEqual(m.families, [{ family: "rock", songs: 2 }]);
  assert.equal(m.withYear, 3);
  assert.equal(m.withFamily, 2);
});

test("a suspect release year is left out of the decades", () => {
  const c = cat(events, [tr(N[0], "ann", "a|1")]);
  const m = musicProfile(c, "ann", { "a|1": { songId: "a|1", confidence: "high", year: 2030, yearSuspect: true, genres: [], family: "rock", country: null, releaseGroup: null, cover: false } })!;
  assert.deepEqual(m.decades, []);
  assert.equal(m.withFamily, 1);
});

test("group size: each night counts the people who were there once", () => {
  const c = cat(events, [
    tr(N[0], "ann", "a|1"), tr(N[0], "ann", "a|2"), tr(N[0], "bo", "a|3"),
    tr(N[1], "ann", "a|4"),
  ]);
  const co = collective(c);
  assert.equal(co.people, 2);
  assert.equal(co.sizes[2], 1);
  assert.equal(co.sizes[1], 1);
  assert.equal(co.sizes[0], events.length - 2);
  assert.equal(co.byYear[0].sizes[0], 2);
});

test("the index is built once per catalogue", () => {
  const c = cat(events, [tr(N[0], "ann", "a|1")]);
  assert.equal(peopleIndex(c), peopleIndex(c));
  assert.equal(profileOf(c, "ann"), profileOf(c, "ann"));
});

test("the summary text carries no ranking words", () => {
  const c = cat(events, [tr(N[0], "ann", "a|x"), tr(N[1], "ann", "a|y"), tr(N[5], "ann", "a|z")]);
  const t = summaryText(c, "ann", null);
  assert.ok(t.startsWith("Ann ("));
  assert.ok(!/\b(top|best|most active|winner|rank)/i.test(t), t);
});

if (failures.length) {
  console.error(`peoplestats: ${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`peoplestats: ${passed} tests passed`);
