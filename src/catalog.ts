/** The catalogue shape, shared by the distiller that writes it and the app that
 *  reads it.
 *
 *  Design rule that governs this whole file: **unresolved is a value, not a
 *  blocker**. Every track in the crawl becomes a Track here, whether or not we
 *  worked out who brought it, which phase it belongs to, or what it is called.
 *  Nothing is held back pending clean data -- the catalogue renders on the first
 *  pass and gets better as questions are answered.
 */

/** Why a field holds the value it does. Shown in the UI so a wrong answer is
 *  traceable to the rule that produced it rather than looking like a mystery. */
export type Source =
  | "tag"        // read from the file's own metadata
  | "folder"     // inferred from a directory name
  | "filename"   // parsed out of the file name
  | "rule"       // a human answered this in rules.json
  | "derived"    // computed from other resolved fields
  | "twin"       // carried over from the other copy of the same track
  | "spotify"    // read from a Spotify playlist export
  | "inferred"   // read between the lines: a body implied by the folders around it
  | "unknown";   // we genuinely do not know

export interface Provenance {
  [field: string]: Source;
}

/** A folder segment's job within an event. The single question the resolver
 *  asks, because every other ambiguity in this library reduces to it. */
export type SegmentRole =
  | "person"     // a contributor's folder
  | "phase"      // a slot in the running order
  | "wrapper"    // structural only: Named, Anon, Shared, Albums, Youtube
  | "album"      // a full album listened to as a unit
  | "ignore"     // not part of the catalogue
  | "unknown";   // not yet answered -- tracks still appear, just unattributed

/** Canonical arc position. The library's own vocabulary is inconsistent
 *  ("come up"/"intro"/"warmup"), so raw labels are always kept alongside. */
export type PhaseBucket = "early" | "peak" | "late" | "afterglow" | "other";

/** A night, or a standing collection.
 *
 *  Collections (`favs`, `mix`, `Albums`...) are top-level folders that are not
 *  nights at all. They stay browsable and searchable but are kept out of the
 *  timeline, because sorting a decade of events by date is useless if five
 *  undated piles sit at the end of it. */
export type EventKind = "event" | "collection";

export interface Event {
  id: string;              // "2018-02-03" or a slug when undated
  folder: string;          // top-level directory as it exists on disk
  folders: string[];       // every folder feeding this event -- a night can
                           // have a named and an anonymised folder side by side
  kind: EventKind;
  /** Normalised kinds of night, from the joke folder names: "Rollenbollen" is
   *  a roll, "Flipperen" a candyflip, "Roll&CandyFlip" both. */
  types: string[];
  date: string | null;     // ISO date, null when the folder carries none
  title: string;           // "Rollenbollen", "Flipperen", "" when unnamed
  type: string | null;     // "Roll" / "Trip" -- from folder suffix or album tag
  trackCount: number;
  /** Tracks that were actually played. `trackCount` counts every file, so a
   *  contributor's anonymised list and its named twin -- one playlist -- add up
   *  to two; this counts it once. */
  playedCount: number;
  /** Running time of what was played, seconds. A playlist is counted once, not
   *  once per copy: counting both twins made 2024-05-04 look like 16 hours when
   *  it ran 6. */
  durationSec: number;
  people: string[];
  /** Songs heard here for the first time in the library's history. */
  debuts: number;
  undated: boolean;
  provenance: Provenance;
}

/** A piece of music, independent of how many times it was played or which
 *  spelling a given file used.
 *
 *  Identity is case- and punctuation-insensitive, and named variants -- (Live),
 *  (Remix), (Acoustic) -- fold into the work they are a variant of. Brackets
 *  that carry real meaning do not: "Shine On You Crazy Diamond (Parts I-V)" and
 *  "(Parts VI-IX)" are different pieces and stay apart. */
export interface Song {
  id: string;
  artist: string;          // most common spelling
  title: string;           // most common spelling of the base title
  variants: string[];      // "Live", "Remix" -- empty when only the plain form exists
  plays: number;           // files in the catalogue
  nights: string[];        // event ids, chronological
  people: string[];        // who brought it
  firstPlayed: string | null;
  lastPlayed: string | null;
}

export interface ArtistEntry {
  id: string;
  name: string;
  plays: number;
  songs: number;
  nights: string[];
  people: string[];
  firstPlayed: string | null;
  lastPlayed: string | null;
}

export interface Person {
  id: string;              // slug of the canonical name
  name: string;            // "Dov"
  aliases: string[];       // ["Timmeh"] -- folder spellings folded into this
  trackCount: number;
  eventCount: number;
  isYou: boolean;          // Cal, surfaced differently in the UI
}

