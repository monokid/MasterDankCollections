/** Distiller regression tests. Run with `npm run verify`.
 *
 *  Each test is named after the thing that would break. The important one is
 *  `unresolved tracks still reach the catalogue` -- that is the rule three
 *  previous attempts at this library violated, and the one worth failing loudly.
 */
import assert from "node:assert/strict";
import {
  distill as distillOne, audioOf, detectAnonFolders, parseEventFolder, parsePhaseLabel,
  parseFilename, phaseBucket, splitVariant, eventTypes, applyPlacements, analyseAnon, pairByDuration, nameNumber,
  type Crawl, type Rules,
} from "./distill.ts";
import { importExports } from "./spotify.ts";

/** The distiller merges crawls now; most tests only care about one. */
const distill = (c: Crawl, r: Rules) => distillOne([{ id: "test", crawl: c }], r);

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

const RULES: Rules = {
  segmentRoles: {}, personAliases: {}, notPeople: [], eventDates: {},
  collections: [], you: "Cal",
};

/** Distinct real-looking artists. Fixtures must not name them "Artist 1",
 *  "Artist 2": a repeated word with a changing number is numbering, and the
 *  detector is right to read it as placeholders. */
const BANDS = ["Heilung", "Sinners", "Opeth", "Tool", "Gorillaz", "Muse", "Rush", "Ghost", "Sabaton"];

/** n tracks of one artist/title on n separate nights. */
const played = (artist: string, title: string, dates: string[]) =>
  dates.map((d, i) => file([`${d} Roll`, "Ada", `${i}.mp3`], { artist, title }));

const file = (p: string[], e?: Record<string, string>, ext = ".mp3") =>
  ({ p, sz: 1000, mt: 0, ext, a: { dur: 100 }, e });

const crawlOf = (files: ReturnType<typeof file>[]): Crawl => ({
  schema: "mdc-crawl/2", scanned_at: "2026-01-01T00:00:00+00:00",
  root_name: "test", machine: "test",
  counts: { media: files.length, excluded: 0 },
  files,
});

// ------------------------------------------------------------------ parsing

test("event folder yields a date and a title", () => {
  assert.deepEqual(parseEventFolder("20240504 Rollenbollen"),
    { date: "2024-05-04", rest: "Rollenbollen" });
  assert.deepEqual(parseEventFolder("20150925"), { date: "2015-09-25", rest: "" });
});

test("event folder with no date stays undated rather than guessing", () => {
  assert.equal(parseEventFolder("rollekes").date, null);
  assert.equal(parseEventFolder("99991350 Nope").date, null);   // month 13
});

test("phase label yields ordering from its numeric prefix", () => {
  assert.equal(parsePhaseLabel("01 - Intro").order, 1);
  assert.equal(parsePhaseLabel("2. TOCH").order, 2);
  assert.equal(parsePhaseLabel("3 MAMAAaaaaaaaaaaa").order, 3);
  assert.equal(parsePhaseLabel("Afterglow").order, null);
});

test("phase label yields minutes from its trailing count", () => {
  assert.equal(parsePhaseLabel("Mid 75").minutes, 75);
  assert.equal(parsePhaseLabel("Outro 30").minutes, 30);
  assert.equal(parsePhaseLabel("Intro 15").clean, "Intro");
});

test("phase vocabulary maps onto the arc", () => {
  assert.equal(phaseBucket("Intro"), "early");
  assert.equal(phaseBucket("come up"), "early");
  assert.equal(phaseBucket("Peak"), "peak");
  assert.equal(phaseBucket("Mid"), "peak");
  assert.equal(phaseBucket("Outro"), "late");
  assert.equal(phaseBucket("Afterglow"), "afterglow");
  assert.equal(phaseBucket("DO YOU KNOW"), "other");
  // This library's own words for the same three places.
  assert.equal(phaseBucket("Pre"), "early");
  assert.equal(phaseBucket("Main"), "peak");
  assert.equal(phaseBucket("Post"), "late");
});

test("filename splits into artist and title", () => {
  assert.deepEqual(parseFilename("Pink Floyd - Have A Cigar.mp3"),
    { artist: "Pink Floyd", title: "Have A Cigar" });
  assert.deepEqual(parseFilename("001 - DeGemaneDikkeSchijf.mp3"),
    { artist: null, title: "DeGemaneDikkeSchijf" });
});

test("a shouty phase name is not evidence the audio was stripped", () => {
  // "1. DO YOU KNOW" is a joke folder name. The tracks inside it are fully
  // tagged and must stay in search.
  const files = "ABCDEFGH".split("").map((a, i) =>
    file(["20210504 Roll", "Named", "1. DO YOU KNOW", `${i}.mp3`],
      { artist: a, title: `song ${i}` }));
  const c = distill(crawlOf(files), RULES);
  assert.equal(c.tracks.filter((t) => t.flags.includes("anon")).length, 0);
});

test("an untagged folder whose filenames are real names is not anonymised", () => {
  // No tags, but "Artist - Title" filenames carry everything search needs.
  const names = ["League of Legends - Warriors", "Aerosmith - Dream On",
    "Gorillaz - On Melancholy Hill", "Ghost - Miasma", "Rush - 2112",
    "Tool - Lateralus"];
  const anon = detectAnonFolders(
    names.map((n) => file(["20201104 trip", "Cy", "Intro 15", `${n}.mp3`])));
  assert.equal(anon.size, 0, "findable by filename: must not be hidden");
});

// ------------------------------------------------- the rule that must not break

test("unresolved tracks still reach the catalogue", () => {
  // No tags, unrecognised folder, undated event: everything unknown.
  const c = distill(crawlOf([file(["mystery", "WhoKnows", "unnamed.mp3"])]), RULES);
  assert.equal(c.tracks.length, 1, "the track must exist");
  const t = c.tracks[0];
  assert.equal(t.personId, null);
  assert.equal(t.provenance.person, "unknown");
  assert.ok(t.title, "a title is always present, even if only the filename");
  assert.ok(c.questions.length > 0, "and a question is raised for a human");
});

test("an unanswerable event still appears, marked undated", () => {
  const c = distill(crawlOf([file(["trippekes", "1 TAWUL ATHEDO", "x.mp3"])]), RULES);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].undated, true);
  assert.equal(c.tracks.length, 1);
});

// ------------------------------------------------------------------ attribution

test("composer tag beats the folder name for attribution", () => {
  // The folder says Timmeh, the tag says Dov. The tag is the cleaner source.
  const files = "ABCDEF".split("").map((a, i) =>
    file(["20200101", "Timmeh", `${i}.mp3`], { composer: "Dov", artist: a, title: `${i}` }));
  const c = distill(crawlOf(files), RULES);
  assert.deepEqual(c.people.map((p) => p.name), ["Dov"]);
  assert.equal(c.people[0].trackCount, files.length);
});

