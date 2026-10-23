/** Hash routing and keyboard rules: pure logic, no browser. */
import assert from "node:assert/strict";
import { parseRoute, formatRoute, titleFor, sameRoute, type Route } from "../src/route.ts";
import { createKeyMachine, isTypingTarget, CHORD_MS, type KeyInfo } from "../src/keys.ts";
import { getSearchQuery, setSearchQuery, subscribeSearchQuery } from "../src/events.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n${(e as Error).stack}`); process.exit(1); }
}

test("every route round-trips through the hash", () => {
  const routes: Route[] = [
    { name: "home" }, { name: "search", q: "" }, { name: "search", q: "pink floyd & co / 100%" },
    { name: "search", q: "ünïcode ✓" }, { name: "timeline" }, { name: "browse" },
    { name: "night", id: "2026-05-01" }, { name: "night", id: "collection-favs" },
    { name: "insights" }, { name: "plan" }, { name: "resolve" }, { name: "song", id: "t123" },
    { name: "song", id: "a/b?c#d" },
  ];
  for (const r of routes) assert.deepEqual(parseRoute(formatRoute(r)), r, formatRoute(r));
});

test("the documented URLs parse as documented", () => {
  assert.deepEqual(parseRoute("#/search?q=floyd"), { name: "search", q: "floyd" });
  assert.deepEqual(parseRoute("#/night/2026-05-01"), { name: "night", id: "2026-05-01" });
  assert.deepEqual(parseRoute("#/song/t5"), { name: "song", id: "t5" });
  assert.deepEqual(parseRoute("#/timeline/"), { name: "timeline" });
});

test("empty, unknown and malformed hashes land on Home instead of throwing", () => {
  for (const h of ["", "#", "#/", "#/nope", "#/night", "#/night/", "#/song/%E0%A4%A", "#/browse/extra", "#//", "#/search/x"]) {
    const r = parseRoute(h);
    if (h === "#/search/x") assert.equal(r.name, "search"); // extra path is ignored for search
    else assert.deepEqual(r, { name: "home" }, h);
  }
});

test("a search with no text has no query string, and the URL carries nothing else", () => {
  assert.equal(formatRoute({ name: "search", q: "" }), "#/search");
  assert.equal(formatRoute({ name: "home" }), "#/");
  assert.ok(sameRoute({ name: "search", q: "a" }, parseRoute("#/search?q=a")));
});

test("titles name the view; home keeps the tagline; detail overrides the name", () => {
  assert.equal(titleFor({ name: "browse" }), "Browse · Master Dank Collections");
  assert.match(titleFor({ name: "home" }), /^Master Dank Collections/);
  assert.equal(titleFor({ name: "night", id: "x" }, "3 May 2026"), "3 May 2026 · Master Dank Collections");
});

// ------------------------------------------------------------------- keys
const k = (key: string, o: Partial<KeyInfo> = {}): KeyInfo =>
  ({ key, ctrlKey: false, metaKey: false, altKey: false, typing: false, ...o });

test("'/', '?' and Escape map to actions", () => {
  const m = createKeyMachine();
  assert.deepEqual(m.feed(k("/")), { type: "focus-search" });
  assert.deepEqual(m.feed(k("?")), { type: "help" });
  assert.deepEqual(m.feed(k("Escape")), { type: "escape" });
  assert.equal(m.feed(k("x")), null);
});

test("nothing fires while typing, or with a modifier held", () => {
  const m = createKeyMachine();
  assert.equal(m.feed(k("/", { typing: true })), null);
  assert.equal(m.feed(k("?", { typing: true })), null);
  assert.equal(m.feed(k("/", { ctrlKey: true })), null);
  assert.equal(m.feed(k("g", { metaKey: true })), null);
});

test("g then s/t/b/i jumps; the chord expires, and typing in between disarms it", () => {
  let t = 0;
  const m = createKeyMachine(() => t);
  for (const [key, to] of [["s", "search"], ["t", "timeline"], ["b", "browse"], ["i", "insights"]] as const) {
    assert.equal(m.feed(k("g")), null);
    assert.deepEqual(m.feed(k(key)), { type: "goto", to });
  }
  assert.equal(m.feed(k("s")), null, "a bare s does nothing");
  m.feed(k("g")); t += CHORD_MS + 1;
  assert.equal(m.feed(k("t")), null, "expired chord");
  m.feed(k("g")); m.feed(k("s", { typing: true }));
  assert.equal(m.feed(k("s")), null, "typing disarmed it");
  m.feed(k("g")); m.feed(k("g"));
  assert.deepEqual(m.feed(k("t")), { type: "goto", to: "timeline" }, "g g t still works");
});

test("typing targets are recognised", () => {
  const el = (tagName: string, isContentEditable = false) => ({ tagName, isContentEditable }) as unknown as EventTarget;
  assert.ok(isTypingTarget(el("INPUT")));
  assert.ok(isTypingTarget(el("TEXTAREA")));
  assert.ok(isTypingTarget(el("SELECT")));
  assert.ok(isTypingTarget(el("DIV", true)));
  assert.ok(!isTypingTarget(el("BUTTON")));
  assert.ok(!isTypingTarget(null));
});

test("search query store notifies only on change and unsubscribes", () => {
  const seen: string[] = [];
  const off = subscribeSearchQuery((q) => seen.push(q));
  assert.equal(setSearchQuery("a"), true);
  assert.equal(setSearchQuery("a"), false);
  setSearchQuery("ab");
  off();
  setSearchQuery("abc");
  assert.deepEqual(seen, ["a", "ab"]);
  assert.equal(getSearchQuery(), "abc");
});

console.log(`route: ${passed} passed`);
