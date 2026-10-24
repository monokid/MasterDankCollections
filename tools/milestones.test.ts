/** Tests for src/milestones.ts. Each is named after the way the numbers would quietly go wrong. */
import assert from "node:assert/strict";
import { buildMilestones, gapWords, type Milestone, type MilestoneKind } from "../src/milestones.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const ev = (id: string, people: string[], over: object = {}) =>
  ({ id, date: id, kind: "event", people, types: [], title: "", durationSec: 3600, playedCount: 0, ...over });
let n = 0;
const tr = (eventId: string, songId: string | null, personId: string | null, over: object = {}) =>
  ({ id: `t${++n}`, eventId, songId, personId, flags: [], played: true, durationSec: 240, twinId: null, ...over });
const mk = (events: object[], tracks: object[], people: object[] = []) =>
  ({ events, tracks, people, songs: [], artists: [], phases: [] }) as never;
const of = (ms: Milestone[], kind: MilestoneKind) => ms.filter((m) => m.kind === kind);
const id = (e: object) => (e as { id: string }).id;

// ------------------------------------------------------------------ people

test("the opening night is not 'new': nobody joins, no year begins, no kind of night is first", () => {
  const ms = buildMilestones(mk([ev("2016-01-01", ["a", "b"], { types: ["roll"] })], [tr("2016-01-01", "x|s", "a")]));
  assert.equal(ms.length, 0);
});

test("a person's first night after the opening is a join, and the opening crowd never joins", () => {
  const ms = buildMilestones(mk(
    [ev("2016-01-01", ["a"]), ev("2016-02-01", ["a", "b"])], [],
    [{ id: "b", name: "Lore" }]));
  assert.deepEqual(of(ms, "join").map((m) => m.text), ["Lore joins"]);
  assert.equal(of(ms, "join")[0].link?.id, "b");
});

test("a person with one night (Glenn) joins once and never returns", () => {
  const ms = buildMilestones(mk(
    [ev("2016-01-01", ["a"]), ev("2016-03-01", ["a", "g"]), ev("2019-01-01", ["a"])], [], [{ id: "g", name: "Glenn" }]));
  assert.equal(of(ms, "join").filter((m) => m.text === "Glenn joins").length, 1);
  assert.equal(of(ms, "return").filter((m) => m.link?.id === "g").length, 0);
  assert.ok(of(ms, "join")[0].detail?.includes("only night"));
});

test("a single missed night is not a return; a break of a year or more is, in months then years", () => {
  const ms = buildMilestones(mk(
    [ev("2016-01-01", ["a", "t"]), ev("2016-02-01", ["a"]), ev("2016-03-01", ["a", "t"]),   // missed one night: not a break
     ev("2018-03-02", ["t"])],                                                             // 2 years and 1 day later
    [], [{ id: "t", name: "Tim" }]));
  assert.deepEqual(of(ms, "return").map((m) => m.text), ["Tim is back after 2 years"]);
  assert.equal(of(ms, "return")[0].date, "2018-03-02");
  assert.equal(gapWords(400), "13 months");
  assert.equal(gapWords(365), "12 months");
  assert.equal(gapWords(3 * 365.25), "3 years");
});

test("a person's last night to date is not a milestone", () => {
  const ms = buildMilestones(mk([ev("2016-01-01", ["a", "b"]), ev("2016-02-01", ["a"])], []));
  assert.equal(ms.filter((m) => m.date === "2016-02-01").length, 0);
});

// --------------------------------------------------------------- cumulative

test("a thousand-play threshold crossed inside a night is reported once on that night, at its highest", () => {
  const tracks: object[] = [];
  for (let i = 0; i < 2100; i++) tracks.push(tr("2016-02-01", `x|s${i}`, "a"));
  const ms = buildMilestones(mk([ev("2016-01-01", ["a"]), ev("2016-02-01", ["a"])], tracks));
  const plays = of(ms, "plays");
  assert.equal(plays.length, 1);
  assert.equal(plays[0].text, "passed 2,000 plays");
  assert.equal(plays[0].date, "2016-02-01");
});