test("a real composer credit is not mistaken for a contributor", () => {
  const files = [
    ..."ABCDEF".split("").map((a, i) =>
      file(["20200101", "Ada", `${i}.mp3`], { composer: "Ada", artist: a, title: `${i}` })),
    // A real credit: the composer is also the artist of that track.
    file(["20200101", "Ada", "z.mp3"],
      { composer: "Nobuo Uematsu", artist: "Nobuo Uematsu", title: "Z" }),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.deepEqual(c.people.map((p) => p.name), ["Ada"]);
  // The one-off credit still lands under the folder's owner, not its own person.
  assert.equal(c.tracks[c.tracks.length - 1].personId, "ada");
});

test("a human answer overrides the inferred role", () => {
  const files = [file(["20200101", "Weird", "a.mp3"], { artist: "A", title: "1" })];
  const before = distill(crawlOf(files), RULES);
  assert.equal(before.tracks[0].personId, null);

  const after = distill(crawlOf(files),
    { ...RULES, segmentRoles: { weird: "person" } });
  assert.equal(after.tracks[0].personId, "weird");
  assert.equal(after.tracks[0].provenance.person, "rule");
  assert.equal(after.questions.find((q) => q.subject === "weird"), undefined);
});

test("aliases fold folder spellings into one person", () => {
  const files = [
    file(["20200101", "Timmeh", "a.mp3"], { artist: "A", title: "1" }),
    file(["20200101", "Dov", "b.mp3"], { composer: "Dov", artist: "B", title: "2" }),
  ];
  const c = distill(crawlOf(files),
    { ...RULES, segmentRoles: { timmeh: "person" }, personAliases: { timmeh: "Dov" } });
  assert.deepEqual(c.people.map((p) => p.name), ["Dov"]);
  assert.equal(c.people[0].trackCount, 2);
});

// ------------------------------------------------------------------------ flags

test("flags describe tracks without removing them", () => {
  const files = [
    file(["20200101", "stray.mp3"], { artist: "A", title: "1" }),
    file(["20200101", "Anon", "1 TAWUL ATHEDO", "x.mp3"]),
    file(["20200101", "clip.mp4"], { artist: "A", title: "2" }, ".mp4"),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.equal(c.tracks.length, 3, "flagged tracks are still catalogued");
  assert.ok(c.tracks[0].flags.includes("stray"));
  assert.ok(c.tracks[1].flags.includes("anon"));
  assert.ok(c.tracks[2].flags.includes("video"));
});

test("duplicates within an event are marked, not dropped", () => {
  const dup = { artist: "Ghost", title: "Miasma" };
  const c = distill(crawlOf([
    file(["20200101", "Ada", "a.mp3"], dup),
    file(["20200101", "Bo", "b.mp3"], dup),
  ]), RULES);
  assert.equal(c.tracks.length, 2);
  assert.equal(c.tracks.filter((t) => t.flags.includes("duplicate")).length, 1);
});

test("the album tag supplies an event date the folder lacks", () => {
  const c = distill(crawlOf([
    file(["rollekes", "x.mp3"], { album: "20190817 Roll", artist: "A", title: "1" }),
  ]), RULES);
  assert.equal(c.events[0].date, "2019-08-17");
  assert.equal(c.events[0].provenance.date, "tag");
});

test("a mismatched folder is not mistaken for an alias", () => {
  // Bo's track sitting in Cal's folder is a real mismatch. Recording "Cal"
  // as another name for Bo would silently merge two people.
  const files = [
    ..."ABCDEF".split("").map((a, i) =>
      file(["20200101", "Cal", `${i}.mp3`], { composer: "Cal", artist: a, title: `${i}` })),
    ..."GHIJKL".split("").map((a, i) =>
      file(["20200101", "Bo", `p${i}.mp3`], { composer: "Bo", artist: a, title: `p${i}` })),
    // The odd one out: in Cal's folder, credited to Bo.
    file(["20200101", "Cal", "odd.mp3"], { composer: "Bo", artist: "Z", title: "odd" }),
  ];
  const c = distill(crawlOf(files), RULES);
  const bo = c.people.find((p) => p.name === "Bo")!;
  assert.deepEqual(bo.aliases, [], "no alias may be inferred from a mismatch");
  assert.equal(bo.trackCount, 7, "the track still counts toward Bo");
});

// ------------------------------------------------------- the real library's shapes

test("a date anywhere in the folder name still dates the event", () => {
  // "Roll - 20221231 anon" is the anonymised half of the 2022-12-31 night.
  assert.equal(parseEventFolder("Roll - 20221231 anon").date, "2022-12-31");
  assert.equal(parseEventFolder("20221231 Roll").date, "2022-12-31");
  assert.equal(parseEventFolder("favs").date, null);
  // A bare number that is not a date must not be read as one.
  assert.equal(parseEventFolder("bloons 12345").date, null);
});

test("the named and anonymised folders of one night become one event", () => {
  const c = distill(crawlOf([
    ..."ABCDEF".split("").map((a, i) =>
      file(["20221231 Roll", "Ada", `${i}.mp3`], { artist: a, title: `${i}` })),
    ..."123456".split("").map((n) =>
      file(["Roll - 20221231 anon", "Ada", `anon ${n}.mp3`])),
  ]), RULES);
  assert.equal(c.events.length, 1, "two folders, one night");
  assert.deepEqual(c.events[0].folders.sort(),
    ["20221231 Roll", "Roll - 20221231 anon"]);
});

test("a folder that is only a number is ordering, not a name", () => {
  assert.deepEqual(parsePhaseLabel("1"), { clean: "1", order: 1, minutes: null });
  assert.deepEqual(parsePhaseLabel("12"), { clean: "12", order: 12, minutes: null });
});

test("minutes in brackets are read as a length", () => {
  assert.equal(parsePhaseLabel("Spares (20min)").minutes, 20);
  assert.equal(parsePhaseLabel("Spares (20min)").clean, "Spares");
  assert.equal(parsePhaseLabel("Peak (45 minutes)").minutes, 45);
});

test("an untagged folder beside tagged ones is detected as anonymised", () => {
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20220515 Roll", "Ada", `${i}.mp3`], { artist: a, title: `${i}` })),
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      file(["20220515 Roll", "Unnamed", "Ada", `0${n} - Peak - Ada.mp3`])),
  ];
  const anon = detectAnonFolders(files);
  assert.ok(anon.has("20220515 roll/unnamed"), "Unnamed is the stripped side");
  assert.ok(!anon.has("20220515 roll/ada"), "the tagged side is not");
});

test("what makes a folder anonymised is meaningless names, not missing tags", () => {
  // Tags absent and filenames that say nothing -- nothing to search on at all.
  const blank = [1, 2, 3, 4, 5, 6, 7, 8].map((n) =>
    file(["20220515 Roll", "Ada", `${n}.mp3`]));
  // The flag lands on the outermost stripped folder, so assert the outcome
  // rather than which rung of the path it was attached to.
  assert.ok(distill(crawlOf(blank), RULES).tracks.every((t) => t.flags.includes("anon")));

  // Tags absent but every filename names a different real artist: findable,
  // so it stays in search. This is the boundary that matters -- getting it
  // wrong hides honest tracks.
  const named = ["Ghost - Miasma", "Rush - 2112", "Tool - Lateralus",
    "Gorillaz - Clint Eastwood", "Aerosmith - Dream On", "Opeth - Ghost Of Perdition"]
    .map((n) => file(["20220515 Roll", "Ada", `${n}.mp3`]));
  assert.equal(detectAnonFolders(named).size, 0);
});

