/** Turns a raw crawl into the catalogue the app reads.
 *
 *  Every rule here is allowed to fail. A track whose person, phase or title we
 *  cannot work out still becomes a Track -- with `unknown` provenance and a
 *  question raised for a human. Three previous attempts at this library stalled
 *  by trying to get the data clean before showing any of it; this one shows all
 *  of it immediately and treats cleaning as an improvement, never a precondition.
 *
 *  Usage: npm run distill -- [crawl.json] [--rules data/rules.json]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Catalog, Event, Person, Phase, Track, TrackFlag, Question, Segment,
  Song, ArtistEntry, SegmentRole, PhaseBucket, Provenance, Audio,
} from "../src/catalog.js";
import type { SpotifyData, SpotifyTrack } from "./spotify.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

// ---------------------------------------------------------------- crawl shape

interface CrawlFile {
  p: string[];
  sz: number;
  mt: number;
  ext: string;
  /** Set by a placement: the owner said whose playlist this is. */
  placedPerson?: string;
  /** Set when the placement replaces: the night/person prefix it supersedes. */
  replaces?: string;
  a?: { dur?: number; br?: number; sr?: number; ch?: number; bits?: number; codec?: string };
  t?: Record<string, string[]>;
  e?: Record<string, string>;
  err?: string;
}
interface Crawl {
  schema: string;
  scanned_at: string;
  root_name: string;
  root_path?: string;
  machine: string;
  counts: { media: number; excluded: number; [k: string]: unknown };
  files: CrawlFile[];
}

// ------------------------------------------------------------- human overrides

interface Rules {
  /** Folder segment (lowercased) -> what it is. The one question that matters. */
  segmentRoles: Record<string, SegmentRole>;
  /** Folder/tag spelling (lowercased) -> canonical person name. */
  personAliases: Record<string, string>;
  /** Names that look like people in composer tags but are not contributors. */
  notPeople: string[];
  /** Event folder -> ISO date, for folders that carry none. */
  eventDates: Record<string, string>;
  /** Top-level folders that are standing collections, not nights. */
  collections: string[];
  /** Whose library this is; surfaced differently in the UI. */
  you: string;
  /** Where a loose folder belongs. See `Placement`. */
  placements?: Placement[];
}

/** A folder that is one person's playlist for one night, found outside the
 *  event tree it belongs to.
 *
 *  A playlist can reach the catalogue from somewhere other than the library
 *  root -- a shared drive, say, holding "TRIPS - NAMED" with no date anywhere
 *  in its path. Only the owner knows which night that was, so it is stated
 *  here rather than guessed, and the files are re-homed under that night
 *  before anything else looks at them. */
interface Placement {
  /** Folder prefix, slash-separated, case-insensitive: "TRIPS - NAMED". */
  from: string;
  /** Event folder it joins, as the library spells it: "20260404 Trip". */
  event?: string;
  /** Contributor folder to file it under. */
  person?: string;
  /** Drop it instead. For the anonymised twin of a playlist that is already
   *  in the library, where keeping both would count one playlist twice. */
  ignore?: boolean;
  /** Supersede what other scans hold for this night and person. For an original
   *  whose copy elsewhere was flattened: the library's `20251108 Roll/Cal` is 16
   *  loose files, the NAS original is the same 16 in four roman-numbered phases. */
  replace?: boolean;
}

/** Re-home placed folders. Anything not covered passes through untouched. */
function applyPlacements(files: CrawlFile[], placements: Placement[]): CrawlFile[] {
  if (!placements.length) return files;
  const rules = placements.map((pl) => ({
    pl, prefix: pl.from.split("/").map(norm),
  }));
  const out: CrawlFile[] = [];
  for (const f of files) {
    const dirs = f.p.slice(0, -1).map(norm);
    const hit = rules.find(({ prefix }) =>
      prefix.length <= dirs.length && prefix.every((seg, i) => dirs[i] === seg));
    if (!hit) { out.push(f); continue; }
    if (hit.pl.ignore || !hit.pl.event) continue;
    const rest = f.p.slice(hit.prefix.length);
    out.push({
      ...f, p: [hit.pl.event, ...(hit.pl.person ? [hit.pl.person] : []), ...rest],
      ...(hit.pl.person ? { placedPerson: hit.pl.person } : {}),
      ...(hit.pl.replace && hit.pl.person ? {
        replaces: `${parseEventFolder(hit.pl.event).date ?? norm(hit.pl.event)}/${norm(hit.pl.person)}`,
      } : {}),
    });
  }
  return out;
}

const DEFAULT_RULES: Rules = {
  segmentRoles: {}, personAliases: {}, notPeople: [], eventDates: {},
  collections: [], you: "",
};

// Structural folders that group things without being a person or a phase.
const WRAPPER_WORDS = new Set([
  "named", "anon", "anoniem", "shared", "misc", "diverse", "youtube",
  "albums", "album", "extra", "extras", "overige", "rest",
]);

// Vocabulary for the arc. Order matters: first hit wins, so longer/more
// specific phrases are listed before the words they contain.
const PHASE_VOCAB: [RegExp, PhaseBucket][] = [
  [/\bafter\s*glow\b|\bafterglow\b|\bnaglow\b|\buitloop\b/i, "afterglow"],
  [/\bcome\s*up\b|\bcomeup\b|\bintro\b|\bwarm\s*up\b|\bopening\b|\bstart\b|\bbegin\b|\bpre\b/i, "early"],
  [/\bpeak\b|\bpiek\b|\bclimax\b|\bmid\b|\bmidden\b|\bheight\b|\bmain\b/i, "peak"],
  [/\boutro\b|\bend\b|\beind\b|\bclose\b|\bafloop\b|\blanding\b|\bcool\s*down\b|\bpost\b/i, "late"],
];

// Substances used as phase names in this library. Recorded as vocabulary
// because that is what the folders say, not as a claim about anything.
const PHASE_NAMES = new Set([
  "molly", "lucy", "roll", "trip", "candy", "flip", "lsd", "spares",
]);

// Bracketed words that mark a *rendition* of a song rather than a different
// song. Deliberately short: "(Parts I-V)" and "(Parts VI-IX)" are different
// pieces of music and must never fold together, so anything not on this list
// stays part of the song's identity.
const VARIANT_WORDS = [
  "live", "remix", "remaster", "remastered", "acoustic", "instrumental",
  "unplugged", "demo", "reprise", "cover", "radio edit", "extended mix",
  "orchestral", "karaoke",
];
const VARIANT_ALT = VARIANT_WORDS.join("|");
// String.raw throughout: these are regex sources, and a template literal eats
// every backslash that is not a known string escape.
const VARIANT_RE = new RegExp(
  String.raw`[(\[]\s*([^)\]]*\b(?:` + VARIANT_ALT + String.raw`)\b[^)\]]*)\s*[)\]]`, "i");
const VARIANT_TRAIL = new RegExp(
  String.raw`\s*[-–]\s*((?:` + VARIANT_ALT + String.raw`)\b.*)$`, "i");

// How the nights are named. The folder names are jokes -- "Rollenbollen",
// "Flipperen", "trippekes" -- but every one of them contains the word for what
// kind of night it was, and a night can be more than one kind.
const EVENT_TYPES: [RegExp, string][] = [
  [/candy|flip/i, "candyflip"],
  [/roll/i, "roll"],
  [/trip/i, "trip"],
];

// ------------------------------------------------------------------- utilities

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";

const norm = (s: string) => s.trim().toLowerCase();

/** Case- and punctuation-insensitive form, for deciding identity.
 *
 *  Keeps letters and digits from *every* script. An earlier version kept only
 *  a-z0-9, so a Japanese artist folded to the empty string: 36 tracks lost
 *  their song identity, and an empty name read as "nothing but a number". */
const fold = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Splits "King Nothing (Live)" into the work and the rendition. */
function splitVariant(title: string): { base: string; variant: string | null } {
  const m = title.match(VARIANT_RE);
  if (m) return { base: title.replace(VARIANT_RE, "").trim(), variant: m[1].trim() };
  const t = title.match(VARIANT_TRAIL);
  if (t) return { base: title.replace(VARIANT_TRAIL, "").trim(), variant: t[1].trim() };
  return { base: title.trim(), variant: null };
}

function eventTypes(...names: string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    for (const [re, type] of EVENT_TYPES) if (re.test(name)) out.add(type);
  }
  return [...out];
}

/** "20180203 Roll" -> { date, rest }.  Undated folders return date: null.
 *
 *  The date is looked for *anywhere* in the name, not just at the front:
 *  "Roll - 20221231 anon" is the anonymised half of the 2022-12-31 night and
 *  has to land on the same event as "20221231 Roll", not float off undated. */
function parseEventFolder(folder: string) {
  const m = folder.match(/(^|[^\d])(\d{4})[-_. ]?(\d{2})[-_. ]?(\d{2})($|[^\d])/);
  if (!m) return { date: null as string | null, rest: folder.trim() };
  const [, , y, mo, d] = m;
  const valid = Number(y) >= 1980 && Number(y) <= 2100 &&
    Number(mo) >= 1 && Number(mo) <= 12 && Number(d) >= 1 && Number(d) <= 31;
  if (!valid) return { date: null as string | null, rest: folder.trim() };
  const rest = (folder.slice(0, m.index! + m[1].length) +
    " " + folder.slice(m.index! + m[0].length - m[5].length))
    .replace(/[-_.\s]+/g, " ").trim();
  return { date: `${y}-${mo}-${d}`, rest };
}

/** Pulls ordering and duration hints out of a phase folder name.
 *  "01 - Intro" -> order 1;  "Mid 75" -> 75 minutes;  "2. TOCH" -> order 2. */
const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