test("twins and copies do not double-count plays towards a threshold", () => {
  const tracks: object[] = [];
  for (let i = 0; i < 600; i++) {
    tracks.push(tr("2016-02-01", `x|s${i}`, "a", { id: `N${i}`, twinId: `A${i}` }));
    tracks.push(tr("2016-02-01", null, "a", { id: `A${i}`, twinId: `N${i}`, flags: ["anon"] }));
    tracks.push(tr("2016-02-01", `x|s${i}`, "a", { flags: ["copy"] }));
  }
  const ms = buildMilestones(mk([ev("2016-01-01", ["a"]), ev("2016-02-01", ["a"])], tracks));
  assert.equal(of(ms, "plays").length, 0);          // 600 plays, not 1,800
});

test("hours are summed from played tracks only, every 100 hours", () => {
  const tracks: object[] = [];
  for (let i = 0; i < 100; i++) tracks.push(tr("2016-02-01", `x|s${i}`, "a", { durationSec: 3600 }));     // 100 h
  tracks.push(tr("2016-02-01", "x|unplayed", "a", { durationSec: 3600 * 500, played: false }));
  const ms = buildMilestones(mk([ev("2016-01-01", ["a"]), ev("2016-02-01", ["a"])], tracks));
  assert.deepEqual(of(ms, "hours").map((m) => m.text), ["passed 100 hours of music"]);
});

test("the 500th different song counts distinct songs, not plays of the same one", () => {
  const tracks: object[] = [];
  for (let i = 0; i < 499; i++) tracks.push(tr("2016-01-01", `x|s${i}`, "a"));
  tracks.push(tr("2016-02-01", "x|s0", "a"), tr("2016-02-01", "x|s1", "b"));          // repeats: still 499
  tracks.push(tr("2016-03-01", "x|new", "a"));                                         // the 500th
  const ms = buildMilestones(mk([ev("2016-01-01", ["a"]), ev("2016-02-01", ["a", "b"]), ev("2016-03-01", ["a"])], tracks));
  const s = of(ms, "songs");
  assert.equal(s.length, 1);
  assert.equal(s[0].date, "2016-03-01");
  assert.equal(s[0].text, "the 500th different song");
});

// ------------------------------------------------------------------ records

test("a group-size record must beat the earlier best: ties are not records, small groups are not news", () => {
  const ms = buildMilestones(mk([
    ev("2016-01-01", ["a", "b", "c"]),
    ev("2016-02-01", ["a", "b", "c", "d"]),                    // 4 > 3
    ev("2016-03-01", ["a", "b", "c", "d"]),                    // tie
    ev("2016-04-01", ["a", "b", "c", "d", "e"]),               // 5
  ], []));
  assert.deepEqual(of(ms, "group").map((m) => [m.date, m.text]), [
    ["2016-02-01", "most people at one night so far: 4"], ["2016-04-01", "most people at one night so far: 5"]]);
});

test("the longest night is announced only when it beats the last record by 30 minutes", () => {
  const ms = buildMilestones(mk([
    ev("2016-01-01", ["a"], { durationSec: 3 * 3600 }),
    ev("2016-02-01", ["a"], { durationSec: 3 * 3600 + 600 }),      // +10 min: not announced
    ev("2016-03-01", ["a"], { durationSec: 3 * 3600 + 1800 }),     // +30 min on the record to beat
    ev("2016-04-01", ["a"], { durationSec: 3 * 3600 + 1800 }),     // tie
  ], []));
  assert.deepEqual(of(ms, "longest").map((m) => m.date), ["2016-03-01"]);
});

// ---------------------------------------------------------------- pioneers

test("an artist staple is judged by distinct nights, not plays, and only its first night is marked", () => {
  const evs: object[] = [ev("2016-01-01", ["a"])];
  const tracks: object[] = [tr("2016-01-01", "o|x", "a")];
  for (let m = 2; m <= 6; m++) {
    const d = `2016-0${m}-01`;
    evs.push(ev(d, ["a"]));
    tracks.push(tr(d, m === 2 ? "g|one" : "g|two", "a"), tr(d, "g|two", "b"), tr(d, "g|three", "a"));   // many plays, one night each
  }
  const p = of(buildMilestones(mk(evs, tracks)), "pioneer");
  assert.equal(p.length, 1);
  assert.equal(p[0].date, "2016-02-01");
  assert.equal(p[0].detail, "later on 4 nights");
  assert.deepEqual(p[0].link, { type: "artist", id: "g" });
});

