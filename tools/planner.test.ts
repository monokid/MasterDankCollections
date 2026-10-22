/** Tests for src/planner.ts -- the "has this been brought before?" check.
 *
 *  Each is named after the way the verdict would quietly go wrong: a planner
 *  that says "new" for a song the group has played is worse than no planner.
 */
import assert from "node:assert/strict";
import { fold as distillFold, splitVariant as distillSplit } from "./distill.ts";
import { fold, splitVariant } from "../src/identity.ts";
import {
  buildPlanIndex, checkList, newOnes, parseExportify, parseList, summarise, variantKind,
} from "../src/planner.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

// A small library: two nights, one shelf, three people (Cal among them).
const ev = (id: string, date: string | null, kind = "event") =>
  ({ id, date, kind, people: [], types: [] });
const tr = (id: string, eventId: string, artist: string, base: string, personId: string | null, over: object = {}) =>
  ({ id, eventId, personId, flags: [], variant: null, songId: `${fold(artist)}|${fold(base)}`, ...over });

const cat = {
  events: [ev("n1", "2016-01-02"), ev("n2", "2019-05-04"), ev("shelf", null, "collection")],
  people: [
    { id: "cal", name: "Cal", isYou: true }, { id: "dov", name: "Dov", isYou: false },
    { id: "bo", name: "Bo", isYou: false },
  ],
  artists: [
    { id: "nightwish", name: "Nightwish" }, { id: "heilung", name: "Heilung" },
    { id: "rammstein", name: "Rammstein" }, { id: "the pillows", name: "The Pillows" },
    { id: "sigur ros", name: "Sigur Rós" },
  ],
  tracks: [
    tr("a1", "n1", "Nightwish", "Ghost Love Score", "cal"),
    tr("a2", "n2", "Nightwish", "Ghost Love Score", "dov"),
    tr("a3", "n2", "Nightwish", "Ghost Love Score", "dov", { flags: ["anon"] }),   // the same playlist again
    tr("b1", "n2", "Rammstein", "Du riechst so gut", "bo", { variant: "Live" }),
    tr("c1", "n1", "Heilung", "Hamrer Hippyer", "dov"),
    tr("c2", "n2", "Heilung", "Norupo", "dov"),
    tr("d1", "n1", "The Pillows", "Ride on Shooting Star", "bo"),
    tr("e1", "shelf", "Sigur Rós", "Takk", null),
  ],
} as never;
const ix = buildPlanIndex(cat);

const run = (lines: string) => checkList(ix, parseList(lines, ix).candidates);
const verdicts = (lines: string) => run(lines).map((r) => r.verdict);

test("the page's copy of fold and splitVariant agrees with the distiller's", () => {
  // The distiller built every songId; if the copy drifts, the planner says "new" for played songs.
  const titles = [
    "King Nothing (Live)", "Ghost Love Score - Live 2019", "Song [Remastered 2011]", "Parts I-V (Parts I-V)",
    "Bohemian Rhapsody", "Sidequest (Dr. Peacock Remix)", "Hello - Acoustic Version", "Café del Mar",
    "白い夏と緑の自転車", "Don't Stop (Instrumental)", "Plain - Radio Edit",
  ];
  for (const t of titles) {
    assert.equal(fold(t), distillFold(t), t);
    assert.deepEqual(splitVariant(t), distillSplit(t), t);
  }
});

test("a song played on a night is 'played', with its nights, dates and who brought it", () => {
  const [r] = run("Nightwish - Ghost Love Score");
  assert.equal(r.verdict, "played");
  assert.equal(r.nights, 2, "the anonymised copy is not a third night");
  assert.equal(r.first, "2016-01-02");
  assert.equal(r.last, "2019-05-04");
  assert.deepEqual(r.bringers.sort(), ["Cal", "Dov"]);
  assert.equal(r.you, true, "Cal brought it");
});

test("a song only ever played as a live version still counts as played, and says which", () => {
  const [r] = run("Rammstein - Du riechst so gut");
  assert.equal(r.verdict, "variant", "the studio version was never played, but the song was");
  assert.equal(r.label, "played as Live, 2019");
  assert.equal(r.nights, 1);
});

test("asking for the live version of a song only played plain is also a variant", () => {
  const [r] = run("Nightwish - Ghost Love Score (Live)");
  assert.equal(r.verdict, "variant");
  assert.equal(r.label, "played as the original, 2019");
});