function parsePhaseLabel(label: string) {
  let clean = label.trim();
  let order: number | null = null;
  let minutes: number | null = null;

  // A folder that is nothing but a number is pure ordering: ".../1", ".../2".
  if (/^\d{1,2}$/.test(clean)) return { clean, order: Number(clean), minutes: null };

  // Same job in roman numerals. None appear in the library today, but the
  // joke phase names are ordered one way or another and this is the other way.
  const roman = clean.match(/^(i{1,3}|iv|v|vi{1,3}|ix|x)\b[\s.)\-_:]*(.*)$/i);
  if (roman) {
    const n = ROMAN[roman[1].toLowerCase()];
    if (n) return { clean: roman[2].trim() || roman[1], order: n, minutes: null };
  }

  const lead = clean.match(/^(\d{1,2})\s*[.)\-_:]*\s+(.*)$/);
  if (lead) { order = Number(lead[1]); clean = lead[2].trim(); }

  // An explicit length in brackets: "Spares (20min)".
  const paren = clean.match(/^(.*?)\s*\((\d{1,3})\s*(?:min|m|minutes)?\)\s*$/i);
  if (paren) {
    minutes = Number(paren[2]);
    clean = paren[1].trim();
  } else {
    // A trailing bare number is a length too ("Outro 30", "Mid 75").
    const trail = clean.match(/^(.*?)[\s\-]+(\d{1,3})$/);
    if (trail && Number(trail[2]) >= 5) {
      minutes = Number(trail[2]);
      clean = trail[1].trim();
    }
  }
  return { clean: clean || label.trim(), order, minutes };
}

function phaseBucket(label: string): PhaseBucket {
  for (const [re, bucket] of PHASE_VOCAB) if (re.test(label)) return bucket;
  return "other";
}

/** "Artist - Title" out of text that has already lost its extension and
 *  running number. Falls back to the whole text as a title. */
function splitArtistTitle(cleaned: string, fallback: string) {
  const m = cleaned.match(/^(.{2,}?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { artist: null as string | null, title: cleaned.trim() || fallback };
}

/** "Artist - Title.mp3" -> parts. */
function parseFilename(name: string, numbered = false) {
  return splitArtistTitle(bareName(name, numbered), stemOf(name));
}

/** A phase named in the filename itself: "00 Intro 1 - Artist - Title". Some
 *  lists carry no phase folders at all and say where a track sits in the name. */
function phaseLabel(raw: string): string {
  const word = raw.toLowerCase().replace(/\s+/g, "");
  return word === "afterglow" ? "Afterglow" : word === "comeup" ? "Come up"
    : word === "warmup" ? "Warm up" : word[0].toUpperCase() + word.slice(1);
}
const PHASE_LEAD =
  /^(intro|pre|come ?up|warm ?up|peak|mid|main|outro|post|after ?glow)\s*\d{0,2}\s*(?:[-–—]\s*|$)(.*)$/i;
function filenamePhase(name: string, numbered: boolean) {
  const m = bareName(name, numbered).match(PHASE_LEAD);
  if (!m) return null;
  return { label: phaseLabel(m[1]), rest: m[2].trim() };
}

/** Is this "artist" really a contributor's own numbering -- "Cal 01"?
 *
 *  Anonymised playlists are named after their owner and a running number, so
 *  splitting "Cal 07 - MAN VAN DE OORLOG.mp3" on the dash invents an artist
 *  called "Cal 07". The test is deliberately narrow: strip the trailing number
 *  and require what is left to be a folder on the path or a known person.
 *  Stripping digits alone would also destroy "Clair Obscur: Expedition 33",
 *  which is a real artist whose name merely ends in a number. */
function isPlaceholderArtist(artist: string, path: string[], known: Set<string>) {
  const folded = fold(artist);
  if (!folded) return true;
  // A phase word where an artist should be: "peak - 1 - whatever.flac".
  const bare = folded.replace(/\s*\d{1,3}$/, "").trim();
  if (PHASE_NAMES.has(bare) || phaseBucket(bare) !== "other") return true;
  // A file sitting inside a folder named for its own "artist" is the owner
  // labelling their own file: "Ada/Unnamed/01 - Ada - MWK.mp3". No digits
  // needed, because the folder it is in is the evidence.
  if (path.slice(0, -1).some((seg) => fold(seg) === bare)) return true;
  // The owner's running number elsewhere: "Cal 07". Needs the digits, since a
  // bare "Cal - Title" could be a real artist who shares a first name.
  const m = folded.match(/^(.*?)\s*\d{1,3}$/);
  return !!m && !!m[1] && known.has(m[1].trim());
}

const firstTag = (f: CrawlFile, ...keys: string[]) => {
  for (const k of keys) {
    const v = f.e?.[k];
    if (v && v.trim()) return v.trim();
  }
  return null;
};

// ------------------------------------------------------------------ the passes

// ------------------------------------------------------------ lists and anon

/** A running number at the front of a filename: "00A -", "07.", "12 ". */
const SEQ_TOKEN = /^\d{1,3}[A-Za-z]?(?=[\s.\-_)])/;
const SEQ_STRIP_PLAIN = /^\d{1,3}[A-Za-z]?\s*[.\-_)]+\s*/;
const SEQ_STRIP_LISTED = /^\d{1,3}[A-Za-z]?(?:\s*[.\-_)]+\s*|\s+)/;

const stemOf = (name: string) => name.replace(/\.[a-z0-9]+$/i, "");

/** A filename without its extension and its running number.
 *
 *  `numbered` says whether the file's *list* counts its files. Only then is a
 *  bare leading "12 " a sequence number; elsewhere it may be a title
 *  ("99 Luftballons"), so it stays. */
function bareName(name: string, numbered: boolean): string {
  return stemOf(name).replace(numbered ? SEQ_STRIP_LISTED : SEQ_STRIP_PLAIN, "").trim();
}

/** Exact words only. Matching a phase *regex* against a title would take
 *  "Start Me Up" for a phase called "start". */
const PHASE_EXACT = new Set([
  "intro", "pre", "come up", "comeup", "warm up", "warmup", "peak", "mid",
  "main", "outro", "post", "afterglow", "after glow", ...PHASE_NAMES,
]);

/** Dash with whitespace on at least one side. A hyphen inside a word
 *  ("Corpo-Mente") is not a separator. */
const SEP = /\s+[-–—]\s*|\s*[-–—]\s+/;

/** Does a name say nothing? The evidence an anonymised copy leaves behind:
 *  nothing but a number, the owner's own name ("Ada", "Cal 07 - JOKE"), or a
 *  phase word followed by one of those ("Peak - Ada"). A real "Artist - Title"
 *  names someone, and an untagged song with no dash at all ("CURTSY.mp3") is
 *  just a song -- absence of an artist is not evidence of anything. */
function isPlaceholderName(rem: string, stems: Set<string>, depth = 0): boolean {
  const r = rem.trim();
  if (!fold(r)) return true;
  const parts = r.split(SEP);
  const toks = fold(parts[0]).split(" ").filter(Boolean);
  const isNumber = (t: string) => /^\d{1,3}$/.test(t);
  if (toks.every(isNumber)) return true;                 // "1", "07"

  // Every word of the label is a number, an owner or a phase word:
  // "Ada", "Cal 07", "Ada-LSD 01", "bo lsd 03". Judged on all the words
  // because the label's own hyphen ("Ada-LSD") is not a separator.
  const allOk = toks.every((t) => isNumber(t) || stems.has(t) || PHASE_EXACT.has(t));
  const hasOwner = toks.some((t) => stems.has(t)) ||
    stems.has(toks.filter((t) => !isNumber(t)).join(" "));
  if (allOk && hasOwner) return true;
  // Only phase words and numbers ("Peak", "Intro 1"): the label says nothing
  // by itself, so what follows decides -- "Peak - Ada" is a placeholder,
  // "Intro 1 - All India Radio - Monsters" is a real song with a phase label.
  if (allOk && depth < 4) return isPlaceholderName(parts.slice(1).join(" - "), stems, depth + 1);
  return false;
}

interface AnonAnalysis {
  /** Folders whose every list is stripped, outermost only. The user's model:
   *  event > person > anon list, so a whole subtree is marked at once. */
  whole: Set<string>;
  /** Directories whose own files are an anonymised list. */
  lists: Set<string>;
  /** Directories whose files carry running numbers, which changes how a name
   *  is read ("12 Radiohead" is track 12, not a title). */
  numbered: Set<string>;
  /** Files whose own name is a placeholder. */
  placeholder: Set<CrawlFile>;
}

/** Decide, from the folder structure and what the names actually say, which
 *  files are the anonymised side of a playlist.
 *
 *  The unit is the *list*: every file sharing one immediate directory. A list
 *  is anonymised when it is untagged and most of its names are placeholders,
 *  and named when it is tagged or its names are real. A folder is wholly
 *  anonymised only when it holds anonymised lists and no named one, so
 *  "Ada/Unnamed" is marked at once while "Ada" itself, which also holds
 *  "Ada/Named", is not. */
