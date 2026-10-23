/** How often, when and by whom a song was brought. Each test is named after
 *  the way the number could quietly go wrong. */
import assert from "node:assert/strict";
import type { Catalog, Event, Phase, Track } from "../src/catalog.ts";
import {
  artistHistory, songHistory, spanLabel, summaryText, verdictSentence,
} from "../src/songstats.ts";

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
const cat = (events: Event[], tracks: Track[], phases: Phase[] = []) =>
  ({
    events, tracks, phases, songs: [], artists: [],
    people: ["ann", "bo", "cy", "di", "ed"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) })),
  }) as unknown as Catalog;

test("an anonymised twin does not double count a play", () => {
  const named = tr("2020-01-01", "ann", { id: "n1", twinId: "a1" });
  const anon = tr("2020-01-01", "ann", { id: "a1", twinId: "n1", songId: null, flags: ["anon"] });
  const h = songHistory(cat([ev("2020-01-01")], [named, anon]), "ab|song");
  assert.equal(h.plays, 1);
  assert.equal(h.nights, 1);
});

test("an anonymised track with stripped tags takes its twin's song, and counts when it is the only played copy", () => {
  const named = tr("2020-01-01", "ann", { id: "n1", twinId: "a1", played: false });
  const anon = tr("2020-01-01", "ann", { id: "a1", twinId: "n1", songId: null, flags: ["anon"] });
  const h = songHistory(cat([ev("2020-01-01")], [named, anon]), "ab|song");
  assert.equal(h.plays, 1);
  assert.equal(h.occurrences[0].anon, true);
});

test("a song played the same night by two people is 2 plays but 1 night", () => {
  const h = songHistory(cat([ev("2020-01-01")], [tr("2020-01-01", "ann"), tr("2020-01-01", "bo")]), "ab|song");
  assert.equal(h.plays, 2);
  assert.equal(h.nights, 1);
  assert.equal(h.people.length, 2);
  assert.equal(h.verdict, "one-off");
});

test("one person playing plain and Live of a song in one night is one play, but both versions are listed", () => {
  const c = cat([ev("2020-01-01")], [tr("2020-01-01", "ann"), tr("2020-01-01", "ann", { variant: "Live" })]);
  const h = songHistory(c, "ab|song");
  assert.equal(h.plays, 1);
  assert.deepEqual(h.variants.map((v) => [v.variant, v.plays]).sort(), [[null, 1], ["Live", 1]]);
});

test("first and last on a shared night go to the lowest running order, then to the person id", () => {
  const evs = [ev("2020-01-01"), ev("2021-01-01")];
  const h = songHistory(cat(evs, [
    tr("2020-01-01", "bo", { playOrder: 5 }), tr("2020-01-01", "ann", { playOrder: 9 }),
    tr("2021-01-01", "cy"), tr("2021-01-01", "ann"),
  ]), "ab|song");
  assert.equal(h.first!.personId, "bo");
  assert.deepEqual(h.first!.nightPeople, ["Ann", "Bo"]);
  assert.equal(h.last!.personId, "ann", "no order known on the last night: person id breaks the tie");
});

test("collections are shelves: not plays, not nights, but reported", () => {
  const evs = [ev("2020-01-01"), ev("coll", { kind: "collection", date: null })];
  const h = songHistory(cat(evs, [tr("coll", null)]), "ab|song");
  assert.equal(h.plays, 0);
  assert.equal(h.verdict, "never");
  assert.equal(h.shelfTracks, 1);
  assert.match(verdictSentence(h), /shelf/i);
});

test("a night with no date, and a track that was not played, never count", () => {
  const evs = [ev("x", { date: null }), ev("2020-01-01")];
  const h = songHistory(cat(evs, [tr("x", "ann"), tr("2020-01-01", "ann", { played: false })]), "ab|song");
  assert.equal(h.plays, 0);
});