test("asking for the exact live version that was played is 'played', not a variant", () => {
  assert.equal(verdicts("Rammstein - Du riechst so gut (Live)")[0], "played");
  assert.equal(verdicts("Rammstein - Du riechst so gut - Live at Wembley")[0], "played");
});

test("a remaster is the same version, not another one", () => {
  assert.equal(variantKind("Remastered 2009"), "");
  assert.deepEqual(verdicts([
    "Nightwish - Ghost Love Score - 2011 Remaster",
    "Nightwish - Ghost Love Score (Remastered)",
  ].join("\n")).slice(0, 1), ["played"]);
});

test("the same song twice in the pasted list is a clash, even spelled differently", () => {
  const v = verdicts([
    "Nightwish - Ghost Love Score",
    "NIGHTWISH – Ghost Love Score (feat. Somebody)",
    "Totally Unknown - Brand New",
    "totally unknown - brand new!",
    "Ghost Love Score - Nightwish",
  ].join("\n"));
  assert.deepEqual(v, ["played", "clash", "never", "clash", "clash"]);
});

test("a clash points at the earlier line and keeps what the library says", () => {
  const rows = run("Nightwish - Ghost Love Score\n\nNightwish - Ghost Love Score");
  assert.equal(rows[1].clashWith, rows[0].cand.line);
  assert.equal(rows[1].found, "played");
  assert.equal(rows[1].cand.line, 3, "blank lines still count for the line number");
});

test("a song that is not on any night is 'never', but the artist's history still shows", () => {
  const [r] = run("Heilung - Something Unplayed");
  assert.equal(r.verdict, "never");
  assert.equal(r.artist?.songs, 2);
  assert.equal(r.artist?.nights, 2);
  assert.equal(r.artist?.last, "2019-05-04");
  assert.equal(run("Nobody Known - Nothing")[0].artist, null);
});

test("a song that only sits on a shelf was never played on a night", () => {
  const [r] = run("Sigur Rós - Takk");
  assert.equal(r.verdict, "never", "favs and mix are shelves, not nights");
  assert.equal(r.shelf, true);
});

test("either order, numbering, bullets, en dashes and quotes all read the same", () => {
  const v = verdicts([
    "01. Nightwish - Ghost Love Score",
    "2) Ghost Love Score – Nightwish",
    "- \"Nightwish\" - \"Ghost Love Score\"",
    "Nightwish\tGhost Love Score",
    "the pillows - Ride On Shooting Star",
    "Pillows - Ride On Shooting Star",
  ].join("\n"));
  // The last two are The Pillows, with and without the "The".
  assert.deepEqual(v, ["played", "clash", "clash", "clash", "played", "clash"]);
});

test("a title that contains a dash is not cut in two", () => {
  const parsed = parseList("Boards of Canada - Roygbiv - Remastered", ix).candidates[0];
  assert.equal(parsed.artists[0], "Boards of Canada");
  assert.equal(parsed.title, "Roygbiv - Remastered");
});

test("a line with no separator is reported as skipped, not silently dropped", () => {
  const p = parseList("Nightwish - Ghost Love Score\njust some words", ix);
  assert.equal(p.candidates.length, 1);
  assert.deepEqual(p.skipped, ["just some words"]);
});

test("an Exportify file reads the first of several artists and tries the rest", () => {
  const csv = 'Track URI,Track Name,Artist Name(s),Duration (ms)\r\n' +
    'spotify:track:1,"Ghost Love Score",Nightwish,600000\r\n' +
    'spotify:track:2,"Du riechst so gut","Guest; Rammstein",250000\r\n' +
    'spotify:track:3,"Comma, in the title",Nobody,1000\r\n';
  const p = parseExportify(csv);
  assert.equal(p.candidates.length, 3);
  assert.equal(p.candidates[1].artists[0], "Guest");
  const rows = checkList(ix, p.candidates);
  assert.deepEqual(rows.map((r) => r.verdict), ["played", "variant", "never"]);
  assert.equal(parseExportify("a,b\n1,2").candidates.length, 0);
});

test("the summary and the copy list count only what is new", () => {
  const rows = run([
    "Nightwish - Ghost Love Score", "Rammstein - Du riechst so gut",
    "Heilung - Fresh One", "Heilung - Fresh One", "Zed - Zing",
  ].join("\n"));
  const s = summarise(rows);
  assert.equal(s.sentence, "2 of 5 are new to the library, 1 played before, 1 as other versions, 1 repeated in your list");
  assert.equal(newOnes(rows), "Heilung - Fresh One\nZed - Zing", "a repeat is not copied twice");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