test("an artist on 4 nights is not yet a staple; one on the opening night is not a pioneer", () => {
  const evs = ["2016-01-01", "2016-02-01", "2016-03-01", "2016-04-01"].map((d) => ev(d, ["a"]));
  assert.equal(of(buildMilestones(mk(evs, evs.map((e) => tr(id(e), "g|s", "a")))), "pioneer").length, 0);
  const evs6 = ["2016-01-01", "2016-02-01", "2016-03-01", "2016-04-01", "2016-05-01", "2016-06-01"].map((d) => ev(d, ["a"]));
  assert.equal(of(buildMilestones(mk(evs6, evs6.map((e) => tr(id(e), "g|s", "a")))), "pioneer").length, 0);
});

test("ties on the same night: at most 2 pioneer artists, the bigger staples first", () => {
  const evs: object[] = [ev("2016-01-01", ["a"])], tracks: object[] = [];
  const dates = ["2016-02-01", "2016-03-01", "2016-04-01", "2016-05-01", "2016-06-01", "2016-07-01"];
  dates.forEach((d) => evs.push(ev(d, ["a"])));
  for (const art of ["p", "q", "r"]) tracks.push(tr("2016-02-01", `${art}|s`, "a"));
  dates.slice(1, 5).forEach((d) => tracks.push(tr(d, "p|s", "a"), tr(d, "q|s", "a")));        // p, q: 5 nights
  dates.slice(1, 6).forEach((d) => tracks.push(tr(d, "r|s", "a")));                           // r: 6 nights
  const p = of(buildMilestones(mk(evs, tracks)), "pioneer");
  assert.deepEqual(p.map((m) => m.link?.id), ["r", "p"]);
});

test("a song first brought and later on 6+ nights is a seed; on 5 it is not", () => {
  const dates = ["2016-01-01", "2016-02-01", "2016-03-01", "2016-04-01", "2016-05-01", "2016-06-01", "2016-07-01"];
  const evs = dates.map((d) => ev(d, ["a"]));
  const six = dates.slice(1).map((d) => tr(d, "z|six", "a"));            // 6 nights
  const five = dates.slice(1, 6).map((d) => tr(d, "y|five", "a"));
  const ms = buildMilestones(mk(evs, [...six, ...five]));
  assert.deepEqual(of(ms, "seed").map((m) => m.link?.id), ["z|six"]);
});

// ---------------------------------------------------------- calendar & kinds

test("each year begins once (not the opening year), and a new kind of night is marked once", () => {
  const ms = buildMilestones(mk([
    ev("2016-12-01", ["a"], { types: ["roll"] }),
    ev("2017-01-05", ["a"], { types: ["roll", "candyflip"] }),
    ev("2017-02-05", ["a"], { types: ["candyflip"] }),
    ev("2018-01-05", ["a"]),
  ], []));
  assert.deepEqual(of(ms, "year").map((m) => m.text), ["2017 begins", "2018 begins"]);
  assert.deepEqual(of(ms, "nighttype").map((m) => m.text), ["first Candyflip night"]);
});

// ------------------------------------------------------------------- the cap

test("a flooded night is capped by priority: joins before years and kinds", () => {
  const people = ["b", "c", "d", "e", "f", "g"];
  const ms = buildMilestones(mk([ev("2016-12-01", ["a"]), ev("2017-01-01", ["a", ...people], { types: ["trip"] })], []));
  const day = ms.filter((m) => m.date === "2017-01-01");
  assert.equal(day.length, 4);
  assert.ok(day.every((m) => m.kind === "join" || m.kind === "group"));
});

// ------------------------------------------------- whole library, not a range

test("milestones take the catalogue alone: no range or zoom to change them", () => {
  const cat = mk([ev("2016-01-01", ["a"]), ev("2016-02-01", ["a", "b"])], []);
  assert.deepEqual(buildMilestones(cat), buildMilestones(cat));
  assert.equal(buildMilestones.length, 1);
});

if (failures.length) {
  console.error(`milestones: ${failures.length} failed, ${passed} passed\n` + failures.join("\n"));
  process.exit(1);
}
console.log(`milestones: ${passed} passed`);