test("anonymised filenames never invent an artist", () => {
  // "01 - Peak - Ada.mp3" splits into artist "Peak" -- a performer that does
  // not exist, which then outranks real results in search.
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20220515 Roll", "Bo", `${i}.mp3`], { artist: a, title: `${i}` })),
    ...[1, 2, 3, 4, 5, 6].map((n) =>
      file(["20220515 Roll", "Unnamed", "Ada", `0${n} - Peak - Ada.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  const fake = c.tracks.filter((t) => t.artist && /^(peak|ada)$/i.test(t.artist));
  assert.equal(fake.length, 0, "no invented artists");
  const anon = c.tracks.filter((t) => t.flags.includes("anon"));
  assert.equal(anon.length, 6);
  assert.ok(anon.every((t) => t.artist === null), "artist stays unknown");
  assert.ok(anon.every((t) => t.title), "but the track is still findable by name");
});

test("a contributor is recognised from folder position without a composer tag", () => {
  // The newer events carry no composer at all; attribution has to survive it.
  const files = [
    ...[1, 2, 3].flatMap((ev) =>
      "ABCDEF".split("").map((a, i) =>
        file([`2023010${ev} Roll`, "Sammy", `Sammy 0${i}.mp3`], { artist: a, title: `${i}` }))),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.deepEqual(c.people.map((p) => p.name), ["Sammy"]);
  assert.equal(c.tracks[0].provenance.person, "folder");
});

test("a phase folder is never mistaken for a contributor", () => {
  // Afterglow recurs across events and sits beside many artists, exactly like
  // a person does -- the phase vocabulary has to win first.
  const files = [1, 2, 3].flatMap((ev) =>
    "ABCDEF".split("").map((a, i) =>
      file([`2023010${ev} Roll`, "Afterglow", `${i}.mp3`], { artist: a, title: `${i}` })));
  const c = distill(crawlOf(files), RULES);
  assert.deepEqual(c.people, []);
  assert.equal(c.phases.length, 3);
  assert.equal(c.phases[0].bucket, "afterglow");
});

test("collections stay out of the timeline but keep their tracks", () => {
  const c = distill(crawlOf([
    file(["20200101 Roll", "Ada", "a.mp3"], { artist: "A", title: "1" }),
    file(["favs", "CoreSongs", "Amon Amarth - Raise Your Horns.mp3"],
      { artist: "Amon Amarth", title: "Raise Your Horns" }),
  ]), { ...RULES, collections: ["favs"] });
  const favs = c.events.find((e) => e.folder === "favs")!;
  assert.equal(favs.kind, "collection");
  assert.equal(favs.undated, false, "a collection is not an undated night");
  assert.equal(c.events[c.events.length - 1].id, favs.id, "sorted after the nights");
  assert.equal(c.tracks.length, 2, "its tracks are still catalogued");
});

test("a file at the library root is not an event of its own", () => {
  const c = distill(crawlOf([
    file(["20200101 Roll", "Ada", "a.mp3"], { artist: "A", title: "1" }),
    file(["DJ SJAMAAN EOWAZ - Neon Memories.flac"], undefined, ".flac"),
  ]), RULES);
  assert.equal(c.events.length, 2);
  const loose = c.events.find((e) => e.id === "loose")!;
  assert.equal(loose.kind, "collection");
  assert.ok(c.tracks.find((t) => t.eventId === "loose")!.flags.includes("stray"));
});

test("a whole top-level folder can be the anonymised side", () => {
  // "Roll - 20221231 anon" sits beside "20221231 Roll" as its stripped twin.
  const files = [1, 2, 3, 4, 5, 6].map((n) =>
    file(["Roll - 20221231 anon", "Cal", `peak - ${n} - zever.flac`], undefined, ".flac"));
  assert.ok(detectAnonFolders(files).has("roll - 20221231 anon"));
  const c = distill(crawlOf(files), RULES);
  assert.ok(c.tracks.every((t) => t.flags.includes("anon")));
  assert.ok(c.tracks.every((t) => t.artist === null), "no artist called Peak");
});

// ----------------------------------------------------------------- song identity

test("a rendition folds into the song it is a rendition of", () => {
  assert.deepEqual(splitVariant("King Nothing (Live)"),
    { base: "King Nothing", variant: "Live" });
  assert.deepEqual(splitVariant("Spoonman (Remix By Steve Aoki)"),
    { base: "Spoonman", variant: "Remix By Steve Aoki" });
  assert.deepEqual(splitVariant("Some Song - Live"),
    { base: "Some Song", variant: "Live" });
});

test("brackets that carry real meaning are not renditions", () => {
  // The two halves of Shine On are different music. Merging them would be a
  // silent, permanent error in every count the app shows.
  for (const t of ["Shine On You Crazy Diamond (Parts I-V)",
                   "Shine On You Crazy Diamond (Parts VI-IX)",
                   "Air Walker (feat Diva Ice)"]) {
    assert.deepEqual(splitVariant(t), { base: t, variant: null });
  }
});

test("one song spelled two ways is one song", () => {
  const c = distill(crawlOf([
    ...played("The Pillows", "Beautiful Morning With You", ["20200101", "20200202"]),
    ...played("the pillows", "beautiful morning with you", ["20200303"]),
    ...played("Metallica", "King Nothing (Live)", ["20200404"]),
    ...played("Metallica", "King Nothing", ["20200505"]),
  ]), RULES);
  const pillows = c.songs.find((x) => x.artist.toLowerCase().includes("pillows"))!;
  assert.equal(pillows.nights.length, 3, "casing must not split a song");
  assert.equal(pillows.title, "Beautiful Morning With You", "commonest spelling wins");
  const king = c.songs.find((x) => x.title === "King Nothing")!;
  assert.equal(king.nights.length, 2, "the live take is the same song");
  assert.deepEqual(king.variants, ["Live"]);
});

test("a bare trailing Live joins its song only when that song exists", () => {
  // "Ghost Love Score Live" is a rendition of "Ghost Love Score". "Date A Live"
  // is just a title -- stripping it blindly would make it "Date A".
  const c = distill(crawlOf([
    ...played("Nightwish", "Ghost Love Score", ["20200101", "20200202"]),
    ...played("Nightwish", "Ghost Love Score Live", ["20200303"]),
    ...played("Sweet ARMS", "Date A Live", ["20200404"]),
  ]), RULES);
  const gls = c.songs.find((x) => x.title === "Ghost Love Score")!;
  assert.equal(gls.nights.length, 3, "the live take is the same song");
  assert.deepEqual(gls.variants, ["Live"]);
  assert.ok(c.songs.some((x) => x.title === "Date A Live"), "a real title is left whole");
});

test("the same song on many nights is recurrence, not duplication", () => {
  const c = distill(crawlOf(played("Nightwish", "Ghost Love Score",
    ["20200101", "20200202", "20200303"])), RULES);
  assert.equal(c.songs[0].nights.length, 3);
  assert.equal(c.stats.recurringSongs, 1);
  assert.equal(c.tracks.filter((t) => t.flags.includes("duplicate")).length, 0,
    "across nights is never a duplicate");
});

test("the same song twice in one night still is", () => {
  const c = distill(crawlOf([
    file(["20200101 Roll", "Ada", "a.mp3"], { artist: "Ghost", title: "Miasma" }),
    file(["20200101 Roll", "Bo", "b.mp3"], { artist: "Ghost", title: "Miasma" }),
  ]), RULES);
  assert.equal(c.tracks.filter((t) => t.flags.includes("duplicate")).length, 1);
});

test("a song remembers when it entered and last appeared", () => {
  const c = distill(crawlOf(played("Daft Punk", "Contact",
    ["20160102", "20200101", "20240504"])), RULES);
  const s = c.songs[0];
  assert.equal(s.firstPlayed, "2016-01-02");
  assert.equal(s.lastPlayed, "2024-05-04");
  assert.deepEqual(s.nights, ["2016-01-02", "2020-01-01", "2024-05-04"]);
});

test("a night counts the songs making their debut", () => {
  const c = distill(crawlOf([
    ...played("A", "one", ["20200101", "20200202"]),
    ...played("B", "two", ["20200202"]),
  ]), RULES);
  const first = c.events.find((e) => e.id === "2020-01-01")!;
  const second = c.events.find((e) => e.id === "2020-02-02")!;
  assert.equal(first.debuts, 1);
  assert.equal(second.debuts, 1, "the returning song is not a debut");
});

test("joke folder names still say what kind of night it was", () => {
  assert.deepEqual(eventTypes("Rollenbollen"), ["roll"]);
  assert.deepEqual(eventTypes("Flipperen"), ["candyflip"]);
  assert.deepEqual(eventTypes("trippekes"), ["trip"]);
  assert.deepEqual(eventTypes("Roll&CandyFlip").sort(), ["candyflip", "roll"]);
});

test("roman numerals order a phase like digits do", () => {
  assert.equal(parsePhaseLabel("II. GODverDOMME").order, 2);
  assert.equal(parsePhaseLabel("iv - afterglow").order, 4);
  assert.equal(parsePhaseLabel("I").order, 1);
  // A word that merely starts with a numeral letter is not a numeral.
  assert.equal(parsePhaseLabel("Intro").order, null);
});

test("Misc falls back to the folder it sits in", () => {
  const files = "ABCDEF".split("").map((a, i) =>
    file(["20200101 Roll", "Ada", `${i}.mp3`],
      { composer: i === 0 ? "Misc" : "Ada", artist: a, title: `${i}` }));
  const c = distill(crawlOf(files), RULES);
  assert.ok(c.tracks.every((t) => t.personId === "ada"));
});

test("a collection appearance is not a night", () => {
  // Otherwise "Metallica on 25 nights" lights 23 bars and the count is a lie.
  const c = distill(crawlOf([
    ...played("Metallica", "King Nothing", ["20200101", "20200202"]),
    file(["favs", "CoreSongs", "Metallica - King Nothing.mp3"],
      { artist: "Metallica", title: "King Nothing" }),
  ]), { ...RULES, collections: ["favs"] });
  const song = c.songs.find((x) => x.title === "King Nothing")!;
  assert.equal(song.nights.length, 2, "the shelf is not a night");
  assert.equal(song.plays, 3, "but it is still a copy in the library");
});

test("an owner's own numbering is not an artist", () => {
  // "Cal 07 - MAN VAN DE OORLOG.mp3" splits on the dash into an artist called
  // "Cal 07". 88 tracks reached search that way. The folder is the anonymised
  // side of a playlist, and its names are the owner plus a running number.
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20260404 Trip", "Bo", `${i}.mp3`], { artist: a, title: `real ${i}` })),
    ...Array.from({ length: 8 }, (_, i) =>
      file(["20260404 Trip", "Cal", `Cal 0${i + 1} - JOKE TITLE ${i}.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  const cal = c.tracks.filter((t) => t.path[1] === "Cal");
  assert.ok(cal.every((t) => t.flags.includes("anon")), "the stripped side is flagged");
  assert.ok(cal.every((t) => t.artist === null), "and invents no artist");
  assert.ok(!c.artists.some((a) => /^cal \d+$/i.test(a.name)));
});

test("a file labelled with its own folder's name names no artist", () => {
  // "Ada/Unnamed/01 - Ada - MWK.mp3": the owner labelling their own file.
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20231028 Roll", "Bo", `${i}.mp3`], { artist: a, title: `real ${i}` })),
    ...["MWK", "PSB", "BILLX", "UTSU-P", "TAO-H", "AETHER-REALM"].map((n, i) =>
      file(["20231028 Roll", "Ada", "Unnamed", `0${i + 1} - Ada - ${n}.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  const ada = c.tracks.filter((t) => t.path[1] === "Ada");
  assert.ok(ada.every((t) => t.flags.includes("anon")));
  assert.ok(ada.every((t) => t.artist === null), "no artist called Ada");
});

test("a real artist whose name ends in a number survives", () => {
  // Stripping trailing digits blindly would turn this into "Clair Obscur".
  const names = ["Lumiere", "Alicia", "Gestral", "Monoco", "Verso", "Maelle"];
  const files = names.map((n) =>
    file(["20260404 Trip", "Cal", `Clair Obscur Expedition 33 - ${n}.mp3`]));
  const c = distill(crawlOf(files), RULES);
  assert.ok(c.tracks.every((t) => t.artist === "Clair Obscur Expedition 33"));
  assert.ok(c.tracks.every((t) => !t.flags.includes("anon")));
});

test("a loose 'cal 01 - ...' file at the root gets no invented artist", () => {
  const files = [
    ..."ABCDEF".split("").map((a, i) =>
      file(["20220515 Roll", "Cal", `${i}.mp3`], { artist: a, title: `s${i}`, composer: "Cal" })),
    file(["20220515 Roll", "cal 01 - HOSEPIPE_BOTTOM_HAHA.m4a"], undefined, ".m4a"),
  ];
  const c = distill(crawlOf(files), RULES);
  const loose = c.tracks.find((t) => t.path.length === 2)!;
  assert.equal(loose.artist, null);
});

test("a placed folder is re-homed under its night and person", () => {
  const out = applyPlacements(
    [file(["TRIPS - NAMED", "1 THE MONOLITH", "Heilung - Nesso.flac"])],
    [{ from: "TRIPS - NAMED", event: "20260404 Trip", person: "Cal" }]);
  assert.deepEqual(out[0].p, ["20260404 Trip", "Cal", "1 THE MONOLITH", "Heilung - Nesso.flac"]);
});

test("placement is case-insensitive and can match a nested folder", () => {
  const out = applyPlacements(
    [file(["SJAMAANJOS", "NAMED", "I STOP", "a.mp3"]), file(["SJAMAANJOS", "ANON", "I STOP", "b.mp3"])],
    [{ from: "sjamaanjos/named", event: "20251108 Roll", person: "Cal" },
     { from: "sjamaanjos/anon", ignore: true }]);
  assert.equal(out.length, 1, "the anon twin is dropped, not double counted");
  assert.deepEqual(out[0].p, ["20251108 Roll", "Cal", "I STOP", "a.mp3"]);
});

test("a file no placement covers passes through untouched", () => {
  const f = file(["20200101 Roll", "Ada", "a.mp3"]);
  assert.deepEqual(applyPlacements([f], [{ from: "TRIPS - NAMED", event: "x" }])[0], f);
});

test("filing a playlist's named twin beside it does not unmask the anon files", () => {
  // The anon side is only recognisable as a folder while it stands alone. Once
  // the tagged twin sits in the same folder it is half-tagged, so each file has
  // to be judged on its own name.
  const night = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20260404 Trip", "Bo", `${i}.mp3`], { artist: a, title: `s${i}` })),
    ...Array.from({ length: 6 }, (_, i) =>
      file(["20260404 Trip", "Cal", `Cal 0${i + 1} - JOKE TITLE ${i}.mp3`])),
  ];
  const twin = Array.from({ length: 6 }, (_, i) =>
    file(["TRIPS - NAMED", `Real Artist ${i} - Real Song ${i}.flac`],
      { artist: `Real Artist ${i}`, title: `Real Song ${i}` }, ".flac"));
  const c = distillOne(
    [{ id: "lib", crawl: crawlOf(night) }, { id: "share", crawl: crawlOf(twin) }],
    { ...RULES, placements: [{ from: "TRIPS - NAMED", event: "20260404 Trip", person: "Cal" }] });
  const cal = c.tracks.filter((t) => t.personId === "cal");
  assert.equal(cal.length, 12);
  assert.equal(cal.filter((t) => t.flags.includes("anon")).length, 6, "the stripped six stay anon");
  assert.equal(cal.filter((t) => !t.flags.includes("anon")).length, 6, "the named six stay findable");
  assert.ok(cal.filter((t) => t.flags.includes("anon")).every((t) => t.artist === null));
});

test("an untagged song in a placed named playlist is not hidden as anon", () => {
  const night = crawlOf("ABCDEFGH".split("").map((a, i) =>
    file(["20260501 Roll", "Ada", `${i}.mp3`], { artist: a, title: `s${i}` })));
  const share = crawlOf([file(["ROLLS - NAMED", "I", "Pamplemouse Polka.wav"], undefined, ".wav")]);
  const c = distillOne([{ id: "lib", crawl: night }, { id: "share", crawl: share }],
    { ...RULES, placements: [{ from: "ROLLS - NAMED", event: "20260501 Roll", person: "Cal" }] });
  const polka = c.tracks.find((x) => x.source === "share")!;
  assert.ok(!polka.flags.includes("anon"), "the owner vouched for this folder");
  assert.equal(polka.title, "Pamplemouse Polka");
});

test("a title in another script is a real title, not an empty one", () => {
  // fold() once stripped everything outside a-z0-9, so a Japanese title became
  // "" -- read as "nothing but a number" (flagged anon) and given no song
  // identity (missing from every count).
  const night = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20260501 Roll", "Bo", `${i}.mp3`], { artist: a, title: `s${i}` })),
    file(["20260501 Roll", "Cy", "初音ミク 秘密警察 オリジナル.mp3"]),
    file(["20260501 Roll", "Cy", "Real Artist - Real Song.mp3"]),
    file(["20260501 Roll", "Cy", "Another Artist - Another Song.mp3"]),
    file(["20260501 Roll", "Cy", "Third Artist - Third Song.mp3"]),
  ];
  const c = distill(crawlOf(night), RULES);
  const miku = c.tracks.find((x) => x.path[2].startsWith("初音"))!;
  assert.ok(!miku.flags.includes("anon"), "a Japanese title is not a placeholder");
  const jp = distill(crawlOf(played("菅野祐悟", "Tougenkyou", ["20200101", "20200202"])), RULES);
  assert.equal(jp.songs.length, 1, "a Japanese artist still has a song identity");
  assert.equal(jp.songs[0].nights.length, 2);
});

test("a placement outranks a leftover composer tag", () => {
  // A song in Cal's playlist can still carry the tag of the night Ada played
  // it. The owner has said whose playlist it is; the tag is just stale.
  const night = crawlOf("ABCDEFGH".split("").map((a, i) =>
    file(["20260501 Roll", "Ada", `${i}.mp3`], { artist: a, title: `s${i}`, composer: "Ada" })));
  const share = crawlOf([file(["ROLLS - NAMED", "II", "Serial TV Drama - Alien.mp3"],
    { artist: "Serial TV Drama", title: "Alien", composer: "Ada" })]);
  const c = distillOne([{ id: "lib", crawl: night }, { id: "share", crawl: share }],
    { ...RULES, placements: [{ from: "ROLLS - NAMED", event: "20260501 Roll", person: "Cal" }] });
  const t = c.tracks.find((x) => x.source === "share")!;
  assert.equal(t.personId, "cal");
  assert.equal(t.provenance.person, "rule");
});

test("a placed playlist lands on its night with roman-numeral phases in order", () => {
  const night = crawlOf([
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20260501 Roll", "Ada", `${i}.mp3`], { artist: a, title: `s${i}`, composer: "Ada" })),
  ]);
  const share = crawlOf([
    file(["ROLLS - NAMED", "0 - intro", "GREEN LUNG - Black Harvest.flac"],
      { artist: "GREEN LUNG", title: "Black Harvest" }, ".flac"),
    file(["ROLLS - NAMED", "I Ameebee provides", "Helicon - Arise.m4a"],
      { artist: "Helicon", title: "Arise" }, ".m4a"),
    file(["ROLLS - NAMED", "III AMEEEBEEEEEeeeee", "Hedningarna - Tuuli.m4a"],
      { artist: "Hedningarna", title: "Tuuli" }, ".m4a"),
    file(["ROLLS - ANON", "I Ameebee provides", "noise.mp3"]),
  ]);
  const c = distillOne([{ id: "lib", crawl: night }, { id: "share", crawl: share }],
    { ...RULES, placements: [
      { from: "ROLLS - NAMED", event: "20260501 Roll", person: "Cal" },
      { from: "ROLLS - ANON", ignore: true }] });
  assert.equal(c.events.length, 1, "joins the existing night, not a new event");
  const cal = c.tracks.filter((t) => t.personId === "cal");
  assert.equal(cal.length, 3);
  assert.ok(cal.every((t) => t.source === "share"));
  const phases = c.phases.filter((p) => p.personId === "cal")
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  assert.deepEqual(phases.map((p) => p.order), [0, 1, 3]);
  assert.equal(phases[1].clean, "Ameebee provides");
});

// ------------------------------------------------------- lists decide anonymity

test("untagged songs with no artist in the name are not anonymised", () => {
  // Sammy's May 2026 list: untagged, and half the names have no dash at all
  // ("CURTSY.mp3", "SOMEWHERE ELSE.mp3"). Absence of an artist is not evidence
  // of anything; these were being hidden from search.
  const names = ["00 Intro 1  - All India Radio - Monsters (Official Video)",
    "00 Intro 2 - There Came an Echo Theme", "01 Electric Callboy - Everytime We Touch",
    "02 Pendulum  Save The Cat", "03 Mason vs Princess Superstar - Perfect",
    "13 CURTSY", "14 Radiohead - Burn The Witch", "15 SOMEWHERE ELSE",
    "16 Queen of The Stars", "17 Poets of the Fall - Black Waters"];
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20260501 Roll", "Bo", `${i}.mp3`], { artist: a, title: `s${i}` })),
    ...names.map((n) => file(["20260501 Roll", "Sammy", `${n}.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  const sammy = c.tracks.filter((t) => t.path[1] === "Sammy");
  assert.equal(sammy.length, 10);
  assert.equal(sammy.filter((t) => t.flags.includes("anon")).length, 0);
});

test("named and unnamed lists side by side: only the placeholder one is anon", () => {
  // Ada/Named and Ada/Unnamed mirror each other by sequence number, but only
  // one of them names anything. The verdict belongs to the list, not the person.
  const named = ["Sun", "Why We Build the Wall", "Rocky Road to Dublin", "Yattah", "Ort", "Golden"]
    .map((t, i) => file(["20260501 Roll", "Ada", "Named", `0${i} - ${BANDS[i]} - ${t}.mp3`]));
  const unnamed = [0, 1, 2, 3, 4, 5].map((i) =>
    file(["20260501 Roll", "Ada", "Unnamed", `0${i} - Ada.mp3`]));
  const c = distill(crawlOf([...named, ...unnamed]), RULES);
  const by = (list: string) => c.tracks.filter((t) => t.path[2] === list);
  assert.ok(by("Named").every((t) => !t.flags.includes("anon")));
  assert.ok(by("Unnamed").every((t) => t.flags.includes("anon")));
  assert.equal(by("Named")[0].artist, "Heilung", "the sequence number is not the artist");
  assert.equal(by("Named")[0].title, "Sun");
});

test("a whole stripped subtree is marked at once, a mixed folder is not", () => {
  const files = [
    ...[1, 2, 3, 4].map((i) => file(["20260501 Roll", "Ada", "Named", `0${i} - ${BANDS[i]} - Song ${BANDS[i + 4]}.mp3`])),
    ...[1, 2, 3, 4].map((i) => file(["20260501 Roll", "Ada", "Unnamed", `0${i} - Ada.mp3`])),
  ];
  const a = analyseAnon(files, new Set());
  assert.ok(a.whole.has("20260501 roll/ada/unnamed"));
  assert.ok(!a.whole.has("20260501 roll/ada"), "Ada also holds a named list");
  assert.ok(!a.whole.has("20260501 roll/ada/named"));
});

test("owner + phase word + number is a placeholder, hyphenated or not", () => {
  // "Ada-LSD 01.mp3", "Cal lsd 02.mp3": the label's own hyphen is not a
  // separator, and every word of it is an owner, a phase word or a number.
  const names = ["Ada-LSD 01", "Ada-LSD 02", "Cal-LSD 01", "Cal-LSD 02", "Ada lsd 03"];
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20240504 Roll", "Ada", `${i}.mp3`], { artist: a, title: `s${i}`, composer: "Ada" })),
    ...names.map((n) => file(["20240504 Roll", "_roll", "_LSD", `${n}.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  const lsd = c.tracks.filter((t) => t.path[1] === "_roll");
  assert.equal(lsd.length, 5);
  assert.ok(lsd.every((t) => t.flags.includes("anon")));
});

test("a name repeated with a changing number is numbering, whoever it names", () => {
  // "Jos 01", "Jos 02"... -- nobody in the library is called Jos, but the
  // number counts up, which is what numbering does.
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20230722 Trip", "Bo", `${i}.mp3`], { artist: a, title: `s${i}` })),
    ...[1, 2, 3, 4, 5].map((i) => file(["20230722 Trip", "Cal", `Jos 0${i} - joke ${i}.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.ok(c.tracks.filter((t) => t.path[1] === "Cal").every((t) => t.flags.includes("anon")));
});

test("a phase named in the filename becomes the track's phase", () => {
  const files = [
    file(["20260501 Roll", "Sammy", "00 Intro 1  - All India Radio - Monsters.mp3"]),
    file(["20260501 Roll", "Sammy", "00 Intro 2 - There Came an Echo Theme.mp3"]),
    ...[1, 2, 3, 4, 5, 6, 7].map((i) =>
      file(["20260501 Roll", "Sammy", `0${i} ${BANDS[i]} - Song of ${BANDS[i + 1]}.mp3`])),
  ];
  const c = distill(crawlOf(files), RULES);
  const intro = c.tracks.filter((t) => t.phaseId);
  assert.equal(intro.length, 2);
  assert.equal(c.phases[0].clean, "Intro");
  assert.equal(c.phases[0].trackCount, 2);
  assert.equal(intro[0].artist, "All India Radio", "the phase label is not the artist");
  assert.equal(intro[1].title, "There Came an Echo Theme");
});

test("a leading number is only a sequence number in a numbered list", () => {
  // "99 Luftballons" is a title; "12 Radiohead - Burn The Witch" is track 12.
  const lone = distill(crawlOf([file(["20200101 Roll", "Ada", "99 Luftballons.mp3"])]), RULES);
  assert.equal(lone.tracks[0].title, "99 Luftballons");
});

// ------------------------------------------------------------- phase order

/** A contributor whose list sits in the given phase folders, 2 tracks each. */
const phased = (night: string, who: string, folders: string[]) =>
  folders.flatMap((f, fi) => [0, 1].map((i) =>
    file([night, who, f, `${BANDS[(fi * 2 + i) % BANDS.length]} - Song ${fi}${i}.mp3`],
      { artist: BANDS[(fi * 2 + i) % BANDS.length], title: `Song ${fi}${i}`, composer: who })));

const orderOf = (folders: string[], who = "Ada") => {
  const c = distill(crawlOf(phased("20240101 Roll", who, folders)), RULES);
  return c.phases.filter((p) => p.personId === who.toLowerCase())
    .sort((a, b) => a.position - b.position).map((p) => p.clean);
};

test("numbered phases are ordered by their number, whatever they are called", () => {
  assert.deepEqual(orderOf(["3 AND RED", "1 THE MONOLITH", "2 STANDS WICKED"]),
    ["THE MONOLITH", "STANDS WICKED", "AND RED"]);
});

test("roman numerals order phases like digits do", () => {
  assert.deepEqual(orderOf(["III AMEEEBEEE", "I Ameebee provides", "II Ameebee abides"]),
    ["Ameebee provides", "Ameebee abides", "AMEEEBEEE"]);
});

test("intro, peak, outro and afterglow run in the order of a night", () => {
  assert.deepEqual(orderOf(["Afterglow", "Outro", "Peak", "Intro"]),
    ["Intro", "Peak", "Outro", "Afterglow"]);
});

test("a substance word is the body of the night, not something after it", () => {
  // Ranking "Roll" and "Trip" last put them behind Afterglow and Spares.
  assert.deepEqual(orderOf(["Afterglow", "Roll"]), ["Roll", "Afterglow"]);
  assert.deepEqual(orderOf(["Spares (20min)", "Post", "Trip"]), ["Trip", "Post", "Spares"]);
});

test("post comes after the peak and before the afterglow", () => {
  assert.deepEqual(orderOf(["Afterglow", "Post", "Peak"]), ["Peak", "Post", "Afterglow"]);
});

test("two phases the names cannot tell apart are marked as crawl order", () => {
  const c = distill(crawlOf(phased("20240101 Roll", "Ada", ["Molly", "Lucy"])), RULES);
  const ps = c.phases.filter((p) => p.personId === "ada");
  assert.ok(ps.every((p) => p.basis === "crawl"), "nothing says Lucy comes before Molly");
  const ordered = distill(crawlOf(phased("20240101 Roll", "Ada", ["1 a", "2 b"])), RULES);
  assert.ok(ordered.phases.every((p) => p.basis === "number"));
});

test("loose tracks beside an Afterglow folder are the body of the list", () => {
  const files = [
    ...BANDS.slice(0, 6).map((b, i) =>
      file(["20180203 Roll", "Ada", `${b} - Song ${i}.mp3`], { artist: b, title: `Song ${i}`, composer: "Ada" })),
    ...phased("20180203 Roll", "Ada", ["Afterglow"]),
  ];
  const c = distill(crawlOf(files), RULES);
  const ps = c.phases.filter((p) => p.personId === "ada").sort((a, b) => a.position - b.position);
  assert.deepEqual(ps.map((p) => p.clean), ["Main", "Afterglow"]);
  assert.equal(ps[0].inferred, true);
  assert.equal(ps[0].trackCount, 6);
  const loose = c.tracks.filter((t) => t.phaseId === ps[0].id);
  assert.equal(loose.length, 6);
  assert.ok(loose.every((t) => t.provenance.phase === "inferred"));
});

test("loose tracks are not called a body when the other phases are numbered", () => {
  // Only after an Afterglow/Post/Outro is "everything else" the main part.
  const files = [
    ...BANDS.slice(0, 4).map((b, i) =>
      file(["20240101 Roll", "Ada", `${b} - Song ${i}.mp3`], { artist: b, title: `Song ${i}`, composer: "Ada" })),
    ...phased("20240101 Roll", "Ada", ["1 THE MONOLITH", "2 STANDS WICKED"]),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.ok(!c.phases.some((p) => p.inferred));
});

test("a titled list under a contributor is not an album", () => {
  // "sjamaanjos - snoepsalto" is the name of Cal's playlist; it looks like
  // "Artist - Album" and was flagged as one. A real album sits before anyone.
  const files = [
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20241109 Roll", "Bo", `${i}.mp3`], { artist: a, title: `s${i}`, composer: "Bo" })),
    ...BANDS.slice(0, 4).map((b, i) =>
      file(["20241109 Roll", "Cal", "sjamaanjos - snoepsalto", "1", `${b} - Song ${i}.mp3`], { artist: b, title: `Song ${i}`, composer: "Cal" })),
    file(["Albums", "Pink Floyd - Wish You Were Here", "Pink Floyd - Have A Cigar.mp3"],
      { artist: "Pink Floyd", title: "Have A Cigar" }),
  ];
  const c = distill(crawlOf(files), { ...RULES, collections: ["albums"] });
  assert.equal(c.tracks.filter((t) => t.path[1] === "Cal" && t.flags.includes("album")).length, 0);
  assert.equal(c.tracks.filter((t) => t.path[0] === "Albums" && t.flags.includes("album")).length, 1);
});

test("a replacing placement supersedes a flattened copy and keeps the phases", () => {
  // His library holds the list as loose files; the original has the phases.
  const flat = crawlOf([
    ..."ABCDEFGH".split("").map((a, i) =>
      file(["20251108 Roll", "Bo", `${i}.mp3`], { artist: a, title: `s${i}` })),
    ...BANDS.slice(0, 4).map((b, i) =>
      file(["20251108 Roll", "Cal", `${b} - Song ${i}.mp3`], { artist: b, title: `Song ${i}` })),
  ]);
  const original = crawlOf(BANDS.slice(0, 4).map((b, i) =>
    file(["SJAMAANJOS", "NAMED", i < 2 ? "I STOP DROP" : "II THE BIG COMEUP", `${b} - Song ${i}.mp3`],
      { artist: b, title: `Song ${i}` })));
  const c = distillOne([{ id: "lib", crawl: flat }, { id: "nas", crawl: original }],
    { ...RULES, placements: [
      { from: "SJAMAANJOS/NAMED", event: "20251108 Roll", person: "Cal", replace: true }] });
  const cal = c.tracks.filter((t) => t.personId === "cal");
  assert.equal(cal.length, 4, "not 8: the flat copy is superseded, not doubled");
  assert.ok(cal.every((t) => t.source === "nas"));
  assert.ok(cal.every((t) => t.phaseId));
  assert.equal(c.tracks.filter((t) => t.personId === "bo").length, 8, "Bo untouched");
});

// -------------------------------------------------------------------- twins

/** A file with a chosen running time -- the thing twins are paired on. */
const fileD = (p: string[], dur: number, e?: Record<string, string>, ext = ".mp3") =>
  ({ ...file(p, e, ext), a: { dur } });

const mkTrack = (id: string, dur: number | null) =>
  ({ id, durationSec: dur, flags: [], path: [id], provenance: {} }) as never;

test("twins are paired by running time, not by name", () => {
  // Re-encoding moves a length by a fraction of a second; different songs do not
  // land within two seconds of each other.
  const named = [mkTrack("n1", 200), mkTrack("n2", 301), mkTrack("n3", 415)];
  const anon = [mkTrack("a1", 415.6), mkTrack("a2", 199.4), mkTrack("a3", 300.2)];
  const pairs = pairByDuration(named, anon).map(([n, a]) => `${(n as { id: string }).id}-${(a as { id: string }).id}`);
  assert.deepEqual(pairs.sort(), ["n1-a2", "n2-a3", "n3-a1"]);
});

test("a track with no counterpart is left unpaired, not forced", () => {
  const named = [mkTrack("n1", 200), mkTrack("n2", 500)];
  const anon = [mkTrack("a1", 200), mkTrack("a2", 321)];
  const pairs = pairByDuration(named, anon);
  assert.equal(pairs.length, 1, "321 s matches nothing, so it stays alone");
});

test("two candidates the same length are told apart by position", () => {
  const named = [mkTrack("n1", 240), mkTrack("n2", 240)];
  const anon = [mkTrack("a1", 240), mkTrack("a2", 240)];
  const pairs = pairByDuration(named, anon).map(([n, a]) => `${(n as { id: string }).id}-${(a as { id: string }).id}`);
  assert.deepEqual(pairs.sort(), ["n1-a1", "n2-a2"]);
});

test("a playlist is counted once, not once per copy", () => {
  // The anonymised list and its named twin are one playlist. Counting both put
  // 2024-05-04 at 16 hours when the night ran about 10.
  const lens = [200, 310, 421, 187];
  const files = [
    ...lens.map((d, i) => fileD(["20240504 Roll", "Ada", "Named", `${BANDS[i]} - Song ${i}.mp3`], d,
      { artist: BANDS[i], title: `Song ${i}`, composer: "Ada" })),
    ...lens.map((d, i) => fileD(["20240504 Roll", "Ada", "Unnamed", `Ada 0${i + 1}.mp3`], d + 0.4)),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.equal(c.events[0].trackCount, 8, "eight files");
  assert.equal(c.events[0].playedCount, 4, "four tracks played");
  assert.equal(Math.round(c.events[0].durationSec), lens.reduce((a, b) => a + b, 0));
  assert.equal(c.tracks.filter((t) => t.twinId).length, 8, "every one found its twin");
});

test("an anonymised list with no named twin is still played", () => {
  // Cy, Dee and Dov on 2024-05-04 exist only as anonymised lists. They
  // were played; dropping them would shorten the night by hours.
  const lens = [200, 310, 421, 187, 256, 302];
  const files = [
    ...lens.map((d, i) => fileD(["20240504 Roll", "Bo", `${i}.mp3`], d,
      { artist: BANDS[i % 9], title: `S${i}`, composer: "Bo" })),
    ...lens.map((d, i) => fileD(["20240504 Roll", "Cy", "Unnamed", `Cy 0${i + 1}.mp3`], d + 7)),
  ];
  const c = distill(crawlOf(files), RULES);
  const total = lens.reduce((a, b) => a + b, 0);
  assert.equal(Math.round(c.events[0].durationSec), 2 * total + 6 * 7, "both contributors count");
});

test("surplus anonymised copies beside a complete named list are not counted", () => {
  // 2022-12-31 Ada: 17 named and 34 anonymised. The named list is there, so the
  // extra anon copies are duplicates, not more music.
  const lens = [200, 310, 421, 187, 256, 302];
  const files = [
    ...lens.map((d, i) => fileD(["20221231 Roll", "Ada", "Named", `${BANDS[i % 9]} - S${i}.mp3`], d,
      { artist: BANDS[i % 9], title: `S${i}`, composer: "Ada" })),
    ...lens.map((d, i) => fileD(["20221231 Roll", "Ada", "Unnamed", `Ada 0${i + 1}.mp3`], d)),
    ...lens.map((d, i) => fileD(["Roll - 20221231 anon", "Ada", `Ada 0${i + 1}.mp3`], d)),
  ];
  const c = distill(crawlOf(files), RULES);
  assert.equal(c.events.length, 1);
  assert.equal(c.events[0].playedCount, 6, "one playlist, six tracks");
});

test("the anonymised list's numbering gives the named twin its set order", () => {
  // The named files are alphabetical and say nothing of order; the anon list is
  // what was played, and it counts.
  const order = [3, 1, 4, 2];                       // the order they were played
  const lens = [240, 301, 187, 422];
  const names = ["Gorillaz - Clint Eastwood", "Heilung - Nesso", "Muse - Hysteria", "Rush - 2112"];
  const files = [
    ...names.map((n, i) => fileD(["20260501 Roll", "Cy", "Named", `${n}.mp3`], lens[i],
      { artist: n.split(" - ")[0], title: n.split(" - ")[1], composer: "Cy" })),
    ...order.map((o, i) => fileD(["20260501 Roll", "Cy", "Unnamed", `Cy 0${o}.mp3`], lens[i])),
  ];
  const c = distill(crawlOf(files), RULES);
  const named = c.tracks.filter((t) => t.path[2] === "Named")
    .sort((a, b) => a.playOrder! - b.playOrder!);
  assert.deepEqual(named.map((t) => t.title), ["Heilung - Nesso", "Rush - 2112", "Gorillaz - Clint Eastwood", "Muse - Hysteria"].map((x) => x.split(" - ")[1]));
});

test("a phase recorded only on the anonymised copy is carried to its twin", () => {
  // Ada's May 2026 intro exists nowhere but "00A - Ada - Pre.mp3".
  const lens = [200, 310, 421, 187, 256];
  const names = ["Sinners - Rocky Road", "Heilung - Nesso", "Opeth - Ghost", "Tool - Lateralus", "Muse - Hysteria"];
  const files = [
    ...names.map((n, i) => fileD(["20260501 Roll", "Ada", "Named", `0${i} - ${n}.mp3`], lens[i],
      { artist: n.split(" - ")[0], title: n.split(" - ")[1], composer: "Ada" })),
    fileD(["20260501 Roll", "Ada", "Unnamed", "00 - Ada - Pre.mp3"], lens[0]),
    fileD(["20260501 Roll", "Ada", "Unnamed", "01 - Ada - Pre.mp3"], lens[1]),
    ...[2, 3, 4].map((i) => fileD(["20260501 Roll", "Ada", "Unnamed", `0${i} - Ada.mp3`], lens[i])),
  ];
  const c = distill(crawlOf(files), RULES);
  const named = c.tracks.filter((t) => t.path[2] === "Named");
  const pre = named.filter((t) => t.phaseId && c.phases.find((p) => p.id === t.phaseId)!.clean === "Pre");
  assert.equal(pre.length, 2, "the two intro tracks");
  assert.ok(pre.every((t) => t.provenance.phase === "twin"));
});

test("loose tracks after an Intro are the body, between it and what follows", () => {
  const files = [
    ...phased("20260501 Roll", "Sammy", ["Intro"]),
    ...BANDS.slice(0, 5).map((b, i) =>
      file(["20260501 Roll", "Sammy", `${b} - Tune ${i}.mp3`], { artist: b, title: `Tune ${i}`, composer: "Sammy" })),
  ];
  const c = distill(crawlOf(files), RULES);
  const ps = c.phases.filter((p) => p.personId === "sammy").sort((a, b) => a.position - b.position);
  assert.deepEqual(ps.map((p) => p.clean), ["Intro", "Main"]);
});

test("a number in a filename counts only when the whole list is numbered", () => {
  assert.equal(nameNumber("00A - Ada - Pre.mp3"), 0.1);
  assert.equal(nameNumber("07. Weisses Fleisch.mp3"), 7);
  assert.equal(nameNumber("Ada 12.mp3"), 12);
  assert.equal(nameNumber("Level 42 - Something.mp3"), 42, "it is a number; the list decides if it is a position");
});

// -------------------------------------------------------------------- merging

test("merging two crawls keeps what only one of them has", () => {
  const his = crawlOf([
    file(["20200101 Roll", "Ada", "a.mp3"], { artist: "A", title: "1" }),
    file(["20200101 Roll", "Ada", "b.mp3"], { artist: "B", title: "2" }),
  ]);
  const mine = crawlOf([
    file(["20200101 Roll", "Ada", "a.mp3"], { artist: "A", title: "1" }),
    file(["rollekes", "gone.mp3"], { artist: "C", title: "3" }),
  ]);
  const c = distillOne([{ id: "his", crawl: his }, { id: "mine", crawl: mine }], RULES);
  assert.equal(c.tracks.length, 3, "union, not whichever ran last");
  assert.deepEqual(c.sources.map((s) => s.contributed), [2, 1]);
  // His scan has one file mine lacks; mine has one his lacks; one is shared.
  assert.deepEqual(c.sources.map((s) => s.unique), [1, 1]);
});

test("a re-encoded track is the same track, not a second one", () => {
  // One night's Afterglow is .flac in the older copy and .mp3 in the newer.
  const old = crawlOf([file(["20190817", "Ada", "Afterglow", "Enigma - Modern Crusaders.flac"],
    { artist: "Enigma", title: "Modern Crusaders" }, ".flac")]);
  const neu = crawlOf([file(["20190817 Roll", "Ada", "Afterglow", "Enigma - Modern Crusaders.mp3"],
    { artist: "Enigma", title: "Modern Crusaders" })]);
  const c = distillOne([{ id: "old", crawl: old }, { id: "new", crawl: neu }], RULES);
  assert.equal(c.tracks.length, 1);
});

test("a richer copy of the same file wins the merge", () => {
  // A later scan that lost its tags must not erase an earlier one that has them.
  const bare = crawlOf([file(["20200101 Roll", "Ada", "a.mp3"])]);
  const rich = crawlOf([
    file(["20200101 Roll", "Ada", "a.mp3"], { artist: "Ghost", title: "Miasma" })]);
  for (const order of [[bare, rich], [rich, bare]]) {
    const c = distillOne(
      order.map((crawl, i) => ({ id: `s${i}`, crawl })), RULES);
    assert.equal(c.tracks.length, 1);
    assert.equal(c.tracks[0].artist, "Ghost");
  }
});

// ---------------------------------------------------------------------- audio

const heard = (ext: string, br?: number) => audioOf({ p: ["x"], sz: 1, mt: 0, ext, a: { dur: 100, br, sr: 44100, bits: 16 } });

test("a heavy .m4a is Apple Lossless and a light one is AAC", () => {
  // Both carry the same codec name in the crawl; only the bitrate tells them apart.
  assert.equal(heard(".m4a", 900_000)!.lossless, true);
  assert.equal(heard(".m4a", 256_000)!.lossless, false);
});

test("a flac is lossless whatever its bitrate", () => {
  assert.equal(heard(".flac", 380_000)!.lossless, true);
  assert.equal(heard(".mp3", 320_000)!.lossless, false);
});

test("a file the crawl could not give a bitrate for is not guessed", () => {
  assert.equal(heard(".mp3")!.kbps, null);
  assert.equal(audioOf({ p: ["x"], sz: 1, mt: 0, ext: ".mp3" }), undefined);
});

// ------------------------------------------------------------------- spotify

const sp = (name: string, artists: string[], sec: number, genres: string[] = []) =>
  ({ uri: `spotify:track:${name}`, name, artists, album: "A", ms: Math.round(sec * 1000), year: 2020, genres });
const spotifyOf = (night: string, lists: Array<[string, ReturnType<typeof sp>[]]>) => ({
  schema: "mdc-spotify/1" as const,
  playlists: [{ night, file: "x.csv", lists: lists.map(([person, tracks]) => ({ person, tracks })) }],
});
const withSpotify = (files: ReturnType<typeof file>[], data: ReturnType<typeof spotifyOf>) =>
  distillOne([{ id: "test", crawl: crawlOf(files) }],
    { ...RULES, personAliases: { dov: "Dov", ada: "Ada", bo: "Bo" } }, data);

test("a song the files already name is not added twice", () => {
  // The first version of this matched by exact title only and doubled every
  // YouTube rip whose tags run "Lightning | Megan McDuffee".
  const files = [
    fileD(["20250419 Roll", "Bo", "a.mp3"], 200, { artist: "Ghost", title: "Miasma", composer: "Bo" }),
    fileD(["20250419 Roll", "Bo", "b.mp3"], 215, { artist: "Lightning", title: "Megan McDuffee & Nathan Kidd", composer: "Bo" }),
  ];
  const c = withSpotify(files, spotifyOf("2025-04-19", [["Bo", [
    sp("Miasma", ["Ghost"], 200.3, ["metal"]),
    sp("Lightning", ["Megan McDuffee", "Nathan Kidd"], 198),
  ]]]));
  assert.equal(c.tracks.filter((t) => t.source === "spotify").length, 0, "both were already there");
  assert.equal(c.events[0].playedCount, 2);
  assert.equal(c.tracks.find((t) => t.title === "Miasma")!.genre, "metal", "the file lacked a genre");
});

test("a contributor with no files at all is filled in from the playlist", () => {
  const files = [fileD(["20230510 Roll", "Ada", "a.mp3"], 200, { artist: "Ghost", title: "Miasma", composer: "Ada" })];
  const c = withSpotify(files, spotifyOf("2023-05-10", [["Dee", [
    sp("Sake", ["Japanese Folk Metal"], 220), sp("Connected", ["Mwk"], 178),
  ]]]));
  const ev = c.events[0];
  assert.ok(ev.people.includes("dee"), "she was there");
  assert.equal(ev.playedCount, 3, "her two songs were played");
  assert.equal(c.tracks.filter((t) => t.personId === "dee").length, 2);
});

test("a playlist beside an anonymised list is counted once, not twice", () => {
  // Dov 2025-11-08 exists only as anon files. Counting his Spotify list on top
  // of them put the night 16 tracks long for a 15-track set.
  const lens = [200, 310, 421, 187];
  const files = lens.map((d, i) => fileD(["20251108 Roll", "Dov", `Gefloopsmos 0${i + 1}.mp3`], d + 0.3));
  const c = withSpotify(files, spotifyOf("2025-11-08", [["Dov", [
    sp("One", ["Heilung"], 200), sp("Two", ["Muse"], 310), sp("Three", ["Rush"], 421),
    sp("Four", ["Tool"], 187), sp("Five", ["Opeth"], 255),   // not in the files
  ]]]));
  assert.equal(c.events[0].playedCount, 4, "the files are the record");
  assert.equal(c.tracks.filter((t) => t.source === "spotify" && t.twinId).length, 4, "four found their file");
});

test("tracks flagged played sum to the event's playedCount and durationSec", () => {
  // The page counts songs and hours from `played`; if it drifts from the
  // distiller's own count, a twin or duplicate is being counted twice.
  const lens = [200, 310, 421, 187];
  const files = [
    ...lens.map((d, i) => fileD(["20240504 Roll", "Ada", "Named", `${BANDS[i]} - S${i}.mp3`], d,
      { artist: BANDS[i], title: `S${i}`, composer: "Ada" })),
    ...lens.map((d, i) => fileD(["20240504 Roll", "Ada", "Unnamed", `Ada 0${i + 1}.mp3`], d + 0.4)),
    ...lens.map((d, i) => fileD(["20251108 Roll", "Dov", `Gefloopsmos 0${i + 1}.mp3`], d + 0.3)),
  ];
  const c = withSpotify(files, spotifyOf("2025-11-08", [["Dov", [
    sp("One", ["Heilung"], 200), sp("Five", ["Opeth"], 255),   // Five is in no file
  ]]]));
  for (const ev of c.events) {
    const counted = c.tracks.filter((t) => t.eventId === ev.id && t.played);
    assert.equal(counted.length, ev.playedCount, ev.id);
    assert.equal(Math.round(counted.reduce((n, t) => n + (t.durationSec ?? 0), 0)), Math.round(ev.durationSec), ev.id);
  }
  const night = c.tracks.filter((t) => t.eventId === "2024-05-04");
  assert.equal(night.filter((t) => t.played).length, 4);
  assert.ok(night.filter((t) => t.flags.includes("anon")).every((t) => !t.played), "the anonymised twins do not count");
  assert.ok(!c.tracks.find((t) => t.title === "Five")!.played, "a playlist entry beside an anon list does not count");
});

test("an anonymised track gives its playlist entry the set order", () => {
  const lens = [200, 310, 421, 187];
  const files = lens.map((d, i) => fileD(["20251108 Roll", "Dov", `Gefloopsmos 0${i + 1}.mp3`], d));
  const c = withSpotify(files, spotifyOf("2025-11-08", [["Dov", [
    sp("D", ["Tool"], 187), sp("A", ["Heilung"], 200), sp("C", ["Rush"], 421), sp("B", ["Muse"], 310)]]]));
  const a = c.tracks.find((t) => t.title === "A")!;
  assert.equal(a.playOrder, 1, "the file numbered 01 is the 200 s one");
  assert.ok(a.songId, "the song is now known");
});

test("an export that matches nothing leaves the catalogue unchanged", () => {
  const files = [fileD(["20240504 Roll", "Ada", "a.mp3"], 200, { artist: "Ghost", title: "Miasma", composer: "Ada" })];
  const c = withSpotify(files, spotifyOf("2031-01-01", [["Ada", [sp("X", ["Y"], 100)]]]));
  assert.equal(c.tracks.length, 1);
});

test("exportify rows survive quotes, commas and a repeated export", () => {
  const csv = [
    "Track URI,Track Name,Album Name,Artist Name(s),Release Date,Duration (ms),Added By,Genres",
    'spotify:track:1,"Evernight - ""Night Falls"", Close","Alb","A;B",2025-09-26,206300,u1,"celtic,folk"',
    'spotify:track:2,Plain,,C,1997,1000,u2,',
  ].join("\r\n");
  const r = importExports([{ file: "20251108-Roll.csv", text: csv }, { file: "20251108-Roll (1).csv", text: csv }],
    { u1: "Ada" });
  const t = r.playlists[0].lists[0].tracks[0];
  assert.equal(t.name, 'Evernight - "Night Falls", Close');
  assert.deepEqual(t.artists, ["A", "B"]);
  assert.deepEqual(t.genres, ["celtic", "folk"]);
  assert.equal(r.playlists[0].lists[0].tracks.length, 1, "the second file repeated it");
  assert.equal(r.unknownUsers.get("u2"), 2, "an unmapped handle is reported, not guessed");
  assert.ok(!JSON.stringify(r.playlists).includes("u1"), "handles never reach the output");
});

// ------------------------------------------------------------ night audit fixes

const AUDIT_RULES: Rules = {
  ...RULES,
  segmentRoles: { ada_: "person", _lsd: "wrapper", unnamed: "wrapper" },
  personAliases: { ada: "Ada", ada_: "Ada" },
};
const audit = (files: ReturnType<typeof file>[], spotify: ReturnType<typeof spotifyOf> | null = null) =>
  distillOne([{ id: "test", crawl: crawlOf(files) }], AUDIT_RULES, spotify);
const tagged = (p: string[], dur: number, i: number) =>
  fileD(p, dur, { artist: BANDS[i % 9], title: `Song ${i}`, composer: "Ada" });

test("a list filed twice, flat and again in phases, is counted once", () => {
  // 2024-05-04: one contributor's list sat in `Ian` and in `Ian_/1. Intro`, and a
  // night that should have run 1 h 40 for him showed 3 h 18.
  const lens = [200, 310, 421, 187, 256, 302];
  const files = [
    ...lens.map((d, i) => tagged(["20240504 Roll", "Ada", `0${i} Song ${i}.mp3`], d, i)),
    ...lens.map((d, i) => tagged(["20240504 Roll", "Ada_", i < 3 ? "1. Intro" : "2. Peak", `Song ${i}.mp3`], d, i)),
  ];
  const c = audit(files);
  assert.equal(c.events[0].playedCount, 6, "six songs were played, not twelve");
  assert.equal(c.tracks.filter((t) => t.flags.includes("copy")).length, 6);
  assert.ok(c.tracks.filter((t) => t.played).every((t) => t.phaseId), "the phased filing is the one kept");
});

test("a song repeated inside one list is not mistaken for a second filing", () => {
  const files = [200, 310, 421, 187].map((d, i) =>
    tagged(["20240504 Roll", "Ada", i < 2 ? "A" : "B", `Song ${i % 2}.mp3`], d, i % 2));
  const c = audit(files);
  assert.equal(c.tracks.filter((t) => t.flags.includes("copy")).length, 0, "one folder, so a repeat is a repeat");
});

test("a stripped list in a shared wrapper belongs to the name on its files", () => {
  // `_LSD/Ada lsd 01.mp3`: no owner folder, but the owner's name is on every file.
  const named = [200, 310, 421, 187, 256, 302].map((d, i) => tagged(["20241109 Roll", "Ada", `Song ${i}.mp3`], d, i));
  const stripped = [233, 341, 275, 198, 402, 288].map((d, i) =>
    fileD(["20241109 Roll", "_LSD", `Ada lsd 0${i + 1}.mp3`], d));
  const c = audit([...named, ...stripped]);
  const lsd = c.tracks.filter((t) => t.path.includes("_LSD"));
  assert.ok(lsd.length > 0 && lsd.every((t) => t.personId === "ada"), "owned by Ada, not 'unattributed'");
  assert.equal(c.events[0].playedCount, 12, "and still played: it is a list of its own");
});

test("the same anonymised file filed twice counts once, but two songs a moment apart both count", () => {
  // Genuine copies agree to the hundredth of a second; different songs of one list
  // land within a second of each other about twice per list.
  const a = [200.0, 310.0, 421.0, 187.0].map((d, i) => fileD(["20240504 Roll", "Ada", "Unnamed", `Ada 0${i + 1}.mp3`], d));
  const copy = [200.0, 310.0].map((d, i) => fileD(["20240504 Roll", "Ada", "Peak", `Ada 0${i + 1} - peak.mp3`], d));
  const near = [fileD(["20240504 Roll", "Ada", "Unnamed", "Ada 05.mp3"], 421.4)];   // a different song, 0.4 s off
  const c = audit([...a, ...copy, ...near]);
  assert.equal(c.events[0].playedCount, 5, "four songs, one re-filed twice, plus the near-miss");
});

test("a Spotify list's leftovers take the leftover files by nearest length", () => {
  // Older files run 20 s over Spotify's cut: nothing pairs by length, but the
  // counts agree, so the names belong to the files. No anonymous row is left.
  const files = [200, 310, 421, 187].map((d, i) => fileD(["20230722 Roll", "Ada", `Ada 0${i + 1}.mp3`], d + 20));
  const data = spotifyOf("2023-07-22", [["Ada", [
    sp("One", ["Heilung"], 200), sp("Two", ["Muse"], 310), sp("Three", ["Rush"], 421), sp("Four", ["Tool"], 187)]]]);
  const c = audit(files, data);
  assert.equal(c.events[0].playedCount, 4);
  assert.equal(c.tracks.filter((t) => t.played && t.flags.includes("anon")).length, 0, "no anonymous rows shown");
});

// ----------------------------------------------------------------------- report

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