function analyseAnon(files: CrawlFile[], known: Set<string>): AnonAnalysis {
  const hasTags = (f: CrawlFile) => !!(f.e && (f.e.artist || f.e.Artist || f.e.title));
  const dirKey = (f: CrawlFile) => f.p.slice(0, -1).map(norm).join("/");

  const byDir = new Map<string, CrawlFile[]>();
  for (const f of files) {
    if (f.p.length < 2) continue;                      // a file at the library root
    const k = dirKey(f);
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k)!.push(f);
  }

  const numbered = new Set<string>();
  const placeholder = new Set<CrawlFile>();
  const verdict = new Map<string, "anon" | "named" | "neutral">();
  const stat = new Map<string, { n: number }>();

  for (const [key, list] of byDir) {
    const n = list.length;
    const seq = n >= 3 &&
      list.filter((f) => SEQ_TOKEN.test(f.p[f.p.length - 1])).length / n >= 0.7;
    if (seq) numbered.add(key);

    const stems = new Set<string>(known);
    for (const seg of list[0].p.slice(0, -1)) stems.add(fold(seg));

    // A name repeated with a running number -- "Jos 01", "Jos 02" -- is
    // numbering, whoever "Jos" is. Spotted by repetition, so it needs no list
    // of names.
    // Numbering *counts*: the numbers differ from file to file. A real artist
    // whose name ends in a digit ("Clair Obscur Expedition 33") repeats the
    // same number every time, so it is not numbering.
    const heads = new Map<string, Set<string>>();
    const headOf = new Map<CrawlFile, string>();
    for (const f of list) {
      const rem = bareName(f.p[f.p.length - 1], seq);
      const head = fold(rem.split(SEP)[0]);
      const m = head.match(/^(.+?)\s*(\d{1,3})$/);
      if (m) {
        headOf.set(f, m[1]);
        if (!heads.has(m[1])) heads.set(m[1], new Set());
        heads.get(m[1])!.add(m[2]);
      }
    }

    let ph = 0, tagged = 0;
    for (const f of list) {
      const rem = bareName(f.p[f.p.length - 1], seq);
      const stem = headOf.get(f);
      const distinct = stem ? heads.get(stem)?.size ?? 0 : 0;
      const repeated = distinct >= Math.max(3, n * 0.6);
      if (isPlaceholderName(rem, stems) || repeated) { placeholder.add(f); ph++; }
      if (hasTags(f)) tagged++;
    }

    let v: "anon" | "named" | "neutral" = "neutral";
    if (n >= 3) {
      if (tagged / n > 0.05) v = "named";
      else if (ph / n >= 0.6) v = "anon";
      else if (ph / n < 0.2) v = "named";
    }
    verdict.set(key, v);
    stat.set(key, { n });
  }

  // Roll every list up through its ancestors.
  const node = new Map<string, { files: number; anonFiles: number; named: number }>();
  for (const [key, v] of verdict) {
    const segs = key.split("/");
    const n = stat.get(key)!.n;
    for (let i = 1; i <= segs.length; i++) {
      const k = segs.slice(0, i).join("/");
      if (!node.has(k)) node.set(k, { files: 0, anonFiles: 0, named: 0 });
      const s = node.get(k)!;
      s.files += n;
      if (v === "anon") s.anonFiles += n;
      if (v === "named") s.named++;
    }
  }
  const whole = new Set<string>();
  for (const [k, s] of node) {
    if (s.named === 0 && s.anonFiles >= 0.6 * s.files && s.anonFiles > 0) whole.add(k);
  }
  for (const k of [...whole]) {
    for (const other of whole) {
      if (other !== k && k.startsWith(other + "/")) { whole.delete(k); break; }
    }
  }

  const lists = new Set([...verdict].filter(([, v]) => v === "anon").map(([k]) => k));
  return { whole, lists, numbered, placeholder };
}

/** Kept for callers that only want the folders. */
function detectAnonFolders(files: CrawlFile[], known: Set<string> = new Set()) {
  return analyseAnon(files, known).whole;
}

/** Which composer-tag values are contributors rather than actual composers?
 *
 *  Answered from the data, not from a list I made up. The discriminator is how
 *  many *distinct artists* a value keeps company with: a contributor who brought
 *  600 tracks sits beside 600 different artists, whereas a genuine composer
 *  credit ("Nobuo Uematsu") sits beside one or two -- usually itself, because
 *  the composer and the artist of that track are the same person.
 */
function detectPeople(files: CrawlFile[], rules: Rules) {
  const folderNames = new Set<string>();
  for (const f of files) for (const seg of f.p.slice(1, -1)) folderNames.add(norm(seg));

  const byValue = new Map<string, {
    n: number; events: Set<string>; artists: Set<string>; selfCredit: number;
  }>();
  for (const f of files) {
    const c = firstTag(f, "composer", "Composer");
    if (!c) continue;
    const key = norm(c);
    if (!byValue.has(key)) {
      byValue.set(key, { n: 0, events: new Set(), artists: new Set(), selfCredit: 0 });
    }
    const e = byValue.get(key)!;
    e.n++;
    e.events.add(f.p[0]);
    const artist = firstTag(f, "artist", "Artist");
    if (artist) {
      e.artists.add(norm(artist));
      if (norm(artist) === key || norm(artist).includes(key)) e.selfCredit++;
    }
  }

  const notPeople = new Set(rules.notPeople.map(norm));
  const people = new Set<string>();
  for (const [value, st] of byValue) {
    if (notPeople.has(value)) continue;
    if (WRAPPER_WORDS.has(value)) continue;
    if (value.includes("/")) continue;                  // "A/B/C" = real credits
    // Mostly credited on tracks by the same-named artist: that is a composer.
    if (st.n && st.selfCredit / st.n > 0.5) continue;
    const namedFolder = folderNames.has(value);
    if (namedFolder || st.artists.size >= 5) people.add(value);
  }
  for (const alias of Object.keys(rules.personAliases)) people.add(norm(alias));
  // Naming someone in a placement is the owner stating that they are a
  // contributor -- no need for the library to prove it a second time.
  for (const pl of rules.placements ?? []) if (pl.person) people.add(norm(pl.person));

  // --- the fallback tier ---------------------------------------------------
  // Composer coverage collapses on the newer events (68.8% across the full
  // library, against 92.8% on the older sample), so attribution cannot rest on
  // it alone. The structural signal is that a contributor's folder sits
  // *directly under the event* -- phases nest deeper, wrappers are a known
  // list. Two independent confirmations, either of which is enough: the same
  // name recurs across separate nights, or it keeps company with many
  // different artists. A phase folder fails both; it repeats within one event
  // and is named from a small shared vocabulary.
  const topLevel = new Map<string, { events: Set<string>; artists: Set<string> }>();
  for (const f of files) {
    // Skip structural wrappers to find the first segment that means something.
    const seg = f.p.slice(1, -1).find((s) => !WRAPPER_WORDS.has(norm(s)));
    if (!seg) continue;
    const k = norm(seg);
    if (WRAPPER_WORDS.has(k) || PHASE_NAMES.has(k)) continue;
    if (phaseBucket(seg) !== "other") continue;
    const { order, minutes } = parsePhaseLabel(seg);
    if (order !== null || minutes !== null) continue;
    if (!topLevel.has(k)) topLevel.set(k, { events: new Set(), artists: new Set() });
    const st = topLevel.get(k)!;
    st.events.add(f.p[0]);
    const artist = firstTag(f, "artist", "Artist");
    if (artist) st.artists.add(norm(artist));
  }
  const folderPeople = new Set<string>();
  for (const [k, st] of topLevel) {
    if (notPeople.has(k) || people.has(k)) continue;
    if (st.events.size >= 2 || st.artists.size >= 5) folderPeople.add(k);
  }

  return { people, folderPeople, byValue, folderNames };
}

function classifySegment(
  seg: string, rules: Rules, people: Set<string>, folderPeople = new Set<string>(),
): { role: SegmentRole; source: "rule" | "tag" | "folder" | "unknown" } {
  const k = norm(seg);
  if (rules.segmentRoles[k]) return { role: rules.segmentRoles[k], source: "rule" };
  if (people.has(k)) return { role: "person", source: "tag" };
  if (WRAPPER_WORDS.has(k)) return { role: "wrapper", source: "folder" };
  const { order, minutes } = parsePhaseLabel(seg);
  if (order !== null || minutes !== null) return { role: "phase", source: "folder" };
  if (PHASE_NAMES.has(k)) return { role: "phase", source: "folder" };
  if (phaseBucket(seg) !== "other") return { role: "phase", source: "folder" };
  if (/\s[-–]\s/.test(seg)) return { role: "album", source: "folder" };  // "Artist - Album"
  // Weakest tier, and last on purpose: a tag-backed person or any phase signal
  // outranks "this folder sits where contributors usually sit".
  if (folderPeople.has(k)) return { role: "person", source: "folder" };
  return { role: "unknown", source: "unknown" };
}

// ----------------------------------------------------------------------- main

interface SourceInfo {
  id: string; scannedAt: string; rootName: string; rootPath: string;
  machine: string; mediaFiles: number; excluded: number;
  contributed: number; unique: number;
}

/** Fold several crawls into one file list.
 *
 *  No single scan is authoritative. The owner's machine has the complete
 *  library; a copy taken years ago is the only surviving record of folders
 *  since deleted from it. Keeping both means neither has to be thrown away to
 *  tidy the pipeline. A file seen in more than one crawl is taken from the
 *  richest copy -- most tags wins -- so a later scan that lost its metadata
 *  cannot erase what an earlier one captured.
 */
/** Identity of a file across scans.
 *
 *  Not the raw path: event folders get renamed between scans -- "20150925"
 *  became "20150925 Trip" -- which left only 47 of 2,296 files matching. What
 *  survives a rename is the date inside the folder name, so that is what the
 *  key is built from. Verified against both crawls: zero collisions within
 *  either, and 99.8% of the 1,976 files it pairs up agree on byte size.
 */
function mergeKey(f: CrawlFile): string {
  const head = parseEventFolder(f.p[0]).date ?? norm(f.p[0]);
  const parts = f.p.slice(1).map(norm);
  // The extension comes off too: 45 tracks of one night are .flac in the old
  // copy and .mp3 in the new one because they were re-encoded in between, and
  // keying on the full filename counted every one of them twice.
  if (parts.length) parts[parts.length - 1] = parts[parts.length - 1].replace(/\.[a-z0-9]+$/, "");
  return [head, ...parts].join("/");
}

