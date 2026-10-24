/** The Artists view's grouping. Each test is named after the way it could quietly
 *  go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Event, Track } from "../src/catalog.ts";
import { buildWall, filterSongs, NO_FILTERS, sortKey, type WallSong } from "../src/musicstats.ts";
import {
  albumCoverage, albumKey, artistLine, buildArtistRows, cleanAlbum, defaultGrouping, flatten, groupByAlbum,
  NO_ARTIST, sortArtists, type AlbumFacts,
} from "../src/artistalbums.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
let n = 0;
const song = (artistId: string | null, title: string, over: Partial<WallSong> = {}): WallSong => ({
  songId: `${artistId ?? "?"}|${title}|${++n}`, title, artist: artistId ? artistId.toUpperCase() : "", artistId, loose: !artistId,
  nights: 1, nightIds: [`n${n}`], dates: ["2020-01-01"], firstDate: "2020-01-01", lastDate: "2020-01-01", years: [2020],
  people: [], types: [], variants: [], key: sortKey(title), bucket: "", hay: "", ...over,
}) as WallSong;

const F: Record<string, Partial<AlbumFacts>> = {};
const facts = (s: WallSong): AlbumFacts => ({ album: null, year: null, durationSec: null, ...F[s.songId] });
const withF = (s: WallSong, f: Partial<AlbumFacts>) => { F[s.songId] = f; return s; };
const rowsOf = (songs: WallSong[]) => buildArtistRows(songs, facts, (id) => id !== "gone", () => undefined);

test("the same album spelled two ways (case, remaster suffix, punctuation) is one album", () => {
  const a = withF(song("ab", "One"), { album: "Abbey Road" });
  const b = withF(song("ab", "Two"), { album: "ABBEY ROAD (Remastered 2009)" });
  const c = withF(song("ab", "Three"), { album: "Abbey Road - Deluxe Edition" });
  const d = withF(song("ab", "Four"), { album: "Abbey  Road!" });
  const g = groupByAlbum([a, b, c, d], facts);
  assert.equal(g.albums.length, 1);
  assert.equal(g.albums[0].songs.length, 4);
  assert.equal(g.albums[0].name, "Abbey Road", "shows the cleanest spelling, not the remaster one");
});

test("album name normalisation strips noise suffixes but keeps real differences like (Live)", () => {
  assert.equal(cleanAlbum("Discovery (Deluxe)"), "Discovery");
  assert.equal(cleanAlbum("Discovery [Remastered 2011] (Deluxe Edition)"), "Discovery");
  assert.equal(cleanAlbum("Discovery - 2011 Remaster"), "Discovery");
  assert.equal(cleanAlbum("Alive 2007 (Live)"), "Alive 2007 (Live)");
  assert.notEqual(albumKey("Alive 2007"), albumKey("Alive 2007 (Live)"));
  assert.equal(cleanAlbum("(Deluxe)"), "(Deluxe)", "never empties a name");
});

test("an event label such as Roll is no album, so the song falls under no album", () => {
  const a = withF(song("ab", "One"), { album: "Roll" });
  const b = withF(song("ab", "Two"), { album: "  " });
  const c = withF(song("ab", "Three"), { album: "Roll (Remastered)" });
  assert.equal(albumKey("Roll"), null);
  const g = groupByAlbum([a, b, c], facts);
  assert.equal(g.albums.length, 0);
  assert.equal(g.noAlbum.length, 3);
});

test("an artist whose only song has no album still shows, with that song under no album", () => {
  const rows = rowsOf([song("ab", "Lonely")]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].groups.albums.length, 0);
  assert.equal(rows[0].groups.noAlbum.length, 1);
  assert.ok(!/album/.test(artistLine(rows[0], plural)), "no '0 albums' in the line");
  assert.equal(defaultGrouping(rows[0].groups), "flat");
});

test("an album's year is the earliest known year of its songs, not the first song's or the latest", () => {
  const a = withF(song("ab", "One"), { album: "LP", year: 2005 });
  const b = withF(song("ab", "Two"), { album: "LP", year: 1999 });
  const c = withF(song("ab", "Three"), { album: "LP", year: null });
  const g = groupByAlbum([a, b, c], facts);
  assert.equal(g.albums[0].year, 1999);
});

test("albums run by year, unknown year last, then name; no-album songs are not an album", () => {
  const mk = (t: string, album: string, year: number | null) => withF(song("ab", t), { album, year });
  const g = groupByAlbum([mk("1", "Zed", 2010), mk("2", "Beta", null), mk("3", "alpha", null), mk("4", "Middle", 2001), mk("5", "Old", 2001)], facts);
  assert.deepEqual(g.albums.map((a) => a.name), ["Middle", "Old", "Zed", "alpha", "Beta"]);
});

test("every song is counted exactly once across its artist's groups", () => {
  const ss = [
    withF(song("ab", "1"), { album: "X" }), withF(song("ab", "2"), { album: "x (Remastered)" }),
    withF(song("ab", "3"), { album: "Y" }), song("ab", "4"), withF(song("ab", "5"), { album: "Roll" }),
  ];
  const r = rowsOf(ss)[0];
  const ids = [...r.groups.albums.flatMap((a) => a.songs), ...r.groups.noAlbum].map((s) => s.songId);
  assert.equal(ids.length, ss.length);
  assert.equal(new Set(ids).size, ss.length);
  const open = flatten([r], new Set([r.key]), false).filter((i) => i.kind === "song");
  assert.equal(open.length, ss.length, "the expanded list shows each song once too");
});

test("a compilation where each song has a different artist stays separate per artist", () => {
  const a = withF(song("ab", "One"), { album: "Now That's Music 5" });
  const b = withF(song("cd", "Two"), { album: "Now That's Music 5" });
  const c = withF(song("cd", "Three"), { album: "Now That's Music 5" });
  const rows = rowsOf([a, b, c]);
  assert.equal(rows.length, 2);
  const ab = rows.find((r) => r.key === "ab")!, cd = rows.find((r) => r.key === "cd")!;
  assert.deepEqual([ab.groups.albums[0].songs.length, cd.groups.albums[0].songs.length], [1, 2]);
});

test("a collaboration 'A & B' stays its own artist and is not merged into A or B", () => {
  const cats = {
    events: [{ id: "2020-01-01", kind: "event", date: "2020-01-01", types: ["roll"] }] as unknown as Event[],
    tracks: [
      { id: "1", eventId: "2020-01-01", personId: "p", phaseId: null, artist: "A", title: "X", songId: "a|x", twinId: null, playOrder: null, variant: null, played: true, flags: [] },
      { id: "2", eventId: "2020-01-01", personId: "p", phaseId: null, artist: "A & B", title: "Y", songId: "a b|y", twinId: null, playOrder: null, variant: null, played: true, flags: [] },
    ] as unknown as Track[],
    phases: [], people: [{ id: "p", name: "P" }],
    songs: [{ id: "a|x", artist: "A", title: "X" }, { id: "a b|y", artist: "A & B", title: "Y" }],
    artists: [{ id: "a", name: "A" }, { id: "a b", name: "A & B" }],
  } as unknown as Catalog;
  const w = buildWall(cats);
  const rows = buildArtistRows(w.songs, facts, (id) => w.artists.has(id), (id) => w.artists.get(id)?.name);
  assert.deepEqual(rows.map((r) => r.name), ["A", "A & B"]);
  assert.deepEqual(rows.map((r) => r.songs.length), [1, 1]);
});

test("Unknown artist is one group, named, and sorts last in every sort", () => {
  const ss = [song(null, "Orphan 1"), song("zz", "Z"), song(null, "Orphan 2"), song("aa", "A"), song("aa", "A2")];
  const rows = rowsOf(ss);
  assert.equal(rows.filter((r) => r.unknown).length, 1);
  assert.equal(rows.find((r) => r.unknown)!.name, NO_ARTIST);
  assert.equal(rows.find((r) => r.unknown)!.songs.length, 2);
  for (const sort of ["az", "songs", "nights", "first", "last"] as const) {
    const s = sortArtists(rows, sort);
    assert.ok(s[s.length - 1].unknown, `last under ${sort}`);
  }
  const heads = flatten(rows, new Set(), true).filter((i) => i.kind === "head");
  assert.equal((heads[heads.length - 1] as { label: string }).label, NO_ARTIST);
});

test("A-Z sorts 'The Prodigy' under P like the songs, and equal names never shuffle", () => {
  const ss = [song("the prodigy", "x", { artist: "The Prodigy" }), song("moby", "y", { artist: "Moby" }), song("zed", "z", { artist: "Zed" })];
  assert.deepEqual(rowsOf(ss).map((r) => r.name), ["Moby", "The Prodigy", "Zed"]);
  const twins = [song("t2", "a", { artist: "Same" }), song("t1", "b", { artist: "Same" }), song("t3", "c", { artist: "Same" })];
  const a = rowsOf(twins).map((r) => r.key), b = rowsOf([...twins].reverse()).map((r) => r.key);
  assert.deepEqual(a, b);
});

test("other sorts are stable: ties keep A-Z order, and the numbers sort the right way round", () => {
  const rows = rowsOf([
    song("c", "1", { nights: 3, nightIds: ["a", "b", "c"], firstDate: "2019-01-01", lastDate: "2021-01-01", years: [2019, 2021] }),
    song("b", "2"), song("a", "3"), song("a", "4"), song("d", "5", { firstDate: "2018-05-05", lastDate: "2022-02-02" }),
  ]);
  assert.deepEqual(sortArtists(rows, "songs").map((r) => r.key), ["a", "b", "c", "d"]);
  assert.deepEqual(sortArtists(rows, "nights").map((r) => r.key), ["c", "a", "b", "d"]);
  assert.deepEqual(sortArtists(rows, "first").map((r) => r.key), ["d", "c", "a", "b"]);
  assert.deepEqual(sortArtists(rows, "last").map((r) => r.key), ["d", "c", "a", "b"]);
});

test("filters narrow which songs count, so an artist keeps only matching songs and one with none disappears", () => {
  const cats = (id: string, date: string, t: string, songId: string) =>
    ({ id: `t${id}`, eventId: date, personId: "p", phaseId: null, artist: songId[0].toUpperCase(), title: t, songId, twinId: null, playOrder: null, variant: null, played: true, flags: [] });
  const c = {
    events: ["2019-01-01", "2022-01-01"].map((d) => ({ id: d, kind: "event", date: d, types: ["roll"] })),
    tracks: [cats("1", "2019-01-01", "Old", "a|old"), cats("2", "2022-01-01", "New", "a|new"), cats("3", "2019-01-01", "Past", "b|past")],
    phases: [], people: [{ id: "p", name: "P" }],
    songs: [{ id: "a|old", artist: "A", title: "Old" }, { id: "a|new", artist: "A", title: "New" }, { id: "b|past", artist: "B", title: "Past" }],
    artists: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
  } as unknown as Catalog;
  const w = buildWall(c);
  const known = (id: string) => w.artists.has(id), nameOf = (id: string) => w.artists.get(id)?.name;
  const all = buildArtistRows(w.songs, facts, known, nameOf);
  assert.deepEqual(all.map((r) => [r.key, r.songs.length]), [["a", 2], ["b", 1]]);
  const kept = buildArtistRows(filterSongs(w.songs, { ...NO_FILTERS, since: 2021 }, new Map()), facts, known, nameOf);
  assert.deepEqual(kept.map((r) => [r.key, r.songs.length, r.nights]), [["a", 1, 1]], "B gone; A has only its 2022 song");
  assert.equal(kept[0].first, "2022-01-01");
});

test("album coverage counts songs in a known album, and adds up with the rest", () => {
  const rows = rowsOf([withF(song("ab", "1"), { album: "X" }), song("ab", "2"), song("cd", "3"), withF(song("cd", "4"), { album: "Y" })]);
  assert.deepEqual(albumCoverage(rows), { songs: 4, withAlbum: 2 });
});

test("a closed artist adds one row; opening it adds its albums and songs, and the head count is of artists", () => {
  const r = rowsOf([withF(song("ab", "1"), { album: "X" }), song("ab", "2")]);
  assert.equal(flatten(r, new Set(), true).length, 2, "head + artist");
  const open = flatten(r, new Set(["ab"]), true);
  assert.deepEqual(open.map((i) => i.kind), ["head", "artist", "album", "song", "album", "song"]);
  assert.equal((open[0] as { count: number }).count, 1);
  assert.equal(flatten(r, new Set(["ab"]), false)[0].kind, "artist", "no heads outside A-Z");
});

test("the artist page groups by album when there is one album with 2+ songs or 2+ albums, not otherwise", () => {
  const one = (t: string, a: string | null) => withF(song("ab", t), { album: a });
  assert.equal(defaultGrouping(groupByAlbum([one("1", "X"), one("2", "X")], facts)), "album");
  assert.equal(defaultGrouping(groupByAlbum([one("1", "X"), one("2", "Y")], facts)), "album");
  assert.equal(defaultGrouping(groupByAlbum([one("1", "X"), one("2", null)], facts)), "flat");
  assert.equal(defaultGrouping(groupByAlbum([one("1", null), one("2", null)], facts)), "flat");
});

if (failures.length) {
  console.error(`artistalbums: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`artistalbums: ${passed} passed`);
