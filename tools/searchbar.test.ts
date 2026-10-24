/** Search control bar logic: the ways its chips, badges and suggestions can go wrong. */
import assert from "node:assert/strict";
import {
  activeChips, badgeLabel, clearAll, hiddenNote, NO_FILTERS, orderText, removeChip, suggestions,
  type FilterState,
} from "../src/searchbar.ts";
import { toggle } from "../src/enrichfilter.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const words = { person: (id: string) => `Person ${id}`, family: (k: string) => k.toUpperCase() };
const st = (o: Partial<FilterState> = {}): FilterState => ({ ...NO_FILTERS, ...o });

test("chip toggle round-trip: on then off returns the same selection", () => {
  const on = toggle(["rock"], "metal");
  assert.deepEqual(on, ["rock", "metal"]);
  assert.deepEqual(toggle(on, "metal"), ["rock"]);
});

test("removing a chip drops only that chip", () => {
  const s = st({ families: ["rock", "metal"], decades: ["1990s"], year: "2019" });
  const a = removeChip(s, { kind: "family", value: "rock" });
  assert.deepEqual(a.families, ["metal"]);
  assert.deepEqual(a.decades, ["1990s"]);
  assert.equal(a.year, "2019");
  assert.equal(removeChip(s, { kind: "year", value: "2019" }).year, "");
});

test("active chips list every filter that is on and nothing else", () => {
  assert.deepEqual(activeChips(NO_FILTERS, words), []);
  const c = activeChips(st({ families: ["rock"], decades: ["1990s"], personId: "p1", type: "party" }), words);
  assert.deepEqual(c.map((x) => x.label), ["ROCK", "1990s", "Person p1", "party"]);
});

test("clear all empties every filter, and removing the last chip leaves none active", () => {
  const s = st({ families: ["rock"], decades: ["1990s"], personId: "p1", year: "2019", type: "party" });
  assert.deepEqual(clearAll(s), NO_FILTERS);
  let t = s;
  for (const c of activeChips(s, words)) t = removeChip(t, c);
  assert.deepEqual(activeChips(t, words), []);
});

test("URL query preserved: removing a chip or clearing all never touches the query", () => {
  const s = { ...st({ families: ["rock"], year: "2019" }), q: "bowie" };
  assert.equal(removeChip(s, { kind: "family", value: "rock" }).q, "bowie");
  assert.equal(clearAll(s).q, "bowie");
});

test("active-count badge: bare name at zero, name with count otherwise", () => {
  assert.equal(badgeLabel("Genre", 0), "Genre");
  assert.equal(badgeLabel("Genre", 2), "Genre · 2");
  assert.equal(badgeLabel("Released", 1), "Released · 1");
});

test("order sentence names the sort in plain words", () => {
  assert.equal(orderText("nights"), "most nights first");
  assert.equal(orderText("az"), "A to Z");
});

test("hidden note appears once with the real numbers, and only blames what is selected", () => {
  const cov = { total: 3000, either: 2500 };
  const sum = { total: 1000, shown: 700, unknown: 120 };
  assert.equal(hiddenNote(sum, { families: ["rock"], decades: [] }, cov),
    "120 of 1,000 songs hidden because no genre on file.");
  assert.match(hiddenNote(sum, { families: ["rock"], decades: ["1990s"] }, cov), /no genre or year on file/);
  assert.match(hiddenNote({ total: 1000, shown: 1000, unknown: 0 }, { families: [], decades: [] }, cov),
    /^2,500 of 3,000 songs have a genre or year on file/);
});

const lib = [
  { artist: "Queen", title: "A", nights: ["e1", "e2", "e3"] },
  { artist: "Queen", title: "B", nights: ["e3", "e4"] },
  { artist: "Abba", title: "C", nights: ["e1", "e2"] },
  { artist: "Ghost", title: "D", nights: [] },
  { artist: null, title: "E", nights: ["e1"] },
  { artist: "  ", title: "F", nights: ["e1"] },
];

test("suggestions only from real data: artists are counted in distinct nights, never invented", () => {
  const s = suggestions(lib, ["1990s"]);
  assert.deepEqual(s.artists, [{ name: "Queen", nights: 4 }, { name: "Abba", nights: 2 }]);
  for (const a of s.artists) assert.ok(lib.some((x) => x.artist === a.name));
  for (const x of s.songs) assert.ok(lib.some((l) => l.title === x.title && l.nights.length === x.nights));
  assert.ok(!s.artists.some((a) => a.name === "Ghost"), "an artist never played has no nights");
});

test("suggestions: songs by nights; empty library gives nothing; decades pass through untouched", () => {
  assert.deepEqual(suggestions(lib, []).songs.map((x) => x.title), ["A", "B", "C", "E", "F"]);
  assert.deepEqual(suggestions([], []), { artists: [], songs: [], decades: [] });
  assert.deepEqual(suggestions(lib, ["1980s", "1990s"]).decades, ["1980s", "1990s"]);
});

test("suggestions respect their limits", () => {
  assert.equal(suggestions(lib, [], { artists: 1, songs: 2 }).artists.length, 1);
  assert.equal(suggestions(lib, [], { artists: 1, songs: 2 }).songs.length, 2);
});

if (failures.length) {
  console.error(`searchbar: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`searchbar: ${passed} passed`);