function mergeCrawls(crawls: Array<{ id: string; crawl: Crawl }>, placements: Placement[] = []) {
  const byPath = new Map<string, { file: CrawlFile; source: string; score: number }>();
  const sources: SourceInfo[] = [];

  // Placements first, so every later step sees files under their real night.
  const placed = crawls.map(({ id, crawl: raw }) => ({
    id, crawl: { ...raw, files: applyPlacements(raw.files, placements) },
  }));
  // What a replacing placement supersedes: the same night and person, as held
  // by a scan that did not place it.
  const replaced = new Set<string>();
  for (const { crawl } of placed) {
    for (const f of crawl.files) if (f.replaces) replaced.add(f.replaces);
  }
  const superseded = (f: CrawlFile) =>
    !f.placedPerson && [...replaced].some((pre) => mergeKey(f).startsWith(pre + "/"));
  for (const { crawl } of placed) crawl.files = crawl.files.filter((f) => !superseded(f));

  for (const { id, crawl } of placed) {
    sources.push({
      id, scannedAt: crawl.scanned_at, rootName: crawl.root_name,
      rootPath: crawl.root_path ?? "", machine: crawl.machine,
      mediaFiles: crawl.counts.media, excluded: crawl.counts.excluded,
      contributed: 0, unique: 0,
    });
    for (const f of crawl.files) {
      if (f.p.length < 1) continue;
      const key = mergeKey(f);
      const score = Object.keys(f.e ?? {}).length + Object.keys(f.t ?? {}).length;
      const seen = byPath.get(key);
      if (!seen || score > seen.score) byPath.set(key, { file: f, source: id, score });
    }
  }

  const files: CrawlFile[] = [];
  const owner = new Map<CrawlFile, string>();
  // Which crawls hold each file, so "unique" means genuinely nowhere else.
  const holders = new Map<string, Set<string>>();
  for (const { id, crawl } of placed) {
    for (const f of crawl.files) {
      if (f.p.length < 1) continue;
      const k = mergeKey(f);
      if (!holders.has(k)) holders.set(k, new Set());
      holders.get(k)!.add(id);
    }
  }

  for (const [key, { file, source }] of byPath) {
    files.push(file);
    owner.set(file, source);
    sources.find((x) => x.id === source)!.contributed++;
    const who = holders.get(key)!;
    if (who.size === 1) sources.find((x) => x.id === [...who][0])!.unique++;
  }
  return { files, sources, owner };
}

// ---------------------------------------------------------------------- audio

const LOSSLESS_EXT = new Set([".flac", ".ape", ".wav", ".aiff", ".aif", ".wv"]);

/** What the file is, from what the crawl measured. Apple Lossless hides inside
 *  .m4a with the same codec name as AAC, so the bitrate is the only tell: AAC
 *  rarely passes 320 kbps and ALAC rarely falls below 500. */
function audioOf(f: CrawlFile): Audio | undefined {
  if (!f.a) return undefined;
  const kbps = f.a.br ? Math.round(f.a.br / 1000) : null;
  return {
    format: f.ext.replace(/^\./, "").toLowerCase(),
    lossless: LOSSLESS_EXT.has(f.ext.toLowerCase()) || (f.ext.toLowerCase() === ".m4a" && kbps !== null && kbps > 450),
    kbps,
    sampleRate: f.a.sr ?? null,
    bits: f.a.bits ?? null,
  };
}

// ------------------------------------------------------------------- twins

/** Running times closer than this are the same audio. Re-encoding a track moves
 *  its length by a fraction of a second; two different songs almost never land
 *  within two. */
const DUR_TOL = 2;

/** Pair each anonymised track with its named twin by running time.
 *
 *  Both lists hold the same audio, so the same lengths -- which is why this
 *  works where sequence numbers do not (they exist in only 3 of 15 pairs).
 *  Measured on the real library: every contributor with both lists matched
 *  fully but one at 97% and one at 78%. Two passes keep it honest: a pair is
 *  made first only where it is unambiguous both ways, and ties are then broken
 *  by position in the list. Anything still ambiguous stays unpaired. */
function pairByDuration(named: Track[], anon: Track[]): Array<[Track, Track]> {
  const N = named.filter((t) => t.durationSec);
  const A = anon.filter((t) => t.durationSec);
  const near = (a: Track, b: Track) => Math.abs(a.durationSec! - b.durationSec!) <= DUR_TOL;
  const cand = new Map<Track, Track[]>(A.map((a) => [a, N.filter((n) => near(a, n))]));
  const rev = new Map<Track, Track[]>();
  for (const [a, ns] of cand) for (const n of ns) {
    if (!rev.has(n)) rev.set(n, []);
    rev.get(n)!.push(a);
  }
  const used = new Set<Track>();
  const out: Array<[Track, Track]> = [];
  for (const a of A) {
    const ns = cand.get(a)!;
    if (ns.length === 1 && rev.get(ns[0])!.length === 1 && !used.has(ns[0])) {
      out.push([ns[0], a]); used.add(ns[0]);
    }
  }
  const done = new Set(out.map(([, a]) => a));
  const ia = new Map(A.map((a, i) => [a, i]));
  const inn = new Map(N.map((n, i) => [n, i]));
  for (const a of A) {
    if (done.has(a)) continue;
    const ns = cand.get(a)!.filter((n) => !used.has(n));
    if (!ns.length) continue;
    const best = ns.reduce((b, x) =>
      Math.abs(inn.get(x)! - ia.get(a)!) < Math.abs(inn.get(b)! - ia.get(a)!) ? x : b);
    out.push([best, a]); used.add(best);
  }
  return out;
}

/** Pair what `pairByDuration` left, over a wider gap, but only where nothing else
 *  is close: each side's single nearest within `tol` must be the other. A wrong
 *  pair here would only swap two songs' set positions, never invent a song. */
function pairLoosely(named: Track[], anon: Track[], tol = 8): Array<[Track, Track]> {
  const near = (t: Track, pool: Track[]) => {
    const c = pool.filter((x) => x.durationSec !== null && t.durationSec !== null
      && Math.abs(x.durationSec - t.durationSec) <= tol)
      .sort((x, y) => Math.abs(x.durationSec! - t.durationSec!) - Math.abs(y.durationSec! - t.durationSec!));
    // Ambiguous when a second candidate is nearly as close as the first.
    return c.length === 1 || (c.length > 1 &&
      Math.abs(c[1].durationSec! - t.durationSec!) - Math.abs(c[0].durationSec! - t.durationSec!) > 2)
      ? c[0] : null;
  };
  const out: Array<[Track, Track]> = [];
  for (const n of named) {
    const a = near(n, anon);
    if (a && near(a, named) === n) out.push([n, a]);
  }
  return out;
}

/** Pair what is left by nearest length, over a wide gap, one to one. For a
 *  Spotify list whose files are the same songs in an older, longer cut: the
 *  counts agree even when the lengths do not, and the alternative is a night
 *  that shows an anonymous file beside a song it already has the name of. */
function pairNearest(named: Track[], anon: Track[], tol = 45): Array<[Track, Track]> {
  const cand: Array<[number, Track, Track]> = [];
  for (const n of named) for (const a of anon) {
    if (n.durationSec === null || a.durationSec === null) continue;
    const d = Math.abs(n.durationSec - a.durationSec);
    if (d <= tol) cand.push([d, n, a]);
  }
  cand.sort((x, y) => x[0] - y[0]);
  const usedN = new Set<Track>(), usedA = new Set<Track>();
  const out: Array<[Track, Track]> = [];
  for (const [, n, a] of cand) {
    if (usedN.has(n) || usedA.has(a)) continue;
    usedN.add(n); usedA.add(a); out.push([n, a]);
  }
  return out;
}

/** A list filed twice -- once flat, once split into phases -- is one list. Both
 *  copies were counted, which put one contributor's night at 3 h against
 *  everyone else's 1 h 20. The first folder under the night is the list; where
 *  two lists share at least half of the smaller one's songs, the less-phased one
 *  is the second filing and its overlapping songs are copies. */
function findNamedCopies(named: Track[]): Set<Track> {
  const key = (t: Track) => `${fold(t.artist ?? "")}|${fold(splitVariant(t.title ?? "").base)}`;
  const lists = new Map<string, Track[]>();
  for (const t of named) {
    if (t.source === "spotify" || !t.title) continue;
    const k = t.path[1] ?? "";
    if (!lists.has(k)) lists.set(k, []);
    lists.get(k)!.push(t);
  }
  const copies = new Set<Track>();
  if (lists.size < 2) return copies;
  const order = [...lists.entries()].sort((a, b) =>
    b[1].filter((t) => t.phaseId).length - a[1].filter((t) => t.phaseId).length
    || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const kept = new Set<string>();
  for (const [, ts] of order) {
    const overlap = ts.filter((t) => kept.has(key(t)));
    if (overlap.length >= Math.max(2, ts.length / 2)) for (const t of overlap) copies.add(t);
    for (const t of ts) kept.add(key(t));
  }
  return copies;
}

/** The same anonymised file filed in two folders is one track. Running times
 *  equal to the hundredth of a second are the same file: measured on the real
 *  library every genuine copy agrees to 0.00 s, while two different songs of one
 *  list land within a second of each other about twice per list ("Sammy 07" and
 *  "Sammy 18" differ by 0.47 s), so a looser test deletes real music. Paired
 *  files come first, so a re-filed copy is judged against the one that found its
 *  named twin. */
const SAME_FILE = 0.05;
function findAnonCopies(anon: Track[]): Set<Track> {
  const copies = new Set<Track>();
  const kept: Track[] = anon.filter((t) => t.twinId);
  const rest = anon.filter((t) => !t.twinId).sort((a, b) => a.path.join("/").localeCompare(b.path.join("/")));
  for (const t of rest) {
    if (t.durationSec !== null && kept.some((k) => k.durationSec !== null && Math.abs(k.durationSec - t.durationSec!) <= SAME_FILE)) copies.add(t);
    else kept.push(t);
  }
  return copies;
}

/** The number a filename carries: "00A -" is 0.1, "07." is 7, "Ada 12" is 12. */
function nameNumber(name: string): number | null {
  const stem = stemOf(name);
  const lead = stem.match(/^(\d{1,3})([A-Za-z])?(?=[\s.\-_)])/);
  if (lead) {
    return parseInt(lead[1], 10) + (lead[2] ? (lead[2].toLowerCase().charCodeAt(0) - 96) / 10 : 0);
  }
  const any = stem.match(/(?:^|\s)(\d{1,3})(?=\s|[-.)_]|$)/);
  return any ? parseInt(any[1], 10) : null;
}

/** The numbers a list gives its files -- or none, unless they genuinely count:
 *  most files numbered, no number used twice. A name that merely contains a
 *  number ("Level 42") is not a position. */