test("the longest gap is between consecutive nights, and the time since last is measured to the newest night in the library", () => {
  const evs = ["2015-01-01", "2016-01-01", "2022-03-01", "2023-01-01"].map((d) => ev(d)).concat(ev("2023-07-01"));
  const h = songHistory(cat(evs, ["2015-01-01", "2016-01-01", "2022-03-01"].map((d) => tr(d, "ann"))), "ab|song");
  assert.equal(h.longestGap!.from, "2016-01-01");
  assert.equal(h.longestGap!.to, "2022-03-01");
  assert.equal(h.longestGap!.label, "6 years 2 months");
  assert.equal(h.asOf, "2023-07-01");
  assert.equal(h.sinceLast!.label, "1 year 4 months", "not measured to today");
  assert.equal(h.recent, false);
});

test("a song 5+ years away and then back is a comeback; 4 years is merely a regular", () => {
  const mk = (dates: string[]) => songHistory(cat(dates.map((d) => ev(d)), dates.map((d) => tr(d, "ann"))), "ab|song");
  assert.equal(mk(["2015-01-01", "2016-01-01", "2022-01-01"]).verdict, "comeback");
  assert.equal(mk(["2015-01-01", "2016-01-01", "2020-01-01"]).verdict, "regular");
});

test("verdict thresholds: twice, regular at 3 nights, staple at 8 nights or 4 people", () => {
  const dates = (k: number) => Array.from({ length: k }, (_, i) => `2020-0${i + 1}-01`);
  const same = (k: number) => songHistory(cat(dates(k).map((d) => ev(d)), dates(k).map((d) => tr(d, "ann"))), "ab|song").verdict;
  assert.equal(same(2), "twice");
  assert.equal(same(3), "regular");
  const eight = Array.from({ length: 8 }, (_, i) => `2020-01-0${i + 1}`);
  assert.equal(songHistory(cat(eight.map((d) => ev(d)), eight.map((d) => tr(d, "ann"))), "ab|song").verdict, "staple");
  const four = ["ann", "bo", "cy", "di"].map((p, i) => tr(`2020-01-0${i + 1}`, p));
  assert.equal(songHistory(cat(four.map((t) => ev(t.eventId)), four), "ab|song").verdict, "staple");
});

test("the sentences read right: plurals, month-year, one person, one-off", () => {
  const c = cat([ev("2017-08-05")], [tr("2017-08-05", "bo")]);
  assert.equal(verdictSentence(songHistory(c, "ab|song")), "A one-off: brought once, in Aug 2017, by Bo.");
  const dates = Array.from({ length: 9 }, (_, i) => `201${i}-04-01`);
  const people = ["ann", "bo", "cy"];
  const trs = dates.map((d, i) => tr(d, people[i % 3]));
  const s = verdictSentence(songHistory(cat(dates.map((d) => ev(d)), trs), "ab|song"));
  assert.equal(s, "A staple: brought on 9 nights since 2010 by 3 people, last by Cy in Apr 2018.");
  const solo = ["2016-01-01", "2017-01-01", "2018-01-01"];
  assert.equal(
    verdictSentence(songHistory(cat(solo.map((d) => ev(d)), solo.map((d) => tr(d, "cy"))), "ab|song")),
    "A regular: brought on 3 nights since 2016, always by Cy, last in Jan 2018.",
  );
});

test("the phase split counts only tracks that have a phase, and names a dominant one only when it is clear", () => {
  const ph = (id: string, bucket: Phase["bucket"]) => ({ id, bucket, clean: id } as Phase);
  const evs = ["2020-01-01", "2020-02-01", "2020-03-01", "2020-04-01"].map((d) => ev(d));
  const mk = (b: (string | null)[]) => songHistory(
    cat(evs, evs.map((e, i) => tr(e.id, "ann", { phaseId: b[i] }))
    , [ph("pk", "peak"), ph("ea", "early")]), "ab|song").phases;
  const a = mk(["pk", "pk", "ea", null]);
  assert.equal(a.total, 3);
  assert.equal(a.dominant, "peak");
  const b = mk(["pk", "ea", null, null]);
  assert.equal(b.dominant, null, "a tie names nothing");
});