export interface Phase {
  id: string;              // eventId + person + label
  eventId: string;
  personId: string | null;
  label: string;           // raw folder text, e.g. "2. EEEEEeeEEeeEEiiiikenHOUT"
  clean: string;           // label with ordering prefix stripped
  bucket: PhaseBucket;
  order: number | null;    // from a leading "1."/"01 -"/"2 " prefix
  minutes: number | null;  // from a trailing count, e.g. "Mid 75"
  trackCount: number;
  /** Where this phase falls in its contributor's list, 0-based. Deduced by the
   *  distiller so the page never has to re-guess: "1 - 2 - 3", "I - II - III"
   *  and "intro - peak - outro - afterglow" all end up on one scale. */
  position: number;
  /** What the position rests on. A number or roman numeral in the name is firm;
   *  a word ("Post", "Afterglow") places it by where that word sits in a night;
   *  "crawl" means nothing in the name said, so folder order was kept. */
  basis: "number" | "word" | "crawl";
  /** True for a phase nobody named: the loose tracks of a list that also has an
   *  Afterglow folder are its body, and are shown as one. */
  inferred: boolean;
}

/** Reasons a track is unusual. Flags never remove a track from the catalogue;
 *  they let the UI explain it and let search exclude it by default. */
export type TrackFlag =
  | "anon"          // anonymised copy: stripped tags, nonsense naming
  | "stray"         // loose in an event root, no person or phase folder
  | "album"         // part of a full album played as a unit
  | "video"         // not an audio file
  | "untagged"      // no usable metadata
  | "duplicate"     // same artist+title already present in this event
  | "copy";         // the same track filed a second time in one contributor's list

/** What the file itself is. Absent for a track that exists only in a Spotify
 *  playlist -- there is no file to describe. */
export interface Audio {
  /** The file extension without its dot: "mp3", "flac", "m4a". */
  format: string;
  lossless: boolean;
  /** Average bitrate in kilobits a second; null when the file would not say. */
  kbps: number | null;
  sampleRate: number | null;
  bits: number | null;
}

export interface Track {
  id: string;
  eventId: string;
  personId: string | null;
  phaseId: string | null;
  artist: string | null;
  title: string | null;
  album: string | null;
  genre: string | null;
  songId: string | null;
  /** The other copy of this track: the anonymised one for a named track, the
   *  named one for an anonymised track. Paired by running time -- the two lists
   *  hold the same audio -- and left unpaired when that is ambiguous. */
  twinId: string | null;
  /** Where it fell in that contributor's set. The anonymised list is what was
   *  played, so its numbering also orders its named twin. */
  playOrder: number | null;
  /** "Live", "Remix"... when this file is a named variant of its song. */
  variant: string | null;
  /** Set when a Spotify playlist lists this track: either the track exists only
   *  there (`source` is "spotify") or a file was matched to it. */
  spotifyUri?: string;
  audio?: Audio;
  durationSec: number | null;
  ext: string;
  sizeBytes: number;
  path: string[];          // segments, exactly as the crawl recorded them
  source: string;          // which crawl this track came from
  /** True for exactly the tracks counted in the event's `playedCount` and
   *  `durationSec`: a playlist once, not once per anonymised/named copy. */
  played: boolean;
  flags: TrackFlag[];
  provenance: Provenance;
}

/** One thing a human needs to decide. The catalogue is already usable without
 *  an answer; answering improves it. */
export interface Question {
  id: string;
  kind: "segment-role" | "person-alias" | "event-date";
  subject: string;             // the folder segment or name in question
  /** Where this appears, so the answer can be judged in context. */
  examples: string[];
  occurrences: number;
  events: string[];
  /** What the distiller assumed in the absence of an answer. */
  assumed: SegmentRole | string;
  /** Ranked suggestions for the resolver UI to offer as one-click answers. */
  options: string[];
}

/** Every distinct folder segment and what the distiller decided it was.
 *  The resolver lists these so a wrong-but-confident guess can be corrected,
 *  not just the ones that came out `unknown`. */
export interface Segment {
  name: string;                 // as it appears on disk
  key: string;                  // lowercased, the rules.json key
  role: SegmentRole;
  source: Source;               // how the role was decided
  answered: boolean;            // true when a human set it in rules.json
  occurrences: number;
  events: string[];
  examples: string[];
}

export interface CatalogStats {
  tracks: number;
  events: number;
  people: number;
  artists: number;
  /** Share of tracks with a resolved person, 0-1. The number that says whether
   *  answering more questions is worth the effort. */
  personCoverage: number;
  phaseCoverage: number;
  titleCoverage: number;
  anonTracks: number;
  songs: number;
  /** Songs played on more than one night. */
  recurringSongs: number;
  recurringArtists: number;
  totalHours: number;
  flagCounts: Record<string, number>;
}

export interface Catalog {
  schema: "mdc-catalog/1";
  generatedAt: string;
  /** Every crawl folded into this catalogue. More than one because no single
   *  scan is complete: a machine that has since lost a folder is still the
   *  only record of what was in it. */
  sources: Array<{
    id: string;
    scannedAt: string;
    rootName: string;
    rootPath: string;
    machine: string;
    mediaFiles: number;
    excluded: number;
    /** Tracks whose record came from this crawl (it had the richest copy). */
    contributed: number;
    /** Tracks no other crawl has at all -- the reason to keep this one. */
    unique: number;
  }>;
  stats: CatalogStats;
  events: Event[];
  people: Person[];
  songs: Song[];
  artists: ArtistEntry[];
  phases: Phase[];
  tracks: Track[];
  segments: Segment[];
  questions: Question[];
}
