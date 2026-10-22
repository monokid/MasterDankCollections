/** The pure rules of enrichment: cleaning, matching, genre families, impossible years.
 *  Each test is named after the bug it catches. */
import assert from "node:assert/strict";
import {
  cleanTitle, titleKeys, artistCandidates, titleMatch, artistMatch, artistNames,
  familyOf, genreAgrees, yearImpossible, yearsDisagree, looksClassical, FAMILIES,
} from "./enrich-match.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}

// ---- query cleaning
test("a [Radio Edit] suffix was asked for as part of the title", () => {
  assert.equal(cleanTitle("Right Here, Right Now [Radio Edit]"), "Right Here, Right Now");
});
test("a (feat. X) credit in the title made the recording search miss", () => {
  assert.equal(cleanTitle("Glycerine  [feat. Gwen Stefani]"), "Glycerine");
  assert.equal(cleanTitle("Davy Jones (feat. Fia Orädd & Rachel Hall)"), "Davy Jones");
  assert.equal(cleanTitle("Song ft. Someone"), "Song");
});
test("a dash-wrapped '-Slow ver.-' suffix stayed on the title", () => {
  assert.equal(cleanTitle("Fairy Tail Main theme -Slow ver.-"), "Fairy Tail Main theme");
});
test("a (Dubstep Mashup) tag stayed on the title", () => {
  assert.equal(cleanTitle("Disposable Warpigs (Dubstep Mashup)"), "Disposable Warpigs");
});
test("a bracket that is part of the song's name was wrongly stripped", () => {
  assert.equal(cleanTitle("Song (Parts I-V)"), "Song (Parts I-V)");
});
test("curly and straight quotes made the same title look different", () => {
  assert.equal(cleanTitle("Saitama’s Blues"), "Saitama's Blues");
  assert.equal(cleanTitle('"Log Horizon" Main Theme'), "Log Horizon Main Theme");
});
test("'Main Theme' style suffix and the movement of a classical work were never tried as looser titles", () => {
  assert.ok(titleKeys("Fairy Tail Main theme -Slow ver.-").includes("Fairy Tail"));
  assert.ok(titleKeys("Symphony No. 9 ... IV. Allegro con fuoco").includes("Symphony No. 9"));
});
test("the strict title key must come first so exact matches can be told from relaxed ones", () => {
  assert.equal(titleKeys("Fairy Tail Main theme")[0], "Fairy Tail Main theme");
});
test("a credit with several artists tried only the first name", () => {
  const c = artistCandidates("Wotaku & SHIKI");
  assert.deepEqual(c.slice(0, 2), ["Wotaku", "Wotaku & SHIKI"]);
  assert.ok(artistCandidates("Celldweller, Metallica & Black Sabbath").includes("Black Sabbath"));
});
test("'Simon and Garfunkel' style names are kept whole as a candidate", () => {
  assert.ok(artistCandidates("Simon and Garfunkel").includes("Simon and Garfunkel"));
});

// ---- matching
test("an unknown bracket suffix on the returned title lost the match entirely (weak, not none)", () => {
  assert.equal(titleMatch(titleKeys("Hugin & Munin"), "Hugin & Munin (Era Metallum)"), "loose");
});
test("a remix title matched a different song only because it contained its name", () => {
  assert.equal(titleMatch(titleKeys("Heaven"), "Stairway to Heaven"), null);   // too short to contain
  assert.equal(titleMatch(titleKeys("Paranoid"), "Paranoid Android"), null);   // under half the length
});
test("a title that merely contains the other on word boundaries is weak, not exact", () => {
  assert.equal(titleMatch(titleKeys("Eyes of Priestess"), "Eyes of Priestess (Orchestral Version)"), "exact");
  assert.equal(titleMatch(titleKeys("Wolf Totem Full"), "Wolf Totem"), "loose");
});
test("containment crossed word boundaries ('hell' inside 'hello')", () => {
  assert.equal(titleMatch(["Hello World Again"], "Hell World Again"), null);
});
test("a missing 'The' stopped a band matching itself", () => {
  assert.equal(artistMatch(artistNames("The Hu Band"), ["Hu Band"]), "exact");
});
test("a single-letter or three-letter artist matched anything that contained it", () => {
  assert.equal(artistMatch(["Ren"], ["Rene Rodrigez"]), null);
  assert.equal(artistMatch(["X"], ["Linkin Park"]), null);
});
test("a credited collaborator was not recognised among 'Wotaku & SHIKI'", () => {
  assert.equal(artistMatch(artistNames("Wotaku & SHIKI"), ["wotaku"]), "exact");
});
test("diacritics and script differences were not folded when matching artists", () => {
  assert.equal(artistMatch(artistNames("Altin Gun"), ["Altin Gün"]), "exact");
});

// ---- genre families
test("every family pattern is named once and 'other' is the fallback", () => {
  const names = FAMILIES.map(([n]) => n);
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.length >= 20 && names.length <= 28, `${names.length} families`);
  assert.equal(familyOf(["zzz unheard-of"]), "other");
  assert.equal(familyOf([]), null);
});
test("j-pop was filed under pop, and industrial metal under metal", () => {
  assert.equal(familyOf(["j-pop"]), "j-pop/anime");
  assert.equal(familyOf(["industrial metal"]), "industrial/EBM");
  assert.equal(familyOf(["symphonic metal"]), "metal");
});
test("hardcore punk was filed as hard dance, and happy hardcore as punk", () => {
  assert.equal(familyOf(["hardcore punk"]), "punk");
  assert.equal(familyOf(["happy hardcore"]), "hard dance/hardcore");
});
test("post-rock was filed under rock, and post-punk under post-rock", () => {
  assert.equal(familyOf(["post-rock"]), "post-rock/prog");
  assert.equal(familyOf(["post-punk"]), "punk");
});
test("hip hop was filed under pop because of the word 'pop' in 'hip hop pop'-style tags", () => {
  assert.equal(familyOf(["hip hop"]), "hip hop");
  assert.equal(familyOf(["psychedelic trance"]), "psytrance/trance");
  assert.equal(familyOf(["dubstep"]), "dubstep/bass");
});
test("the first-listed genre must outvote a later one", () => {
  assert.equal(familyOf(["power metal", "folk", "pop"]), "metal");
});
test("Spotify agreement ignored same-family genres with different words", () => {
  assert.equal(genreAgrees(["heavy metal"], "power metal"), true);
  assert.equal(genreAgrees(["post-metal", "post-punk"], "j-pop"), false);
});

// ---- year
test("a year after the night it was first played was accepted", () => {
  assert.equal(yearImpossible(2025, "2019-03-02"), true);
  assert.equal(yearImpossible(2019, "2019-03-02"), false);
  assert.equal(yearImpossible(2005, "2019-03-02"), false);
});
test("a missing year or first-played date flagged a song as impossible", () => {
  assert.equal(yearImpossible(null, "2019-03-02"), false);
  assert.equal(yearImpossible(2010, null), false);
});
test("sources a reissue apart were reported as disagreeing", () => {
  assert.equal(yearsDisagree(1994, 1995), false);
  assert.equal(yearsDisagree(1994, 2012), true);
  assert.equal(yearsDisagree(null, 2012), false);
});
test("a composer's symphony was not recognised as classical, and a pop title was", () => {
  assert.equal(looksClassical("Symphony No. 9 ... IV. Allegro con fuoco"), true);
  assert.equal(looksClassical("Glycerine"), false);
});

console.log(`enrich: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
