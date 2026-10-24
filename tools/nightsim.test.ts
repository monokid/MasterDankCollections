/** The simulated night's logic. Each test is named after the way the simulation could go wrong. */
import assert from "node:assert/strict";
import type { Phase, Track } from "../src/catalog.ts";
import { fmtClock, mapPhases, seededShuffle, simText, simulateNight } from "../src/nightsim.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n").slice(0, 8).join(" | ")}`); }
}

const trk = (id: string, over: Partial<Track> = {}): Track => ({
  id, eventId: "e1", personId: "a", phaseId: null, artist: "Art", title: id, album: null, genre: null,
  songId: id, twinId: null, playOrder: null, variant: null, durationSec: 200, ext: "mp3",
  sizeBytes: 1, path: [], source: "s", played: true, flags: [], provenance: {}, ...over,
});
const ph = (person: string, clean: string, position: number, over: Partial<Phase> = {}): Phase => ({
  id: `e1:${person}:${clean}`, eventId: "e1", personId: person, label: clean, clean, bucket: "other", order: null,
  minutes: null, trackCount: 1, position, basis: "word", inferred: false, ...over,
});

/** Three people; a and b share "Peak" and "Afterglow", c names its phases differently. */
function night() {
  const phases = [
    ph("a", "Intro", 0), ph("a", "Peak", 1), ph("a", "Afterglow", 2),
    ph("b", "Peak", 0), ph("b", "Afterglow", 1),
    ph("c", "One", 0), ph("c", "Two", 1), ph("c", "Three", 2),
  ];
  const tracks: Track[] = [];
  for (const p of phases) for (let i = 0; i < 4; i++) {
    tracks.push(trk(`${p.id}#${i}`, { personId: p.personId, phaseId: p.id }));
  }
  return { phases, tracks };
}
const ids = (s: ReturnType<typeof simulateNight>) => s.blocks.flatMap((b) => b.rows.map((r) => r.track.id));
const slotLabels = (s: ReturnType<typeof simulateNight>) => s.blocks.map((b) => b.labels.join("+"));

