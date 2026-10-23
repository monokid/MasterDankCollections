/** The Music page's numbers. Each test is named after the way a number could
 *  quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Event, Track } from "../src/catalog.ts";
import type { EnrichMap, EnrichRecord } from "../src/enrich.ts";
import { songHistory, artistHistory } from "../src/songstats.ts";
import {
  buildWall, facetCounts, factsOf, filterSongs, initialsOf, layoutRows, letterOf, matchesText,
  NO_FILTERS, sortKey, sortSongs, stripPos, tileArt, discography, artistOrder, type WallSong,
} from "../src/musicstats.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

let n = 0;
const ev = (id: string, over: Partial<Event> = {}) =>
  ({ id, kind: "event", date: id, types: ["roll"], ...over }) as Event;
const tr = (eventId: string, personId: string | null, over: Partial<Track> = {}) =>
  ({
    id: `t${++n}`, eventId, personId, phaseId: null, artist: "Ab", title: "Song", songId: "ab|song",
    twinId: null, playOrder: null, variant: null, played: true, flags: [], ...over,
  }) as Track;
const cat = (events: Event[], tracks: Track[]) =>
  ({
    events, tracks, phases: [],
    songs: [
      { id: "ab|song", artist: "Ab", title: "Song" }, { id: "ab|other", artist: "Ab", title: "Other" },
      { id: "cd|tune", artist: "Cd", title: "Tune" },
    ],
    artists: [{ id: "ab", name: "Ab" }, { id: "cd", name: "Cd" }],
    people: ["ann", "bo", "cy"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  }) as unknown as Catalog;

const E1 = "2020-01-01", E2 = "2021-06-01";

test("a song brought by two people on two nights is one entry, not four", () => {
  const w = buildWall(cat([ev(E1), ev(E2)], [
    tr(E1, "ann"), tr(E1, "bo"), tr(E2, "ann"), tr(E2, "bo"),
  ]));
  assert.equal(w.songs.length, 1);
  assert.equal(w.songs[0].nights, 2);
  assert.deepEqual(w.songs[0].people, ["ann", "bo"]);
  assert.deepEqual(w.songs[0].years, [2020, 2021]);
});

test("an anonymised twin and a Spotify duplicate do not make a second song or night", () => {
  const named = tr(E1, "ann", { id: "n1", twinId: "a1" });
  const anon = tr(E1, "ann", { id: "a1", twinId: "n1", songId: null, title: null, artist: null, flags: ["anon"] });
  const spot = tr(E1, "ann", { id: "s1", spotifyUri: "spotify:track:x" } as Partial<Track>);
  const w = buildWall(cat([ev(E1)], [named, anon, spot]));
  assert.equal(w.songs.length, 1);
  assert.equal(w.songs[0].nights, 1);
  assert.equal(w.unnamed, 0, "the twin resolved, so nothing is left unnamed");
});

test("the anonymised copy that was the only one played still counts, via its twin", () => {
  const named = tr(E1, "ann", { id: "n1", twinId: "a1", played: false });
  const anon = tr(E1, "ann", { id: "a1", twinId: "n1", songId: null, title: null, flags: ["anon"] });
  assert.equal(buildWall(cat([ev(E1)], [named, anon])).songs.length, 1);
});

test("unplayed copies, collections and undated nights add no songs", () => {
  const w = buildWall(cat(
    [ev(E1), ev("favs", { kind: "collection", date: null }), ev("x", { date: null })],
    [tr(E1, "ann", { played: false }), tr("favs", "ann"), tr("x", "ann")]));
  assert.equal(w.songs.length, 0);
});

test("songs with no artist are grouped under no artist, not dropped", () => {
  const w = buildWall(cat([ev(E1)], [
    tr(E1, "ann", { songId: null, artist: null, title: "Pamplemouse Polka" }),
    tr(E1, "bo", { songId: null, artist: null, title: "Pamplemouse Polka" }),
    tr(E1, "bo", { songId: null, artist: null, title: "Another Orphan" }),
  ]));
  assert.equal(w.songs.length, 2, "same orphan title counted once");
  assert.ok(w.songs.every((s) => s.artistId === null && s.artist === "" && s.loose));
});

test("an anonymised leftover with no name is counted as unnamed, not shown as a song", () => {
  const w = buildWall(cat([ev(E1)], [tr(E1, "ann", { songId: null, artist: null, title: "Rico 02", flags: ["anon"] })]));
  assert.equal(w.songs.length, 0);
  assert.equal(w.unnamed, 1);
});

test("the wall agrees with songHistory on nights and people for every song, and with artistHistory on songs", () => {
  const c = cat([ev(E1), ev(E2)], [
    tr(E1, "ann"), tr(E1, "bo"), tr(E2, "ann", { songId: "ab|other", title: "Other" }),
    tr(E2, "cy", { songId: "cd|tune", artist: "Cd", title: "Tune" }),
    tr(E1, "bo", { id: "n1", twinId: "a1" }), tr(E1, "bo", { id: "a1", twinId: "n1", songId: null, flags: ["anon"] }),
  ]);
  const w = buildWall(c);
  for (const s of w.songs) {
    const h = songHistory(c, s.songId);
    assert.equal(s.nights, h.nights, s.songId);
    assert.deepEqual([...s.people].sort(), h.people.map((p) => p.personId).sort(), s.songId);
    assert.equal(s.firstDate, h.first!.date);
    assert.equal(s.lastDate, h.last!.date);
  }
  for (const a of w.artists.values()) {
    const h = artistHistory(c, a.id);
    assert.equal(a.songs, h.songCount);
    assert.equal(a.nights, h.nights);
  }
});

test("the same input in a different track order gives the same wall", () => {
  const ts = [tr(E1, "ann"), tr(E2, "bo", { songId: "ab|other", title: "Other" }), tr(E2, "cy", { songId: "cd|tune", artist: "Cd", title: "Tune" })];
  const a = buildWall(cat([ev(E1), ev(E2)], ts)).songs.map((s) => s.songId);
  const b = buildWall(cat([ev(E2), ev(E1)], [...ts].reverse())).songs.map((s) => s.songId);
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------- letters

test("letter buckets: Latin, accents, digits, symbols, emoji and other scripts land where documented", () => {
  const b = (t: string) => letterOf(sortKey(t));
  assert.equal(b("Ghost Love Score"), "G");
  assert.equal(b("Éclair"), "E", "accent folds to its base letter");
  assert.equal(b("Øresund"), "O");
  assert.equal(b("99 Luftballons"), "#");
  assert.equal(b("+♂"), "#", "symbol-only titles");
  assert.equal(b("🎵 Party"), "P", "emoji is dropped by the fold");
  assert.equal(b("🎵"), "#", "emoji-only title");
  assert.equal(b("東方 Vocal"), "…");
  assert.equal(b("Привет"), "…");
  assert.equal(b("ひとり"), "…");
});

test("a leading 'The ' is ignored for sorting, but a title that is only 'The' is kept", () => {
  assert.equal(sortKey("The Prodigy"), "prodigy");
  assert.equal(sortKey("The"), "the");
  assert.equal(sortKey("Theory of a Deadman"), "theory of a deadman");
  assert.equal(sortKey("(Don't Fear) The Reaper"), "don t fear the reaper");
});

test("A-Z order: # first, letters, then other scripts last; numbers sort by value; ties keep id order", () => {
  const songs = ["Zebra", "東方", "10 Things", "2 Things", "apple", "The Beta", "Beta"].map((t, i) => [`x|${i}`, t]);
  const tracks = songs.map(([id, t]) => tr(E1, "ann", { songId: id, title: t, artist: "X" }));
  const c = cat([ev(E1)], tracks);
  const w = buildWall(c);
  assert.deepEqual(w.songs.map((s) => s.title), ["2 Things", "10 Things", "apple", "The Beta", "Beta", "Zebra", "東方"]);
});

// ---------------------------------------------------------------- filters

const rec = (over: Partial<EnrichRecord>): EnrichRecord => ({
  songId: "", confidence: "high", year: null, genres: [], country: null, releaseGroup: null, cover: false, ...over,
});

function enrichedWall() {
  const c = cat([ev(E1), ev(E2)], [
    tr(E1, "ann"), tr(E2, "bo", { songId: "ab|other", title: "Other" }),
    tr(E2, "cy", { songId: "cd|tune", artist: "Cd", title: "Tune" }),
  ]);
  const enrich: EnrichMap = {
    "ab|song": rec({ year: 1987, family: "metal", cover: true, coverUrl: "https://x/y.jpg" }),
    "ab|other": rec({ year: 1999, yearSuspect: true, family: "metal" }),
    "cd|tune": rec({ confidence: "none", year: 1975, family: "rock" }),
  };
  const w = buildWall(c);
  return { w, facts: factsOf(w, enrich) };
}

test("decade and year filters ignore songs with no enrichment instead of treating them as year 0", () => {
  const { w, facts } = enrichedWall();
  const got = filterSongs(w.songs, { ...NO_FILTERS, decade: "1980s" }, facts).map((s) => s.songId);
  assert.deepEqual(got, ["ab|song"]);
  assert.equal(facts.has("cd|tune"), false, "an unmatched record gives no facts at all");
  assert.equal(facts.get("ab|other")!.year, null, "a suspect year is not believed");
  assert.deepEqual(facetCounts(w.songs, NO_FILTERS, facts, "decade"), [["1980s", 1]]);
});

test("the release-year sort puts unknown years last, not first", () => {
  const { w, facts } = enrichedWall();
  const sorted = sortSongs(w.songs, "year", facts).map((s) => s.songId);
  assert.equal(sorted[0], "ab|song");
  assert.deepEqual(sorted.slice(1), ["ab|other", "cd|tune"], "unknown years keep A-Z order");
});

test("with no enrichment at all the filters and sorts still work", () => {
  const c = cat([ev(E1)], [tr(E1, "ann")]);
  const w = buildWall(c);
  const facts = factsOf(w, null);
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, coverOnly: true }, facts).length, 0);
  assert.equal(sortSongs(w.songs, "year", facts).length, 1);
  assert.equal(filterSongs(w.songs, NO_FILTERS, facts).length, 1);
});

test("a since/until window keeps a song only if one of its own years falls inside it", () => {
  const w = buildWall(cat([ev("2015-01-01"), ev("2025-01-01")], [tr("2015-01-01", "ann"), tr("2025-01-01", "ann")]));
  const f = factsOf(w, null);
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, since: 2018, until: 2022 }, f).length, 0, "brought in 2015 and 2025, never in between");
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, since: 2020 }, f).length, 1);
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, until: 2016 }, f).length, 1);
});

test("the text filter forgives accents, punctuation, word order and missing spaces", () => {
  const w = buildWall(cat([ev(E1)], [tr(E1, "ann", { songId: "mot|tete", artist: "Mötley Crüe", title: "Girls, Girls, Girls" })]));
  const s = w.songs[0];
  for (const q of ["motley", "girls crue", "Crue Girls", "motleycrue", "  GIRLS  "]) assert.ok(matchesText(s, q), q);
  assert.ok(!matchesText(s, "zzz"));
});

test("person and kind-of-night filters match what the song really has", () => {
  const w = buildWall(cat([ev(E1, { types: ["trip"] }), ev(E2)], [tr(E1, "ann"), tr(E2, "bo")]));
  const f = factsOf(w, null);
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, personId: "bo" }, f).length, 1);
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, personId: "cy" }, f).length, 0);
  assert.equal(filterSongs(w.songs, { ...NO_FILTERS, type: "trip" }, f).length, 1);
  assert.deepEqual(facetCounts(w.songs, NO_FILTERS, f, "type"), [["roll", 1], ["trip", 1]]);
});

test("a stable sort: equal values stay in A-Z order", () => {
  const ts = ["Bb", "Aa", "Cc"].map((t, i) => tr(E1, "ann", { songId: `x|${i}`, title: t, artist: "X" }));
  const w = buildWall(cat([ev(E1)], ts));
  assert.deepEqual(sortSongs(w.songs, "nights", new Map()).map((s) => s.title), ["Aa", "Bb", "Cc"]);
});

// ---------------------------------------------------------------- layout

test("grouped rows start every letter on a fresh row, and no song is lost or repeated", () => {
  const mk = (b: string, i: number) => ({ bucket: b, songId: String(i) }) as unknown as WallSong;
  const songs = ["A", "A", "A", "B", "C", "C"].map(mk);
  const rows = layoutRows(songs, 2, true);
  assert.deepEqual(rows.map((r) => (r.kind === "head" ? r.letter : `${r.from}-${r.to}`)),
    ["A", "0-2", "2-3", "B", "3-4", "C", "4-6"]);
  const flat = layoutRows(songs, 4, false);
  assert.deepEqual(flat.map((r) => (r.kind === "tiles" ? r.to - r.from : -1)), [4, 2]);
});

// ---------------------------------------------------------------- artist

test("an artist's discography orders by first night, then most nights, then A-Z", () => {
  const c = cat([ev(E1), ev(E2)], [
    tr(E2, "ann"), tr(E1, "ann", { songId: "ab|other", title: "Other" }), tr(E2, "bo", { songId: "ab|other", title: "Other" }),
  ]);
  const w = buildWall(c);
  assert.deepEqual(discography(w, "ab", "first").map((s) => s.title), ["Other", "Song"]);
  assert.deepEqual(discography(w, "ab", "nights").map((s) => s.title), ["Other", "Song"]);
  assert.deepEqual(discography(w, "ab", "az").map((s) => s.title), ["Other", "Song"]);
  assert.deepEqual(discography(w, "nobody", "az"), []);
  assert.deepEqual(artistOrder(w.songs, "az", w), ["ab"]);
});

test("a night at the very start or end of the decade sits at the edge of the strip, not outside it", () => {
  assert.equal(stripPos("2015-01-01", 2015, 2026), 0);
  assert.equal(stripPos("2026-12-31", 2015, 2026), 1);
  assert.equal(stripPos("2010-01-01", 2015, 2026), 0);
  assert.equal(stripPos("2015-07-01", 2015, 2015) > 0.4, true);
});

// ------------------------------------------------------------------ tiles

test("a tile's art is the same every time for a song and differs between songs", () => {
  assert.deepEqual(tileArt("ab|song"), tileArt("ab|song"));
  assert.notDeepEqual(tileArt("ab|song"), tileArt("ab|other"));
  const a = tileArt("x");
  assert.ok(a.h1 >= 0 && a.h1 < 360 && a.h2 >= 0 && a.h2 < 360 && a.h1 !== a.h2);
});

test("initials survive one-word, accented, CJK and symbol-only titles", () => {
  assert.equal(initialsOf("Ghost Love Score"), "GL");
  assert.equal(initialsOf("The Prodigy"), "PR");
  assert.equal(initialsOf("Émile"), "ÉM");
  assert.equal(initialsOf("東方 Vocal"), "東V");
  assert.equal(initialsOf("+♂"), "+");
  assert.equal(initialsOf(""), "♪");
});

if (failures.length) {
  console.error(`musicstats: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`musicstats: ${passed} passed`);