function listNumbers(group: Track[]): Map<Track, number | null> {
  const vals = group.map((t) => nameNumber(t.path[t.path.length - 1]));
  const nn = vals.filter((v): v is number => v !== null);
  const ok = group.length >= 3 && nn.length / group.length >= 0.7 && new Set(nn).size === nn.length;
  return new Map(group.map((t, i) => [t, ok ? vals[i] : null]));
}

/** A phase named inside a filename: leading ("00 Intro 1 - ...") or trailing
 *  ("00A - Ada - Pre"). Anonymised names often keep the phase and drop the song. */
function twinPhase(name: string): string | null {
  const numbered = SEQ_TOKEN.test(name);
  const lead = filenamePhase(name, numbered);
  if (lead) return lead.label;
  const parts = bareName(name, numbered).split(SEP);
  if (parts.length < 2) return null;
  const last = fold(parts[parts.length - 1]).replace(/\s*\d{1,3}$/, "").trim();
  return PHASE_EXACT.has(last) && !PHASE_NAMES.has(last) ? phaseLabel(last) : null;
}

function distill(
  crawls: Array<{ id: string; crawl: Crawl }>, rules: Rules, spotify: SpotifyData | null = null,
): Catalog {
  const { files, sources, owner } = mergeCrawls(crawls, rules.placements ?? []);
  const { people: personValues, folderPeople } = detectPeople(files, rules);
  const knownNames = new Set<string>([
    ...personValues, ...folderPeople, ...Object.keys(rules.personAliases).map(norm),
  ]);
  const anon = analyseAnon(files, knownNames);
  const collections = new Set(rules.collections.map(norm));

  const canonPerson = (raw: string) => {
    const k = norm(raw);
    return rules.personAliases[k] ?? raw.trim();
  };

  const events = new Map<string, Event>();
  const peopleById = new Map<string, Person & { events: Set<string> }>();
  const phases = new Map<string, Phase>();
  const tracks: Track[] = [];
  const segStats = new Map<string, { name: string; n: number; events: Set<string>; ex: string[] }>();

  for (const f of files) {
    const prov: Provenance = {};
    const folder = f.p[0];
    const rest = f.p.slice(1, -1);           // directories between event and file
    const filename = f.p[f.p.length - 1];
    const flags: TrackFlag[] = [];

    // --- event -------------------------------------------------------------
    // A file lying at the library root belongs to no night at all. It gets a
    // home of its own rather than becoming a one-track "event" named after
    // itself.
    const loose = f.p.length === 1;
    const isCollection = loose || collections.has(norm(folder));
    const parsed = loose
      ? { date: null as string | null, rest: "Loose files" }
      : parseEventFolder(folder);
    let date = parsed.date;
    prov.event = date ? "folder" : "unknown";
    if (!date && rules.eventDates[norm(folder)]) {
      date = rules.eventDates[norm(folder)];
      prov.event = "rule";
    }
    // The album tag independently carries "20180203 Roll"; use it to fill a gap
    // and to supply the event type.
    const albumTag = firstTag(f, "album", "Album");
    let type: string | null = null;
    if (albumTag) {
      const at = parseEventFolder(albumTag);
      if (!date && at.date) { date = at.date; prov.event = "tag"; }
      // Only a date-prefixed album tag ("20180203 Roll") describes the event.
      // A plain one is the record's own album ("Axel F (Epic Version)") and
      // says nothing about what kind of night it was.
      if (at.date && at.rest) type = at.rest;
    }
    if (!type && parsed.rest) type = parsed.rest;

    const eventId = loose ? "loose"
      : isCollection ? `collection-${slug(folder)}`
      : date ?? `undated-${slug(folder)}`;
    if (!events.has(eventId)) {
      events.set(eventId, {
        id: eventId, folder: loose ? "(library root)" : folder, folders: [],
        kind: isCollection ? "collection" : "event",
        types: [], date: isCollection ? null : date,
        title: parsed.rest, type: isCollection ? null : type,
        trackCount: 0, playedCount: 0, durationSec: 0, people: [], debuts: 0,
        undated: !isCollection && !date,
        provenance: { date: isCollection ? "derived" : prov.event },
      });
    }
    const ev = events.get(eventId)!;
    ev.trackCount++;
    ev.durationSec += f.a?.dur ?? 0;
    for (const t of eventTypes(folder, type ?? "")) {
      if (!ev.types.includes(t)) ev.types.push(t);
    }
    // "20221231 Roll" and "Roll - 20221231 anon" are one night in two folders.
    if (!loose && !ev.folders.includes(folder)) ev.folders.push(folder);

    // --- walk the intermediate folders, assigning roles ---------------------
    let personName: string | null = null;
    let personSource: Provenance[string] = "unknown";
    const phaseSegs: string[] = [];
    let sawAnonWrapper = false;
    let albumName: string | null = null;

    // Is this track the anonymised side of a playlist? Three independent
    // signs, strongest first: it sits inside a folder that is stripped
    // throughout, its own list is stripped, or its own name is a placeholder
    // and it carries no tags. Nothing here fires on mere absence of an artist.
    const dKey = f.p.slice(0, -1).map(norm).join("/");
    let inWhole = false;
    for (let i = 0; i < f.p.length - 1; i++) {
      if (anon.whole.has(f.p.slice(0, i + 1).map(norm).join("/"))) { inWhole = true; break; }
    }
    const untagged = !(f.e && Object.keys(f.e).length);
    const isAnon = inWhole || anon.lists.has(dKey) || (untagged && anon.placeholder.has(f));
    const numbered = anon.numbered.has(dKey);
    const fnPhase = isAnon ? null : filenamePhase(filename, numbered);

    for (const seg of rest) {
      const { role, source } = classifySegment(seg, rules, personValues, folderPeople);
      const k = norm(seg);
      if (!segStats.has(k)) segStats.set(k, { name: seg, n: 0, events: new Set(), ex: [] });
      const st = segStats.get(k)!;
      st.n++; st.events.add(eventId);
      if (st.ex.length < 4) st.ex.push(f.p.join(" / "));

      if (role === "person" && !personName) {
        personName = canonPerson(seg);
        personSource = source === "rule" ? "rule" : "folder";
      } else if (role === "phase") {
        phaseSegs.push(seg);
      } else if (role === "album") {
        // "sjamaanjos - snoepsalto" under Cal is the *title of his playlist*,
        // not a record. Albums are the ones filed before any contributor.
        if (!personName) {
          albumName = seg;
          flags.push("album");
        }
      } else if (role === "wrapper") {
        if (k === "anon" || k === "anoniem") sawAnonWrapper = true;
      }
      // "unknown" contributes nothing but is counted for the question list.
    }

    // The composer tag is cleaner than the folders -- it says "Dov" where the
    // folder says "Timmeh" -- so it wins when both are present.
    const composer = firstTag(f, "composer", "Composer");
    if (composer && personValues.has(norm(composer))) {
      personName = canonPerson(composer);
      personSource = "tag";
    } else if (composer && norm(composer) === "misc" && !personName) {
      // "Misc" declines to name anyone, but the folder it sits in usually does.
      const seg = rest.find((x) => {
        const r = classifySegment(x, rules, personValues, folderPeople);
        return r.role === "person";
      });
      if (seg) { personName = canonPerson(seg); personSource = "folder"; }
    }

    // A placement is the owner's own statement of whose playlist this is, so it
    // outranks a composer tag -- which can be a leftover from a night where
    // someone else played the same file.
    if (f.placedPerson) { personName = canonPerson(f.placedPerson); personSource = "rule"; }

    // A stripped list in a shared wrapper ("_LSD/Ada lsd 01.mp3") has no owner
    // folder, but the owner's name is written on every file: that is the only
    // place it is recorded.
    if (!personName && isAnon) {
      const m = stemOf(filename).match(/^(\p{L}+)[\s_-]/u);
      if (m && knownNames.has(norm(m[1]))) { personName = canonPerson(m[1]); personSource = "filename"; }
    }

    let personId: string | null = null;
    if (personName && !WRAPPER_WORDS.has(norm(personName))) {
      personId = slug(personName);
      if (!peopleById.has(personId)) {
        peopleById.set(personId, {
          id: personId, name: personName, aliases: [], trackCount: 0,
          eventCount: 0, events: new Set(), isYou: norm(personName) === norm(rules.you),
        });
      }
      const p = peopleById.get(personId)!;
      p.trackCount++; p.events.add(eventId);
      // Aliases come only from an explicit human answer. Inferring them from
      // "this folder disagrees with the composer tag" is wrong: a track of
      // Bo's sitting in Cal's folder is a real mismatch worth seeing, not
      // evidence that Cal is another name for Bo.
      for (const seg of rest) {
        const k = norm(seg);
        if (rules.personAliases[k] === personName && !p.aliases.includes(seg)) {
          p.aliases.push(seg);
        }
      }
    }
    prov.person = personId ? personSource : "unknown";

    // --- phase --------------------------------------------------------------
    let phaseId: string | null = null;
    if (phaseSegs.length) {
      const label = phaseSegs[phaseSegs.length - 1];
      const { clean, order, minutes } = parsePhaseLabel(label);
      phaseId = `${eventId}:${personId ?? "-"}:${slug(label)}`;
      if (!phases.has(phaseId)) {
        phases.set(phaseId, {
          id: phaseId, eventId, personId, label, clean,
          bucket: phaseBucket(clean), order, minutes, trackCount: 0,
          position: 0, basis: "crawl", inferred: false,
        });
      }
      phases.get(phaseId)!.trackCount++;
      prov.phase = "folder";
    } else if (fnPhase) {
      phaseId = `${eventId}:${personId ?? "-"}:${slug(fnPhase.label)}`;
      if (!phases.has(phaseId)) {
        phases.set(phaseId, {
          id: phaseId, eventId, personId, label: fnPhase.label, clean: fnPhase.label,
          bucket: phaseBucket(fnPhase.label), order: null, minutes: null, trackCount: 0,
          position: 0, basis: "crawl", inferred: false,
        });
      }
      phases.get(phaseId)!.trackCount++;
      prov.phase = "filename";
    } else {
      prov.phase = "unknown";
    }

    // --- artist / title ------------------------------------------------------
    let artist = firstTag(f, "artist", "Artist", "albumartist");
    let title = firstTag(f, "title", "Title");
    prov.title = title ? "tag" : "unknown";
    prov.artist = artist ? "tag" : "unknown";
    if (!artist || !title) {
      const fromName = fnPhase
        ? splitArtistTitle(fnPhase.rest, stemOf(filename))
        : parseFilename(filename, numbered);
      if (!title && fromName.title) { title = fromName.title; prov.title = "filename"; }
      // An anonymised filename is deliberately meaningless, and splitting it on
      // a dash invents artists that never existed -- "01 - Peak - Ada.mp3"
      // becomes an artist called "Peak". Those fakes then outrank real results
      // in search, so the name stays whole and the artist stays unknown.
      if (!artist && fromName.artist && !isAnon &&
          !isPlaceholderArtist(fromName.artist, f.p, knownNames)) {
        artist = fromName.artist;
        prov.artist = "filename";
      }
    }
    if (isAnon) {
      title = parseFilename(filename, numbered).title || filename;
      prov.title = "filename";
    }

    // --- flags ---------------------------------------------------------------
    const tagged = !!(f.e && Object.keys(f.e).length);
    if (!tagged) flags.push("untagged");
    if (sawAnonWrapper || isAnon) flags.push("anon");
    if (rest.length === 0 && !isCollection) flags.push("stray");
    if (loose) flags.push("stray");
    if ([".mp4", ".mkv", ".avi", ".webm", ".mov", ".wmv", ".m4v"].includes(f.ext)) {
      flags.push("video");
    }
    tracks.push({
      id: `t${tracks.length}`,
      eventId, personId, phaseId,
      artist: artist || null,
      title: title || null,
      album: albumName ?? (albumTag && !parseEventFolder(albumTag).date ? albumTag : null),
      genre: firstTag(f, "genre", "Genre"),
      songId: null,      // filled in below, once every track is known
      twinId: null,
      playOrder: null,
      variant: null,
      durationSec: f.a?.dur ?? null,
      audio: audioOf(f),
      ext: f.ext,
      sizeBytes: f.sz,
      path: f.p,
      source: owner.get(f) ?? "",
      played: false,
      flags: [...new Set(flags)],
      provenance: prov,
    });
  }


  // --- Spotify: fill the gaps the files leave -----------------------------------
  // A playlist export names songs for contributors whose files are anonymised, or
  // missing altogether. It never overrides a file: a track the files already name
  // is skipped (and only lends its genre and album if the file had none); a track
  // they do not becomes a named track, which the twin pass below pairs with its
  // anonymised copy exactly as it would a file.
  const spotifySeen = { listed: 0, agreed: 0, added: 0, unplaced: 0 };
  if (spotify) {
    // Artist spellings the files already use, by song, so a Spotify track joins
    // the song a file established instead of forking it under a longer credit.
    const spellings = new Map<string, Set<string>>();
    for (const t of tracks) {
      if (!t.artist || !t.title || t.flags.includes("anon")) continue;
      const k = fold(splitVariant(t.title).base);
      if (!spellings.has(k)) spellings.set(k, new Set());
      spellings.get(k)!.add(t.artist);
    }
    const titleKey = (title: string) => fold(splitVariant(title).base);
    const sameTitle = (a: string, b: string) =>
      !!a && !!b && (a === b || (Math.min(a.length, b.length) >= 5 && (a.includes(b) || b.includes(a))));

    for (const pl of spotify.playlists) {
      const ev = events.get(pl.night);
      if (!ev) { spotifySeen.unplaced += pl.lists.reduce((n, l) => n + l.tracks.length, 0); continue; }
      for (const list of pl.lists) {
        const personName = canonPerson(list.person);
        const personId = slug(personName);
        const named = tracks.filter((t) => t.eventId === ev.id && t.personId === personId
          && t.source !== "spotify" && !t.flags.includes("anon") && t.title);
        // Which file is this Spotify track? Three tiers, strictest first, each
        // run over the whole list before the next so an early track cannot steal
        // a later one's file. A YouTube rip arrives as "Lightning | Megan
        // McDuffee & Nathan Kidd" and runs a few seconds long, so the title may
        // sit in either tag and the length may be off.
        const claimed = new Set<Track>();
        const hits = new Map<SpotifyTrack, Track>();
        const text = (t: Track) => fold(`${t.artist ?? ""} ${t.title ?? ""}`);
        const words = (x: string) => fold(x).split(" ").filter((w) => w.length >= 4);
        const dur = (t: Track, sec: number) =>
          t.durationSec === null ? Infinity : Math.abs(t.durationSec - sec);
        const tiers: Array<(s: SpotifyTrack, t: Track) => boolean> = [
          // the same title (or one inside the other)
          (s, t) => sameTitle(titleKey(s.name), titleKey(t.title!)),
          // the title anywhere in the tags, with the artist or the length to back it
          (s, t) => {
            const k = titleKey(s.name);
            if (k.length < 5 || !` ${text(t)} `.includes(` ${k} `)) return false;
            const lead = words(s.artists[0] ?? "")[0];
            return dur(t, s.ms / 1000) <= 8 || (!!lead && text(t).includes(lead));
          },
          // the same running time to the second
          (s, t) => dur(t, s.ms / 1000) <= DUR_TOL,
          // close in length and sharing a distinctive word
          (s, t) => dur(t, s.ms / 1000) <= 8
            && words(`${s.artists.join(" ")} ${s.name}`).some((w) => text(t).includes(w)),
          // a YouTube cut can run far longer, so then two words must agree, one
          // of them from the title
          (s, t) => dur(t, s.ms / 1000) <= 30
            && words(s.name).some((w) => text(t).includes(w))
            && words(`${s.artists.join(" ")} ${s.name}`).filter((w) => text(t).includes(w)).length >= 2,
        ];
        for (const tier of tiers) {
          for (const s of list.tracks) {
            if (hits.has(s)) continue;
            const t = named
              .filter((x) => !claimed.has(x) && tier(s, x))
              .sort((x, y) => dur(x, s.ms / 1000) - dur(y, s.ms / 1000))[0];
            if (t) { hits.set(s, t); claimed.add(t); }
          }
        }
        for (const s of list.tracks) {
          spotifySeen.listed++;
          const sk = titleKey(s.name), sec = s.ms / 1000;
          const hit = hits.get(s);
          if (hit) {
            spotifySeen.agreed++;
            hit.spotifyUri = s.uri;
            if (!hit.genre && s.genres[0]) { hit.genre = s.genres[0]; hit.provenance.genre = "spotify"; }
            if (!hit.album && s.album) { hit.album = s.album; hit.provenance.album = "spotify"; }
            continue;
          }
          if (!peopleById.has(personId)) {
            peopleById.set(personId, {
              id: personId, name: personName, aliases: [], trackCount: 0,
              eventCount: 0, events: new Set(), isYou: norm(personName) === norm(rules.you),
            });
          }
          const who = peopleById.get(personId)!;
          who.trackCount++; who.events.add(ev.id);
          ev.trackCount++;

          const joined = s.artists.join(", ");
          const lead = fold(s.artists[0] ?? "");
          const known = [...(spellings.get(sk) ?? [])].filter((a) => {
            const f = fold(a);
            return lead && (f.includes(lead) || lead.includes(f));
          });
          const adopt = known.length === 1;
          tracks.push({
            id: `t${tracks.length}`,
            eventId: ev.id, personId, phaseId: null,
            artist: adopt ? known[0] : joined || null,
            title: s.name, album: s.album,
            genre: s.genres[0] ?? null,
            songId: null, twinId: null, playOrder: null, variant: null,
            durationSec: sec, ext: "", sizeBytes: 0,
            path: [ev.folder, personName, `Spotify - ${joined} - ${s.name}`],
            source: "spotify", played: false, flags: [], spotifyUri: s.uri,
            provenance: {
              event: "derived", person: "rule", phase: "unknown",
              title: "spotify", artist: adopt ? "derived" : "spotify", album: "spotify",
              ...(s.genres[0] ? { genre: "spotify" as const } : {}),
            },
          });
          spotifySeen.added++;
        }
      }
    }
  }

  // --- twins: pair the two copies of every playlist ----------------------------
  // Every contributor brings two lists: the anonymised one that is played, and a
  // named twin kept for the record. They are one playlist, and three things
  // follow from knowing which track is which.
  const ensurePhase = (eventId: string, personId: string, label: string): Phase => {
    const id = `${eventId}:${personId}:${slug(label)}`;
    let ph = phases.get(id);
    if (!ph) {
      ph = {
        id, eventId, personId, label, clean: label, bucket: phaseBucket(label),
        order: null, minutes: null, trackCount: 0, position: 0, basis: "crawl", inferred: false,
      };
      phases.set(id, ph);
    }
    return ph;
  };
  const twinLists = new Map<string, { named: Track[]; anon: Track[] }>();
  const hasAnon = new Set<string>();
  for (const t of tracks) {
    if (!t.personId) continue;
    const k = `${t.eventId}|${t.personId}`;
    if (t.flags.includes("anon")) hasAnon.add(k);
    if (!twinLists.has(k)) twinLists.set(k, { named: [], anon: [] });
    twinLists.get(k)![t.flags.includes("anon") ? "anon" : "named"].push(t);
  }
  // Anonymised tracks that still count toward a night: only where the named
  // list is evidently missing or incomplete, so the anon one is all there is.
  const countOrphanAnon = new Set<string>();
  const countAnonDirs = new Set<string>();     // anon-only folders: `${person-night}|${folder}`
  const dirOf = (t: Track) => t.path.slice(0, -1).join("/");
  const trackById = new Map(tracks.map((t) => [t.id, t]));
  for (const [k, group] of twinLists) {
    const [eventId, personId] = k.split("|");
    const anon = group.anon;
    // 0. a list filed twice is one list
    const namedCopies = findNamedCopies(group.named);
    for (const t of namedCopies) t.flags.push("copy");
    const named = group.named.filter((t) => !namedCopies.has(t));

    const an = listNumbers(anon), nn = listNumbers(named);
    for (const t of anon) t.playOrder = an.get(t) ?? null;
    for (const t of named) t.playOrder = nn.get(t) ?? null;

    const link = (n: Track, a: Track) => {
      n.twinId = a.id; a.twinId = n.id;
      // 1. the set order: the anonymised list is what was played, so its
      //    numbering orders the named twin, whose own names often do not.
      if (a.playOrder !== null) n.playOrder = a.playOrder;
      // 2. a phase on one copy belongs to the other. Ada's "00A - Ada - Pre"
      //    is the only place his intro is recorded; the named copy gets it.
      if (!n.phaseId) {
        let ph: Phase | null = a.phaseId ? phases.get(a.phaseId) ?? null : null;
        if (!ph) {
          const label = twinPhase(a.path[a.path.length - 1]);
          if (label) ph = ensurePhase(eventId, personId, label);
        }
        if (ph) { n.phaseId = ph.id; n.provenance.phase = "twin"; ph.trackCount++; }
      }
    };
    if (named.length && anon.length) {
      for (const [n, a] of pairByDuration(named, anon)) link(n, a);
    }
    // The same anonymised file filed twice counts once.
    const anonCopies = findAnonCopies(anon);
    for (const t of anonCopies) t.flags.push("copy");
    const anonU = anon.filter((t) => !anonCopies.has(t));
    if (named.length && anonU.length) {
      // The files of an old night can run seconds off Spotify's cut of the same
      // song: take a pair where it is the single close candidate both ways, then
      // whatever is left by nearest length. A Spotify list is the identity of the
      // played files, so its leftovers belong to the leftover files.
      const spot = () => named.filter((t) => t.source === "spotify" && !t.twinId);
      const free = () => anonU.filter((t) => !t.twinId);
      for (const [n, a] of pairLoosely(spot(), free())) link(n, a);
      for (const [n, a] of pairNearest(spot(), free())) { link(n, a); n.provenance.twin = "derived"; }
    }
    // A Spotify list says what a night held, not how much of it survives as
    // files, so only files can show that the named list is incomplete.
    if (named.filter((t) => t.source !== "spotify").length < anonU.length / 2) countOrphanAnon.add(k);
    // A folder of anonymised files no named track claims is a list of its own
    // (a second set filed apart), and it was played.
    const dirs = new Map<string, Track[]>();
    for (const t of anonU) {
      const d = dirOf(t);
      if (!dirs.has(d)) dirs.set(d, []);
      dirs.get(d)!.push(t);
    }
    for (const [d, ts] of dirs) {
      const paired = ts.filter((t) => t.twinId);
      if (paired.length >= ts.length / 2) continue;
      // Most of this folder is unclaimed: the one or two files that found a
      // "twin" did so by chance -- two songs of different lists land within two
      // seconds of each other about once per list -- so undo those pairs.
      for (const t of paired) {
        const n = trackById.get(t.twinId!);
        if (n) n.twinId = null;
        t.twinId = null;
      }
      countAnonDirs.add(`${k}|${d}`);
    }
  }

  // 3. what a night actually ran: a playlist counts once, not once per copy.
  for (const e of events.values()) { e.durationSec = 0; e.playedCount = 0; }
  for (const t of tracks) {
    t.played = false;
    if (t.flags.includes("copy")) continue;                    // the second filing of a track
    if (t.flags.includes("anon")) {
      if (t.twinId) continue;                                  // its named twin counts
      // An unattributed anonymised track has no named list it could be a copy
      // of, so it was simply played; one with an owner counts only if that
      // owner's named list is missing or incomplete, or it sits in a folder of
      // its own that no named track claims.
      const pk = `${t.eventId}|${t.personId}`;
      if (t.personId && !countOrphanAnon.has(pk) && !countAnonDirs.has(`${pk}|${dirOf(t)}`)) continue;
    }
    // Where the contributor's anonymised list survives it is the record of what
    // was played, so a Spotify entry that matched none of its files is almost
    // certainly one of them under a different cut, not an extra song.
    if (t.source === "spotify" && !t.twinId && hasAnon.has(`${t.eventId}|${t.personId}`)) continue;
    const e = events.get(t.eventId)!;
    t.played = true;
    e.durationSec += t.durationSec ?? 0;
    e.playedCount++;
  }

  // --- phases: deduce an order -----------------------------------------------
  // Every contributor uses their own words, but there is always an order to be
  // read: 1-2-3, I-II-III, or intro-peak-outro-afterglow. It is worked out here,
  // once, rather than left for the page to guess.
  const phaseRank = (ph: Phase): number => {
    const w = fold(ph.clean);
    if (/\b(spares?|extras?|bonus|reserve)\b/.test(w)) return 4;   // leftovers last
    if (ph.bucket === "early") return 0;
    if (ph.bucket === "late") return 2;
    if (ph.bucket === "afterglow") return 3;
    if (ph.bucket === "peak" || PHASE_NAMES.has(w)) return 1;       // "Roll", "Trip"
    return 1.5;                                                      // a joke name
  };
  const groups = new Map<string, Phase[]>();
  for (const ph of phases.values()) {
    if (!ph.personId) continue;
    const k = `${ph.eventId}|${ph.personId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(ph);
  }
  for (const [k, group] of groups) {
    const [eventId, personId] = k.split("|");
    // A list with an Afterglow folder and loose tracks beside it: the loose
    // tracks are the body, and come before everything that followed.
    const loose = tracks.filter((t) => t.eventId === eventId && t.personId === personId
      && !t.phaseId && !t.flags.includes("anon"));
    if (loose.length && group.every((ph) => ph.order === null && (phaseRank(ph) < 1 || phaseRank(ph) >= 2))) {
      const id = `${eventId}:${personId}:main`;
      const main: Phase = {
        id, eventId, personId, label: "Main", clean: "Main", bucket: "peak",
        order: null, minutes: null, trackCount: loose.length,
        position: 0, basis: "word", inferred: true,
      };
      phases.set(id, main);
      group.push(main);
      for (const t of loose) { t.phaseId = id; t.provenance.phase = "inferred"; }
    }
    const first = new Map(group.map((ph, i) => [ph.id, i]));
    const numbered = group.every((ph) => ph.order !== null);
    group.sort((a, b) => numbered
      ? a.order! - b.order! || first.get(a.id)! - first.get(b.id)!
      : phaseRank(a) - phaseRank(b)
        || (a.order ?? 99) - (b.order ?? 99)
        || first.get(a.id)! - first.get(b.id)!);
    // A word only orders phases that sit at different points in a night. Two
    // phases of equal rank and no number ("Lucy", "Molly") are tied: nothing in
    // either name says which came first, so folder order stands and says so.
    const rankCount = new Map<number, number>();
    for (const ph of group) rankCount.set(phaseRank(ph), (rankCount.get(phaseRank(ph)) ?? 0) + 1);
    group.forEach((ph, i) => {
      ph.position = i;
      if (ph.inferred) return;
      const tied = (rankCount.get(phaseRank(ph)) ?? 0) > 1;
      ph.basis = ph.order !== null ? "number"
        : phaseRank(ph) === 1.5 || tied ? "crawl" : "word";
    });
  }

  // --- songs and artists ----------------------------------------------------
  // Built after every track exists, because a song's identity is a property of
  // the whole library: the canonical spelling is whichever one appears most,
  // and "recurring" only means anything once all the nights are in.
  const eventDate = (id: string) => events.get(id)?.date ?? null;
  const chronological = (ids: Iterable<string>) =>
    [...new Set(ids)].sort((a, b) =>
      (eventDate(a) ?? "9999").localeCompare(eventDate(b) ?? "9999"));

  interface Acc {
    artistSpellings: Map<string, number>;
    titleSpellings: Map<string, number>;
    variantSpellings: Map<string, Map<string, number>>;
    plays: number;
    nights: Set<string>;
    people: Set<string>;
  }
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  // A bare trailing "Live" ("Ghost Love Score Live") is only a rendition when
  // the title without it is already a song by that artist. Stripping it blindly
  // would turn "Date A Live" into "Date A": of 25 such titles in the library only
  // 3 have a sibling, so this merges those and touches nothing else.
  const knownBases = new Set<string>();
  for (const t of tracks) {
    if (!t.artist || !t.title || t.flags.includes("anon")) continue;
    knownBases.add(`${fold(t.artist)}|${fold(splitVariant(t.title).base)}`);
  }
  const songAcc = new Map<string, Acc>();
  const artistAcc = new Map<string, Acc & { songs: Set<string> }>();

  for (const t of tracks) {
    if (!t.artist || !t.title) continue;
    if (t.flags.includes("anon")) continue;      // a stripped copy names nothing
    let { base, variant } = splitVariant(t.title);
    const aKey = fold(t.artist);
    if (!variant) {
      const m = base.match(/^(.+?)\s+(live|remix|remastered|acoustic|instrumental)$/i);
      if (m && knownBases.has(`${aKey}|${fold(m[1])}`)) { base = m[1]; variant = m[2]; }
    }
    const sKey = `${aKey}|${fold(base)}`;
    if (!aKey || !fold(base)) continue;
    t.songId = sKey;
    t.variant = variant;

    if (!songAcc.has(sKey)) {
      songAcc.set(sKey, {
        artistSpellings: new Map(), titleSpellings: new Map(),
        variantSpellings: new Map(), plays: 0, nights: new Set(), people: new Set(),
      });
    }
    // `favs` and `mix` are shelves, not nights. Counting them as nights made
    // "Metallica on 25 nights" light only 23 bars on the timeline.
    const onANight = events.get(t.eventId)?.kind !== "collection"
      && !!events.get(t.eventId)?.date;

    const sa = songAcc.get(sKey)!;
    bump(sa.artistSpellings, t.artist);
    bump(sa.titleSpellings, base);
    if (variant) {
      // "Live" and "live" are one rendition; keep whichever spelling is commoner.
      const k = fold(variant);
      if (!sa.variantSpellings.has(k)) sa.variantSpellings.set(k, new Map());
      bump(sa.variantSpellings.get(k)!, variant);
    }
    sa.plays++; if (onANight) sa.nights.add(t.eventId);
    if (t.personId) sa.people.add(t.personId);

    if (!artistAcc.has(aKey)) {
      artistAcc.set(aKey, {
        artistSpellings: new Map(), titleSpellings: new Map(),
        variantSpellings: new Map(),
        plays: 0, nights: new Set(), people: new Set(), songs: new Set(),
      });
    }
    const aa = artistAcc.get(aKey)!;
    bump(aa.artistSpellings, t.artist);
    aa.plays++; if (onANight) aa.nights.add(t.eventId); aa.songs.add(sKey);
    if (t.personId) aa.people.add(t.personId);
  }

  const commonest = (m: Map<string, number>) =>
    [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? "";

  const songs: Song[] = [...songAcc.entries()].map(([id, a]) => {
    const nights = chronological(a.nights);
    return {
      id, artist: commonest(a.artistSpellings), title: commonest(a.titleSpellings),
      variants: [...a.variantSpellings.values()].map(commonest).sort(),
      plays: a.plays, nights,
      people: [...a.people],
      firstPlayed: eventDate(nights[0]) ?? null,
      lastPlayed: eventDate(nights[nights.length - 1]) ?? null,
    };
  }).sort((x, y) => y.nights.length - x.nights.length || y.plays - x.plays);

  const artistList: ArtistEntry[] = [...artistAcc.entries()].map(([id, a]) => {
    const nights = chronological(a.nights);
    return {
      id, name: commonest(a.artistSpellings), plays: a.plays, songs: a.songs.size,
      nights, people: [...a.people],
      firstPlayed: eventDate(nights[0]) ?? null,
      lastPlayed: eventDate(nights[nights.length - 1]) ?? null,
    };
  }).sort((x, y) => y.nights.length - x.nights.length || y.plays - x.plays);

  // A debut is a song's very first night in the library's history.
  for (const song of songs) {
    const first = song.nights[0];
    const ev = first && events.get(first);
    if (ev) ev.debuts++;
  }
  for (const t of tracks) {
    const ev = events.get(t.eventId);
    if (ev && t.personId && !ev.people.includes(t.personId)) ev.people.push(t.personId);
  }

  // --- duplicates within an event ------------------------------------------
  // Only a genuine repeat *within one night* is a duplicate. The same song on
  // five separate nights is not an accident -- it is the most interesting fact
  // the library holds, and it used to be flagged and down-ranked as noise.
  const seen = new Map<string, number>();
  for (const t of tracks) {
    if (!t.songId) continue;
    const k = `${t.eventId}|${t.songId}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (seen.get(k)! > 1) t.flags.push("duplicate");
  }

  // --- segments + questions -------------------------------------------------
  const segments: Segment[] = [...segStats]
    .sort((a, b) => b[1].n - a[1].n)
    .map(([key, st]) => {
      const { role, source } = classifySegment(st.name, rules, personValues, folderPeople);
      return {
        name: st.name, key, role, source,
        answered: !!rules.segmentRoles[key],
        occurrences: st.n, events: [...st.events], examples: st.ex,
      };
    });

  const questions: Question[] = [];
  for (const [seg, st] of [...segStats].sort((a, b) => b[1].n - a[1].n)) {
    if (rules.segmentRoles[seg]) continue;               // already answered
    const { role } = classifySegment(seg, rules, personValues, folderPeople);
    if (role !== "unknown") continue;                    // confidently handled
    questions.push({
      id: `seg:${seg}`,
      kind: "segment-role",
      subject: seg,
      examples: st.ex,
      occurrences: st.n,
      events: [...st.events].slice(0, 6),
      assumed: "unknown",
      options: ["person", "phase", "wrapper", "album", "ignore"],
    });
  }
  for (const ev of events.values()) {
    if (!ev.undated) continue;
    questions.push({
      id: `event:${ev.folder}`,
      kind: "event-date",
      subject: ev.folder,
      examples: [], occurrences: ev.trackCount, events: [ev.id],
      assumed: "undated",
      options: [],
    });
  }

  // --- stats ----------------------------------------------------------------
  const flagCounts: Record<string, number> = {};
  for (const t of tracks) for (const fl of t.flags) flagCounts[fl] = (flagCounts[fl] ?? 0) + 1;
  const artists = new Set(tracks.map((t) => t.artist && norm(t.artist)).filter(Boolean));
  const withPerson = tracks.filter((t) => t.personId).length;
  const withPhase = tracks.filter((t) => t.phaseId).length;
  const withTitle = tracks.filter((t) => t.title).length;

  const peopleOut: Person[] = [...peopleById.values()].map(({ events: e, ...p }) => ({
    ...p, eventCount: e.size,
  })).sort((a, b) => b.trackCount - a.trackCount);

  return {
    schema: "mdc-catalog/1",
    generatedAt: new Date().toISOString(),
    sources: spotify && spotifySeen.listed ? [...sources, {
      id: "spotify", scannedAt: "", rootName: "Spotify playlists", rootPath: "",
      machine: "spotify", mediaFiles: spotifySeen.listed, excluded: 0,
      contributed: spotifySeen.added, unique: spotifySeen.added,
    }] : sources,
    stats: {
      tracks: tracks.length,
      events: events.size,
      people: peopleOut.length,
      artists: artists.size,
      personCoverage: tracks.length ? withPerson / tracks.length : 0,
      phaseCoverage: tracks.length ? withPhase / tracks.length : 0,
      titleCoverage: tracks.length ? withTitle / tracks.length : 0,
      anonTracks: tracks.filter((t) => t.flags.includes("anon")).length,
      songs: songs.length,
      recurringSongs: songs.filter((x) => x.nights.length > 1).length,
      recurringArtists: artistList.filter((x) => x.nights.length > 1).length,
      totalHours: Math.round([...events.values()].reduce((n, e) => n + e.durationSec, 0) / 3600),
      flagCounts,
    },
    segments,
    events: [...events.values()].sort((a, b) =>
      // Collections are not nights; they sit after the timeline, not inside it.
      (a.kind === b.kind ? 0 : a.kind === "collection" ? 1 : -1) ||
      (a.date ?? "9").localeCompare(b.date ?? "9")),
    people: peopleOut,
    songs,
    artists: artistList,
    phases: [...phases.values()],
    tracks,
    questions,
  };
}

