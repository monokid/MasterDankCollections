/** Shared song-row logic. Each test is named after the way a row could quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Track } from "../src/catalog.ts";
import type { EnrichMap, EnrichRecord } from "../src/enrich.ts";
import { albumOf, dateOf, yearOf } from "../src/enrich.ts";
import {
  cleanChoice, fmtDuration, isOn, NO_CHOICE, songColumns, songFactsFor, sortRows, spotifyHref,
  tagGenres, toggleColumn, visibleColumns, youtubeHref, type Column,
} from "../src/songcols.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const trk = (id: string, over: Partial<Track> = {}): Track => ({
  id, eventId: "e1", personId: "p1", phaseId: null, artist: "Aphex Twin", title: "Xtal", album: null, genre: null,
  songId: "aphex|xtal", twinId: null, playOrder: null, variant: null, durationSec: 290, ext: "mp3",
  sizeBytes: 1, path: [], source: "s", played: true, flags: [], provenance: {}, ...over,
});
const catOf = (tracks: Track[], nights = ["e1", "e2"]): Catalog => ({
  events: [], people: [], phases: [], artists: [], tracks,
  songs: [{ id: "aphex|xtal", artist: "Aphex Twin", title: "Xtal", variants: [], plays: tracks.length, nights,
    people: [], firstPlayed: null, lastPlayed: null }],
} as unknown as Catalog);
const rec = (over: Partial<EnrichRecord> = {}): EnrichRecord => ({
  songId: "aphex|xtal", confidence: "high", year: 1992, genres: [], family: "ambient/downtempo", country: null,
  releaseGroup: null, cover: false, ...over,
});
const map = (r: EnrichRecord): EnrichMap => ({ [r.songId]: r });

// ----------------------------------------------------------------- sorting
const rows = [{ n: "b", v: 2 }, { n: "x", v: null }, { n: "a", v: 1 }, { n: "y", v: null }, { n: "c", v: 3 }];
test("unknown values sort last ascending", () => {
  assert.deepEqual(sortRows(rows, (r) => r.v, "asc").map((r) => r.n), ["a", "b", "c", "x", "y"]);
});
test("unknown values sort last descending too (not first)", () => {
  assert.deepEqual(sortRows(rows, (r) => r.v, "desc").map((r) => r.n), ["c", "b", "a", "x", "y"]);
});
test("equal values keep their incoming order in both directions (stable)", () => {
  const eq = [{ n: 1, v: 5 }, { n: 2, v: 5 }, { n: 3, v: 5 }];
  assert.deepEqual(sortRows(eq, (r) => r.v, "asc").map((r) => r.n), [1, 2, 3]);
  assert.deepEqual(sortRows(eq, (r) => r.v, "desc").map((r) => r.n), [1, 2, 3]);
});
test("a zero sorts as a number, not as unknown", () => {
  assert.deepEqual(sortRows([{ v: null }, { v: 0 }, { v: 1 }], (r) => r.v, "asc").map((r) => r.v), [0, 1, null]);
});
test("sorting does not reorder the input", () => {
  const copy = [...rows];
  sortRows(rows, (r) => r.v, "asc");
  assert.deepEqual(rows, copy);
});

// ---------------------------------------------------------------- duration
test("duration at 59:59 stays minutes:seconds", () => assert.equal(fmtDuration(3599), "59:59"));
test("duration at exactly an hour is 1:00:00", () => assert.equal(fmtDuration(3600), "1:00:00"));
test("duration rounds before splitting: 3599.6 is 1:00:00, never 59:60", () => assert.equal(fmtDuration(3599.6), "1:00:00"));
test("duration past an hour pads minutes and seconds", () => assert.equal(fmtDuration(3723), "1:02:03"));
test("zero, negative, NaN and null durations are unknown, not 0:00", () => {
  for (const v of [0, -5, NaN, null, undefined]) assert.equal(fmtDuration(v as number), null);
});

// ------------------------------------------------------------------- links
const f = (artist: string | null, title: string, spotifyUri: string | null = null) => ({ artist, title, spotifyUri });
test("a spotify:track URI becomes an exact track link", () => {
  assert.deepEqual(spotifyHref(f("A", "B", "spotify:track:6rqhFgbbKwnb9MLmUQDhG6")),
    { href: "https://open.spotify.com/track/6rqhFgbbKwnb9MLmUQDhG6", exact: true });
});
test("a non-track or malformed URI falls back to search, never a broken track link", () => {
  for (const u of ["spotify:local:a:b:c:1", "spotify:track:", "spotify:track:abc/../x", "https://evil/x", ""]) {
    assert.equal(spotifyHref(f("A", "B", u)).exact, false, u);
  }
});
test("search links encode & # quotes and spaces so the query cannot be cut short", () => {
  const h = spotifyHref(f("Simon & Garfunkel", 'Mrs. Robinson #1 "live"')).href;
  assert.equal(h, "https://open.spotify.com/search/Simon%20%26%20Garfunkel%20Mrs.%20Robinson%20%231%20%22live%22");
  assert.ok(!/[&#" ]/.test(h.slice("https://open.spotify.com/search/".length)));
});
test("non-Latin names are percent-encoded UTF-8 and round-trip", () => {
  const h = youtubeHref(f("宇多田ヒカル", "初恋")).href;
  assert.ok(h.startsWith("https://www.youtube.com/results?search_query="));
  assert.equal(decodeURIComponent(h.split("search_query=")[1]), "宇多田ヒカル 初恋");
  assert.ok(!/[^\x20-\x7e]/.test(h));
});
test("a missing artist searches the title alone, without a stray 'null'", () => {
  assert.equal(youtubeHref(f(null, "Xtal")).href, "https://www.youtube.com/results?search_query=Xtal");
});
test("youtube is never claimed as an exact link", () => assert.equal(youtubeHref(f("A", "B", "spotify:track:abc")).exact, false));

// ------------------------------------------------------------------- album
test("enrich album beats any file tag", () => {
  const cat = catOf([trk("t1", { album: "Tag Album" })]);
  assert.equal(songFactsFor(cat, map(rec({ album: "Selected Ambient Works" })), "aphex|xtal").album, "Selected Ambient Works");
});
test("without an enrich album, the most common file tag among played tracks wins", () => {
  const cat = catOf([trk("t1", { album: "Rare" }), trk("t2", { album: "Common" }), trk("t3", { album: "Common" }),
    trk("t4", { album: "Unplayed", played: false }), trk("t5", { album: "Unplayed", played: false }), trk("t6", { album: "Unplayed", played: false })]);
  assert.equal(songFactsFor(cat, map(rec()), "aphex|xtal").album, "Common");
});
test("an event label in the album tag is not an album", () => {
  assert.equal(songFactsFor(catOf([trk("t1", { album: "Roll" })]), null, "aphex|xtal").album, null);
  assert.equal(albumOf(null, { album: "20251108 Roll" }), null);
});
test("a record that is not a match says no album (confidence none)", () => {
  assert.equal(albumOf(rec({ confidence: "none", album: "Wrong" })), null);
});
test("blank album strings are unknown", () => assert.equal(albumOf(rec({ album: "   " })), null));

// ------------------------------------------------------------------ genres
test("event labels are never shown as genres", () => {
  assert.deepEqual(tagGenres([{ genre: "Roll afterglow" }, { genre: "20251108 Roll" }, { genre: "Candyflip" }]), []);
  const cat = catOf([trk("t1", { genre: "Roll afterglow" })]);
  assert.deepEqual(songFactsFor(cat, null, "aphex|xtal").genres, []);
});
test("a real genre next to an event label survives; 'Trip Hop' is a genre", () => {
  assert.deepEqual(tagGenres([{ genre: "Trip Hop" }, { genre: "Roll; Electronic" }]), ["Trip Hop", "Electronic"]);
});
test("enrich genres beat file tags", () => {
  const cat = catOf([trk("t1", { genre: "Pop" })]);
  assert.deepEqual(songFactsFor(cat, map(rec({ genres: ["idm", "ambient"] })), "aphex|xtal").genres, ["idm", "ambient"]);
});

// ------------------------------------------------------------ release date
test("a full date shows its year in the table and keeps the date for the tooltip", () => {
  const i = songFactsFor(catOf([trk("t1")]), map(rec({ year: 1992, releaseDate: "1992-11-09" })), "aphex|xtal");
  const col = songColumns((x: typeof i) => x).find((c) => c.id === "released")!;
  assert.equal(col.text(i), "1992");
  assert.equal(col.title!(i), "Released 1992-11-09");
  assert.equal(i.datePrecision, "day");
});
test("month and year precision are kept as given, not padded to a fake day", () => {
  assert.deepEqual(dateOf(rec({ year: 1992, releaseDate: "1992-11" })), { text: "1992-11", precision: "month" });
  assert.deepEqual(dateOf(rec({ year: 1992, releaseDate: "1992" })), { text: "1992", precision: "year" });
});
test("a date whose year disagrees with the record year is dropped back to the year", () => {
  assert.deepEqual(dateOf(rec({ year: 1992, releaseDate: "1993-01-05" })), { text: "1992", precision: "year" });
});
test("junk dates (month 13, free text) never reach the screen", () => {
  for (const d of ["1992-13-01", "1992-00", "1992-11-32", "yesterday", "1992-1-1"]) {
    assert.deepEqual(dateOf(rec({ year: 1992, releaseDate: d })), { text: "1992", precision: "year" }, d);
  }
});
test("a suspect-year or unmatched record has no date at all, matching yearOf", () => {
  const sus = rec({ yearSuspect: true, releaseDate: "1992-11-09" });
  assert.equal(dateOf(sus), null); assert.equal(yearOf(sus), null);
  assert.equal(dateOf(rec({ confidence: "none", releaseDate: "1992-11-09" })), null);
});
test("the year in the table is always the year of the date", () => {
  for (const d of ["1992-11-09", "1992-11", "1992", null, undefined]) {
    const r = rec({ year: 1992, releaseDate: d });
    assert.equal(dateOf(r)!.text.slice(0, 4), String(yearOf(r)));
  }
});
test("release dates sort chronologically at mixed precision, unknown last", () => {
  const cat = catOf([trk("t1")]);
  const mk = (releaseDate: string | null, year: number | null) =>
    songFactsFor(cat, map(rec({ year, releaseDate })), "aphex|xtal");
  const col = songColumns((x: ReturnType<typeof mk>) => x).find((c) => c.id === "released")!;
  const a = col.sortKey!(mk("1992-11-09", 1992)), b = col.sortKey!(mk("1992-12", 1992)), c = col.sortKey!(mk(null, 1993));
  assert.ok(a! < b! && b! < c!);
  assert.equal(col.sortKey!(mk(null, null)), null);
});

// ------------------------------------------------------------ the song row
test("duration is the median of played tracks, ignoring unplayed copies and zeros", () => {
  const cat = catOf([trk("t1", { durationSec: 100 }), trk("t2", { durationSec: 300 }), trk("t3", { durationSec: 200 }),
    trk("t4", { durationSec: 9999, played: false }), trk("t5", { durationSec: 0 }), trk("t6", { durationSec: null })]);
  assert.equal(songFactsFor(cat, null, "aphex|xtal").durationSec, 200);
});
test("spotify uri is taken from any played track of the song", () => {
  const cat = catOf([trk("t1"), trk("t2", { spotifyUri: "spotify:track:abc123" })]);
  assert.equal(songFactsFor(cat, null, "aphex|xtal").spotifyUri, "spotify:track:abc123");
});
test("an anonymised track resolves to its twin's song", () => {
  const cat = catOf([trk("t1"), trk("t2", { songId: null, twinId: "t1", artist: null, title: null })]);
  assert.equal(songFactsFor(cat, null, cat.tracks[1]).songId, "aphex|xtal");
});
test("a track with no song identity is described by itself, not as someone else's song", () => {
  const cat = catOf([trk("t1")]);
  const lone = trk("t9", { songId: null, artist: "Nobody", title: "Loose", album: "LP", durationSec: 61 });
  const i = songFactsFor(cat, null, lone);
  assert.deepEqual([i.songId, i.title, i.artist, i.album, i.durationSec], [null, "Loose", "Nobody", "LP", 61]);
});
test("a song id the catalogue has never heard of gives unknowns, not a throw", () => {
  const i = songFactsFor(catOf([trk("t1")]), null, "ghost|song");
  assert.deepEqual([i.album, i.durationSec, i.year, i.nights, i.spotifyUri, i.genres], [null, null, null, 0, null, []]);
});

// -------------------------------------------------------------- memoising
test("facts are memoised per (catalogue, enrichment): same inputs, same object", () => {
  const cat = catOf([trk("t1")]), e = map(rec());
  assert.equal(songFactsFor(cat, e, "aphex|xtal"), songFactsFor(cat, e, "aphex|xtal"));
});
test("a new enrichment map is a new answer: stale facts never survive the vault arriving", () => {
  const cat = catOf([trk("t1")]);
  const before = songFactsFor(cat, null, "aphex|xtal");
  const after = songFactsFor(cat, map(rec({ album: "SAW 85-92" })), "aphex|xtal");
  assert.equal(before.album, null); assert.equal(after.album, "SAW 85-92");
  assert.equal(songFactsFor(cat, null, "aphex|xtal"), before);
});
test("a different catalogue never reuses another's facts", () => {
  const e = map(rec());
  assert.notEqual(songFactsFor(catOf([trk("t1")]), e, "aphex|xtal"), songFactsFor(catOf([trk("t1")]), e, "aphex|xtal"));
});
test("missing enrich entirely (null and undefined) still fills title, artist, duration, nights", () => {
  const cat = catOf([trk("t1")]);
  for (const e of [null, undefined]) {
    const i = songFactsFor(cat, e, "aphex|xtal");
    assert.deepEqual([i.title, i.artist, i.durationSec, i.nights, i.year, i.releaseDate, i.familyLabel],
      ["Xtal", "Aphex Twin", 290, 2, null, null, null]);
  }
});

// ----------------------------------------------------------- column choice
const all = songColumns<unknown>(() => { throw new Error("unused"); });
test("every default column is on, and the title cannot be turned off", () => {
  assert.ok(all.every((c) => isOn(c, NO_CHOICE)));
  const title = all.find((c) => c.id === "title")!;
  assert.equal(isOn(title, { show: [], hide: ["title"] }), true);
});
test("toggling a column off then on returns to the default (no leftover delta)", () => {
  const album = all.find((c) => c.id === "album")!;
  const off = toggleColumn(album, NO_CHOICE);
  assert.equal(isOn(album, off), false);
  assert.deepEqual(toggleColumn(album, off), NO_CHOICE);
});
test("a default-off page column can be switched on and remembered as a delta", () => {
  const extra: Pick<Column<never>, "id" | "defaultOn"> = { id: "x", defaultOn: false };
  const on = toggleColumn(extra, NO_CHOICE);
  assert.equal(isOn(extra, on), true);
});
test("saved junk (null, numbers, wrong shapes) cleans to no choice", () => {
  for (const raw of [null, 5, "x", [], { show: 1, hide: { a: 1 } }, { show: [1, null] }]) {
    assert.deepEqual(cleanChoice(raw), NO_CHOICE);
  }
});
test("album and genre drop out below 1100px but not at 1100px", () => {
  const ids = (w: number) => visibleColumns(all, NO_CHOICE, w).map((c) => c.id);
  assert.ok(!ids(1099).includes("album") && !ids(1099).includes("genre"));
  assert.ok(ids(1100).includes("album") && ids(1100).includes("genre"));
  assert.ok(ids(1099).includes("released"));
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`songcols: ${passed} passed`);