test("years run unbroken from first to last, with the empty ones at zero", () => {
  const dates = ["2015-05-01", "2018-05-01", "2018-06-01"];
  const h = songHistory(cat(dates.map((d) => ev(d)), dates.map((d) => tr(d, "ann"))), "ab|song");
  assert.deepEqual(h.years.map((y) => [y.year, y.plays, y.nights]),
    [["2015", 1, 1], ["2016", 0, 0], ["2017", 0, 0], ["2018", 2, 2]]);
});

test("variants stay separate but linked to the one song", () => {
  const dates = ["2016-01-01", "2017-01-01", "2018-01-01"];
  const c = cat(dates.map((d) => ev(d)), [
    tr(dates[0], "ann"), tr(dates[1], "ann", { variant: "Live" }), tr(dates[2], "bo", { variant: "Live" }),
  ]);
  const h = songHistory(c, "ab|song");
  assert.equal(h.plays, 3, "one song");
  const live = h.variants.find((v) => v.variant === "Live")!;
  assert.equal(live.plays, 2);
  assert.equal(live.first, "2017-01-01");
  assert.equal(h.variants.find((v) => v.variant === null)!.plays, 1);
});

test("an artist counts each of its songs once per person per night, and ranks songs by nights", () => {
  const dates = ["2016-01-01", "2017-01-01"];
  const c = cat(dates.map((d) => ev(d)), [
    tr(dates[0], "ann"), tr(dates[0], "ann", { id: "dupe-copy" }),          // same person, same night, same song
    tr(dates[0], "ann", { songId: "ab|other", title: "Other" }),            // a second song, same night
    tr(dates[1], "bo"),
  ]);
  const a = artistHistory(c, "ab");
  assert.equal(a.nights, 2);
  assert.equal(a.plays, 3, "song+other on night 1, song on night 2");
  assert.equal(a.songCount, 2);
  assert.deepEqual(a.songs.map((s) => [s.title, s.nights]), [["Song", 2], ["Other", 1]]);
});

test("a signature artist is one person's, only with enough plays", () => {
  const dates = ["2016-01-01", "2017-01-01", "2018-01-01"];
  const own = artistHistory(cat(dates.map((d) => ev(d)), dates.map((d) => tr(d, "cy"))), "ab");
  assert.equal(own.signature?.name, "Cy");
  const shared = artistHistory(cat(dates.map((d) => ev(d)), [tr(dates[0], "cy"), tr(dates[1], "ann"), tr(dates[2], "cy")]), "ab");
  assert.equal(shared.signature, null);
  const thin = artistHistory(cat([ev(dates[0])], [tr(dates[0], "cy")]), "ab");
  assert.equal(thin.signature, null);
});

test("unknown song or artist gives an empty history, not an error", () => {
  const c = cat([ev("2020-01-01")], []);
  assert.equal(songHistory(c, "no|such").verdict, "never");
  assert.equal(artistHistory(c, "nobody").plays, 0);
});

test("span labels and the copied summary", () => {
  assert.equal(spanLabel(0), "0 days");
  assert.equal(spanLabel(365), "1 year");
  assert.equal(spanLabel(200), "7 months");
  const h = songHistory(cat([ev("2017-08-05")], [tr("2017-08-05", "bo")]), "ab|song");
  const text = summaryText("Ab - Song", h);
  assert.match(text, /^Ab - Song\nA one-off/);
  assert.match(text, /First: 5 Aug 2017, Bo \(roll\)/);
  assert.match(text, /Brought by: Bo x1/);
});

if (failures.length) {
  console.error(`songstats: ${failures.length} failed, ${passed} passed\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`songstats: ${passed} passed`);