test("determinism: the same night and seed give the same order on every call", () => {
  const { phases, tracks } = night();
  assert.deepEqual(ids(simulateNight("e1", tracks, phases, 7)), ids(simulateNight("e1", tracks, phases, 7)));
});
test("determinism: the order does not depend on the order the tracks arrive in", () => {
  const { phases, tracks } = night();
  assert.deepEqual(ids(simulateNight("e1", tracks, phases, 3)), ids(simulateNight("e1", [...tracks].reverse(), phases, 3)));
});
test("reshuffle: a new seed changes the order but never the set of tracks", () => {
  const { phases, tracks } = night();
  const a = ids(simulateNight("e1", tracks, phases, 1)), b = ids(simulateNight("e1", tracks, phases, 2));
  assert.notDeepEqual(a, b);
  assert.deepEqual([...a].sort(), [...b].sort());
});
test("reshuffle: songs never leave their phase", () => {
  const { phases, tracks } = night();
  const cleanOf = new Map(phases.map((p) => [p.id, p.clean]));
  for (const seed of [1, 2, 3, 99]) {
    for (const b of simulateNight("e1", tracks, phases, seed).blocks) {
      assert.ok(b.rows.every((r) => b.labels.includes(cleanOf.get(r.track.phaseId!)!)), `${seed} ${b.labels}`);
    }
  }
});
test("shuffle: people are mixed inside a phase, not listed person by person", () => {
  const { phases, tracks } = night();
  const peak = simulateNight("e1", tracks, phases, 1).blocks.find((b) => b.labels.includes("Peak"))!;
  assert.ok(peak.personIds.includes("a") && peak.personIds.includes("b"));
  const runs = peak.rows.filter((r, i) => i > 0 && r.track.personId !== peak.rows[i - 1].track.personId).length;
  assert.ok(runs >= 2, "contributors interleave");
});
test("phase order: Intro, then Peak, then Afterglow, with the clock rising through them", () => {
  const { phases, tracks } = night();
  const s = simulateNight("e1", tracks, phases, 5);
  const names = s.blocks.map((b) => b.labels.join(" "));
  assert.ok(names[0].startsWith("Intro"), names.join(" | "));
  assert.ok(names[names.length - 1].includes("Afterglow"));
  assert.ok(names.findIndex((n) => n.includes("Peak")) < names.findIndex((n) => n.includes("Afterglow")));
  const starts = s.blocks.flatMap((b) => b.rows.map((r) => r.startSec!));
  assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
});
test("each track exactly once", () => {
  const { phases, tracks } = night();
  const out = ids(simulateNight("e1", tracks, phases, 4));
  assert.equal(out.length, tracks.length);
  assert.equal(new Set(out).size, tracks.length);
});
test("copies excluded: an anonymised twin or a repeated file is not in the night", () => {
  const { phases, tracks } = night();
  const copy = trk("copy", { personId: "a", phaseId: tracks[0].phaseId, played: false, flags: ["anon"] });
  const s = simulateNight("e1", [...tracks, copy], phases, 1);
  assert.ok(!ids(s).includes("copy"));
  assert.equal(s.songs, tracks.length);
});
test("unnamed played files stay in as rows, and unplayed ones do not", () => {
  const anon = trk("anon", { songId: null, title: null, artist: null, flags: ["anon"] });
  const s = simulateNight("e1", [anon, trk("x", { played: false })], [], 1);
  assert.deepEqual(ids(s), ["anon"]);
  assert.match(simText(s, () => "A", () => "Whole night"), /unnamed track/);
});
test("phase mapping: a label two people share is one phase even when positions differ", () => {
  // a: Intro, Peak, Afterglow; b: Peak, Afterglow -- b's first phase is a's second.
  const { phases, tracks } = night();
  const names = slotLabels(simulateNight("e1", tracks.filter((t) => t.personId !== "c"), phases, 1));
  assert.deepEqual(names, ["Intro", "Peak", "Afterglow"]);
});
test("phase mapping: labels that differ everywhere fall back to place in each list", () => {
  const phases = [ph("a", "Warm", 0), ph("a", "Hot", 1), ph("b", "Slow", 0), ph("b", "Fast", 1)];
  const tracks = phases.flatMap((p) => [trk(`${p.id}1`, { personId: p.personId, phaseId: p.id })]);
  const s = simulateNight("e1", tracks, phases, 1);
  assert.deepEqual(s.blocks.map((b) => b.labels.length), [2, 2]);
  assert.deepEqual(s.blocks[0].labels.sort(), ["Slow", "Warm"]);
});
test("phase mapping: a person with fewer phases is scaled onto the night's longest list", () => {
  const phases = [ph("a", "A1", 0), ph("a", "A2", 1), ph("a", "A3", 2), ph("a", "A4", 3), ph("b", "B1", 0), ph("b", "B2", 1)];
  const { slotOf, slots } = mapPhases(phases, new Set(phases.map((p) => p.id)));
  assert.equal(slots, 4);
  assert.equal(slotOf.get("e1:b:B1"), 0);
  assert.equal(slotOf.get("e1:b:B2"), 3);
});
test("phase mapping: a phase only one person has still gets a block of its own", () => {
  const phases = [ph("a", "Intro", 0), ph("a", "Peak", 1), ph("b", "Peak", 0)];
  const tracks = [trk("a1", { phaseId: "e1:a:Intro" }), trk("a2", { phaseId: "e1:a:Peak" }),
    trk("b1", { personId: "b", phaseId: "e1:b:Peak" })];
  const s = simulateNight("e1", tracks, phases, 1);
  assert.deepEqual(s.blocks.map((b) => [b.labels.join(), b.rows.length]), [["Intro", 1], ["Peak", 2]]);
});
test("phase mapping: a phase with no played song cannot take a slot", () => {
  const phases = [ph("a", "Ghost", 0), ph("a", "Real", 1)];
  const s = simulateNight("e1", [trk("x", { phaseId: "e1:a:Real" })], phases, 1);
  assert.equal(s.blocks.length, 1);
  assert.deepEqual(s.blocks[0].labels, ["Real"]);
});
test("no phases: one whole-night block, shuffled together, clock running", () => {
  const tracks = ["a", "b", "c", "d"].map((x, i) => trk(x, { personId: i % 2 ? "p" : "q" }));
  const s = simulateNight("e1", tracks, [], 1);
  assert.equal(s.phased, false);
  assert.equal(s.blocks.length, 1);
  assert.equal(s.blocks[0].kind, "whole");
  assert.equal(s.blocks[0].rows[3].startSec, 600);
  assert.equal(s.looseSongs, 0);
});
test("no tracks at all: no blocks, no crash", () => {
  const s = simulateNight("e1", [], [], 1);
  assert.deepEqual([s.blocks.length, s.songs, s.totalSeconds, s.medianSec], [0, 0, 0, 0]);
});
test("single person: phases still order the night and nobody else is invented", () => {
  const phases = [ph("a", "Intro", 0), ph("a", "Peak", 1)];
  const tracks = [trk("a1", { phaseId: "e1:a:Peak" }), trk("a2", { phaseId: "e1:a:Intro" })];
  const s = simulateNight("e1", tracks, phases, 1);
  assert.deepEqual(ids(s), ["a2", "a1"]);
  assert.deepEqual(s.blocks.map((b) => b.personIds), [["a"], ["a"]]);
});
test("songs outside any phase come last, with no clock time, and do not move the clock", () => {
  const phases = [ph("a", "Intro", 0)];
  const tracks = [trk("in", { phaseId: "e1:a:Intro" }), trk("out1"), trk("out2", { personId: "b" })];
  const s = simulateNight("e1", tracks, phases, 1);
  assert.deepEqual(s.blocks.map((b) => b.kind), ["phase", "loose"]);
  assert.ok(s.blocks[1].rows.every((r) => r.startSec === null));
  assert.equal(s.timedSeconds, 200);
  assert.equal(s.looseSeconds, 400);
  assert.equal(s.totalSeconds, 600);
  assert.equal(s.looseSongs, 2);
});
test("a phase id the catalogue does not know counts as no phase", () => {
  const phases = [ph("a", "Intro", 0)];
  const s = simulateNight("e1", [trk("in", { phaseId: "e1:a:Intro" }), trk("odd", { phaseId: "nope" })], phases, 1);
  assert.deepEqual(s.blocks.map((b) => b.kind), ["phase", "loose"]);
});
test("unknown durations count as the night's median and are flagged, never as zero", () => {
  const tracks = [trk("a", { durationSec: 100 }), trk("b", { durationSec: 300 }), trk("c", { durationSec: 500 }),
    trk("d", { durationSec: null }), trk("e", { durationSec: 0 })];
  const s = simulateNight("e1", tracks, [], 1);
  assert.equal(s.medianSec, 300);
  const rows = s.blocks[0].rows;
  assert.equal(rows.filter((r) => r.estimated).length, 2);
  assert.ok(rows.filter((r) => r.estimated).every((r) => r.durSec === 300));
  assert.equal(s.totalSeconds, 100 + 300 + 500 + 600);
  assert.equal(s.estimatedRows, 2);
});
test("running clock: starts at 0:00 and every start is the sum of the lengths before it", () => {
  const tracks = [trk("a", { durationSec: 61 }), trk("b", { durationSec: 125 }), trk("c", { durationSec: 3600 })];
  const rows = simulateNight("e1", tracks, [], 2).blocks[0].rows;
  assert.equal(rows[0].startSec, 0);
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].startSec, rows[i - 1].startSec! + rows[i - 1].durSec);
});
test("running clock: a start after a stand-in length is marked approximate, earlier ones are not", () => {
  const tracks = [trk("a", { durationSec: 100 }), trk("b", { durationSec: null }), trk("c", { durationSec: 100 })];
  const rows = simulateNight("e1", tracks, [], 1).blocks[0].rows;
  const firstEst = rows.findIndex((r) => r.estimated);
  rows.forEach((r, i) => assert.equal(r.startApprox, i > firstEst, `row ${i}`));
});
test("clock text: no 59:60 and hours only when needed", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(3599.6), "1:00:00");
  assert.equal(fmtClock(725), "12:05");
  assert.equal(fmtClock(-4), "0:00");
});
test("setlist text carries the clock, the person, and the tilde for stand-in lengths", () => {
  const tracks = [trk("a", { durationSec: 120, title: "First" }), trk("b", { durationSec: null, title: "Second", personId: "z" })];
  const s = simulateNight("e1", tracks, [], 1);
  const text = simText(s, (p) => `P-${p}`, () => "Whole night");
  const lines = text.split("\n");
  assert.match(text, /Whole night \(/);
  assert.ok(lines.some((l) => /^0:00 {2}Art - \w+ {2}\(P-/.test(l)), text);
  assert.ok(lines.some((l) => l.includes("~2:00")), text);
});
test("seededShuffle: never loses or repeats an item, and does not touch its input", () => {
  const xs = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}` }));
  const copy = [...xs];
  const out = seededShuffle(xs, "k");
  assert.deepEqual(xs, copy);
  assert.deepEqual(out.map((x) => x.id).sort(), xs.map((x) => x.id).sort());
});

if (failures.length) {
  console.error(`${failures.length} failed, ${passed} passed\n` + failures.map((f) => "  x " + f).join("\n"));
  process.exit(1);
}
console.log(`nightsim: ${passed} passed`);