// ------------------------------------------------------------------------ cli

function allCrawls(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^mdc-crawl-.*\.json$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

function main() {
  const args = process.argv.slice(2);
  const rulesPath = args.includes("--rules")
    ? args[args.indexOf("--rules") + 1]
    : join(ROOT, "data", "rules.json");
  const positional = args.filter((a, i) =>
    !a.startsWith("--") && args[i - 1] !== "--rules");
  // Every crawl in data/ by default: no single scan has the whole library.
  const paths = positional.length ? positional : allCrawls(join(ROOT, "data"));

  if (!paths.length || !paths.every(existsSync)) {
    console.error("No crawl files. Put at least one in data/ or pass paths.");
    process.exit(1);
  }
  const rules: Rules = existsSync(rulesPath)
    ? { ...DEFAULT_RULES, ...JSON.parse(readFileSync(rulesPath, "utf8")) }
    : DEFAULT_RULES;

  const crawls = paths.map((p) => ({
    id: basename(p).replace(/^mdc-crawl-|\.json$/g, ""),
    crawl: JSON.parse(readFileSync(p, "utf8")) as Crawl,
  }));
  const spotifyPath = join(ROOT, "data", "mdc-spotify.json");
  const spotify: SpotifyData | null = existsSync(spotifyPath)
    ? JSON.parse(readFileSync(spotifyPath, "utf8")) : null;
  const catalog = distill(crawls, rules, spotify);

  mkdirSync(join(ROOT, "public", "data"), { recursive: true });
  writeFileSync(join(ROOT, "public", "data", "catalog.json"), JSON.stringify(catalog));
  const s = catalog.stats;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  console.log(`rules    ${existsSync(rulesPath) ? rulesPath : "(none yet)"}`);
  console.log(`sources  ${catalog.sources.length}`);
  for (const src of catalog.sources) {
    console.log(`  ${src.machine.padEnd(16)} ${String(src.mediaFiles).padStart(5)} scanned` +
      `  ${String(src.contributed).padStart(5)} supplied` +
      `  ${String(src.unique).padStart(5)} found nowhere else  (${src.id})`);
  }
  console.log("");
  console.log(`tracks   ${s.tracks}   events ${s.events}   people ${s.people}   artists ${s.artists}`);
  console.log(`coverage person ${pct(s.personCoverage)}  phase ${pct(s.phaseCoverage)}  title ${pct(s.titleCoverage)}`);
  console.log(`flags    ${JSON.stringify(s.flagCounts)}`);
  console.log(`people   ${catalog.people.map((p) => `${p.name}(${p.trackCount})`).join(" ")}`);
  const cols = catalog.events.filter((e) => e.kind === "collection");
  console.log(`collections ${cols.map((c) => `${c.folder}(${c.trackCount})`).join(" ")}`);
  console.log("");
  console.log(`questions ${catalog.questions.length} unanswered`);
  for (const q of catalog.questions.slice(0, 20)) {
    console.log(`  ${q.kind.padEnd(13)} ${q.subject.slice(0, 42).padEnd(44)} x${q.occurrences}`);
  }
  console.log("");
  console.log(`wrote    public/data/catalog.json  (plaintext, gitignored; npm run seal encrypts it)`);
}

export { distill, audioOf, mergeCrawls, applyPlacements, analyseAnon, pairByDuration, pairLoosely, nameNumber, twinPhase, splitVariant, eventTypes, fold, detectAnonFolders, parseEventFolder, parsePhaseLabel, parseFilename, phaseBucket };
export type { Crawl, Rules };

// Windows paths make the usual import.meta.url comparison unreliable; compare
// resolved filesystem paths instead.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
