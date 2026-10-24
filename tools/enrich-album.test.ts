/** The album pass: which release a year came from, and the date that goes with it.
 *  Each test is named after the bug it catches. */
import assert from "node:assert/strict";
import { pickRelease, bestDate, dateForYear, typeRank, cleanDate, type MbRelease } from "./enrich-album.ts";

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed++; }
  catch (e) { failures.push(`${name}\n    ${(e as Error).message.split("\n")[0]}`); }
}
const rel = (title: string, date: string, type: string | null, sec: string[] = [], status = "Official"): MbRelease =>
  ({ title, date, status, "release-group": { title, "primary-type": type, "secondary-types": sec } });

test("a later reissue was named as the album instead of the earliest release", () => {
  const p = pickRelease([rel("Greatest Hits", "2004-01-01", "Album"), rel("Original", "1999-05-04", "Album")], 1999)!;
  assert.equal(p.album, "Original");
  assert.equal(p.releaseDate, "1999-05-04");
});
test("a promo or bootleg release, earlier than the real one, supplied the album", () => {
  const p = pickRelease([rel("Leak", "1998-01-01", "Album", [], "Promotion"), rel("Bootleg", "1998-02-02", "Album", [], "Bootleg"), rel("Real", "1999-01-01", "Album")], 1999)!;
  assert.equal(p.album, "Real");
});
test("the single was named when an album came out the same year", () => {
  const p = pickRelease([rel("The Single", "2001-03-01", "Single"), rel("The Album", "2001-09-01", "Album")], 2001)!;
  assert.equal(p.album, "The Album");
});
test("a same-year compilation or live album beat the plain studio album", () => {
  const p = pickRelease([rel("Now 5", "2001-02-01", "Album", ["Compilation"]), rel("Live at X", "2001-02-02", "Album", ["Live"]), rel("Studio", "2001-11-01", "Album")], 2001)!;
  assert.equal(p.album, "Studio");
  assert.ok(typeRank(rel("a", "2001", "Album")) < typeRank(rel("a", "2001", "Single")));
  assert.ok(typeRank(rel("a", "2001", "EP")) < typeRank(rel("a", "2001", "Album", ["Compilation"])));
});
test("a single from an earlier year lost to a later album (year must stay the one stored)", () => {
  const p = pickRelease([rel("Single", "1999-01-01", "Single"), rel("Album", "2000-01-01", "Album")], 1999)!;
  assert.equal(p.album, "Single");
  assert.equal(p.releaseDate, "1999-01-01");
});
test("a release from a different year than the stored year produced a date that contradicts it", () => {
  const p = pickRelease([rel("Album", "2005-06-01", "Album")], 1999)!;
  assert.equal(p.releaseDate, null);
  assert.equal(p.album, "Album");
});
test("a bare year was preferred over a day-precise date in the same year", () => {
  assert.equal(bestDate(2001, ["2001", "2001-07-09", "2001-07-20"]), "2001-07-09");
  assert.equal(bestDate(2001, ["2001", "2001-07"]), "2001-07");
  assert.equal(bestDate(2001, ["2001"]), "2001");
});
test("a date from another year, or a malformed one, was published as the release date", () => {
  assert.equal(bestDate(2001, ["2002-01-01", "bogus", "", undefined, null]), null);
  assert.equal(bestDate(null, ["2001-01-01"]), null);
  assert.equal(dateForYear(1999, "2001-05-05"), null);
  assert.equal(dateForYear(1999, "1999-05"), "1999-05");
  assert.equal(cleanDate("1700-01-01"), null);
});
test("a partial date such as '1987' broke the release picker", () => {
  const p = pickRelease([rel("A", "1987", "Album")], 1987)!;
  assert.deepEqual(p, { album: "A", releaseDate: "1987" });
});
test("the recording's own first-release-date was ignored when it was more precise", () => {
  const p = pickRelease([rel("A", "1987", "Album")], 1987, "1987-03-02")!;
  assert.equal(p.releaseDate, "1987-03-02");
});
test("no official dated release was guessed at instead of reported as nothing found (left retriable)", () => {
  assert.equal(pickRelease([], 1999), null);
  assert.equal(pickRelease([rel("X", "", "Album")], 1999), null);
  assert.equal(pickRelease([rel("X", "1999", "Album", [], "Bootleg")], 1999), null);
});
test("a release without a release group lost its title", () => {
  const p = pickRelease([{ title: "Bare", date: "1990-01-01", status: "Official" }], 1990)!;
  assert.equal(p.album, "Bare");
});

console.log(`enrich-album: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.error(`  FAIL  ${f}`);
if (failures.length) process.exit(1);
