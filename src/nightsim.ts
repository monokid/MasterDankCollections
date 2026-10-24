/** "Simulated night": everyone's played songs laid out as ONE running playlist.
 *  Pure (no React) so tools/nightsim.test.ts can run it.
 *
 *  What is known: on a night each person's list was played in phases, and inside a
 *  phase the songs came in random order, mixed across the people. What is not known:
 *  the real order inside a phase. So this is one plausible version, not a record.
 *
 *  PHASE MAPPING (people name their phases differently; the data has 126 phases on
 *  18 nights, and of the 112 phases on nights where several people have phases, 92
 *  carry a label another person also uses -- "main", "afterglow", "post", "peak"):
 *    1. Each person's phases (those with played songs) are ordered by `position` and
 *       given a place on a 0..1 scale: i / (n - 1); a person with one phase sits at 0.5.
 *    2. A label (lower-cased, letters and digits only) used by two or more people is
 *       ONE shared phase, placed at the mean of its owners' places. Any other phase
 *       keeps its own place.
 *    3. The night has N slots, N = the most phases any one person has. A phase goes
 *       to slot round(place * (N - 1)). Empty slots are dropped; phases that land in
 *       the same slot are one block of the simulated night.
 *  Songs in no phase go to a separate block after the phases, with no clock time. */
import type { Phase, Track } from "./catalog.ts";

export const MAPPING_RULE =
  "Phases are matched by name where several people use the same one, otherwise by their place " +
  "in each person's own list, scaled to the night's longest list.";

export interface SimRow {
  track: Track;
  /** Seconds since the start of the first phase; null for songs of unknown time. */
  startSec: number | null;
  durSec: number;
  /** The length is not known and stands in as the night's median. */
  estimated: boolean;
  /** The start time rests on at least one stand-in length before it. */
  startApprox: boolean;
}

export interface SimBlock {
  key: string;
  kind: "phase" | "whole" | "loose";
  /** Distinct phase names that landed here, in first-seen order. */
  labels: string[];
  /** Contributors, most songs first; "" is the person-less pile. */
  personIds: string[];
  rows: SimRow[];
  seconds: number;
  /** How many of those rows have a stand-in length. */
  estimatedRows: number;
}

export interface Sim {
  blocks: SimBlock[];
  /** False when no phase was recorded: one "whole night" block stands in. */
  phased: boolean;
  seed: number;
  songs: number;
  /** Length of the timed blocks (phases, or the whole night). */
  timedSeconds: number;
  /** Length of the songs with no phase. */
  looseSeconds: number;
  totalSeconds: number;
  medianSec: number;
  /** Rows whose length is a stand-in. */
  estimatedRows: number;
  looseSongs: number;
}

// ------------------------------------------------------------------- random

/** 32-bit string hash (FNV-1a). */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Small seeded generator: the same seed always gives the same stream. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates on a copy. The input is sorted by id first, so the result depends on
 *  the set of tracks and the seed, never on the order they were handed in. */
export function seededShuffle<T extends { id: string }>(xs: readonly T[], seedKey: string): T[] {
  const a = [...xs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const rnd = mulberry32(hash32(seedKey));
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ------------------------------------------------------------- phase mapping

const normLabel = (p: Pick<Phase, "clean" | "label">) =>
  (p.clean || p.label).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** phase id -> slot index (0-based, before empty slots are dropped), plus N. */
export function mapPhases(phases: Phase[], playedPhaseIds: Set<string>): { slotOf: Map<string, number>; slots: number } {
  const used = phases.filter((p) => playedPhaseIds.has(p.id));
  const byPerson = new Map<string, Phase[]>();
  for (const p of used) {
    const k = p.personId ?? "";
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k)!.push(p);
  }
  const place = new Map<string, number>();
  let slots = 0;
  for (const list of byPerson.values()) {
    list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
    slots = Math.max(slots, list.length);
    list.forEach((p, i) => place.set(p.id, list.length === 1 ? 0.5 : i / (list.length - 1)));
  }
  // Labels several people share are one phase, placed at the mean of its owners.
  const owners = new Map<string, { people: Set<string>; sum: number; n: number }>();
  for (const p of used) {
    const k = normLabel(p);
    const o = owners.get(k) ?? { people: new Set<string>(), sum: 0, n: 0 };
    o.people.add(p.personId ?? ""); o.sum += place.get(p.id)!; o.n++;
    owners.set(k, o);
  }
  const slotOf = new Map<string, number>();
  for (const p of used) {
    const o = owners.get(normLabel(p))!;
    const at = o.people.size > 1 ? o.sum / o.n : place.get(p.id)!;
    slotOf.set(p.id, Math.round(at * Math.max(0, slots - 1)));
  }
  return { slotOf, slots };
}

// ---------------------------------------------------------------- simulation

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** Only `played` tracks count, exactly as the real lists do: copies and anonymised
 *  twins are left out, each song once. */
export function simulateNight(eventId: string, tracks: Track[], phases: Phase[], seed: number): Sim {
  const played = tracks.filter((t) => t.played);
  const phaseById = new Map(phases.map((p) => [p.id, p]));
  const inPhase = (t: Track) => !!t.phaseId && phaseById.has(t.phaseId);
  const known = played.map((t) => t.durationSec).filter((s): s is number => !!s && s > 0);
  const medianSec = Math.round(median(known));
  const lenOf = (t: Track) => (t.durationSec && t.durationSec > 0
    ? { sec: t.durationSec, est: false } : { sec: medianSec, est: true });

  const { slotOf } = mapPhases(phases, new Set(played.filter(inPhase).map((t) => t.phaseId!)));
  const phased = slotOf.size > 0;

  const groups = new Map<number, { tracks: Track[]; labels: string[] }>();
  const loose: Track[] = [];
  for (const t of played) {
    if (!phased) continue;
    if (!inPhase(t)) { loose.push(t); continue; }
    const s = slotOf.get(t.phaseId!)!;
    const g = groups.get(s) ?? { tracks: [], labels: [] };
    g.tracks.push(t);
    const name = phaseById.get(t.phaseId!)!.clean;
    // "Peak" and "peak" are one name; the first spelling seen is shown.
    if (name && !g.labels.some((l) => l.toLowerCase() === name.toLowerCase())) g.labels.push(name);
    groups.set(s, g);
  }

  const who = (ts: Track[]) => {
    const c = new Map<string, number>();
    for (const t of ts) c.set(t.personId ?? "", (c.get(t.personId ?? "") ?? 0) + 1);
    return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([p]) => p);
  };
  let clock = 0, approx = false;
  const lay = (key: string, kind: SimBlock["kind"], ts: Track[], labels: string[], timed: boolean): SimBlock => {
    const order = seededShuffle(ts, `${eventId}|${seed}|${key}`);
    let seconds = 0, estimatedRows = 0;
    const rows = order.map((track): SimRow => {
      const { sec, est } = lenOf(track);
      const row = {
        track, startSec: timed ? clock + seconds : null, durSec: sec, estimated: est,
        startApprox: timed && (approx || estimatedRows > 0),
      };
      seconds += sec;
      if (est) estimatedRows++;
      return row;
    });
    if (timed) { clock += seconds; approx = approx || estimatedRows > 0; }
    return { key, kind, labels, personIds: who(ts), rows, seconds, estimatedRows };
  };

  const blocks: SimBlock[] = [];
  if (!phased) {
    if (played.length) blocks.push(lay("whole", "whole", played, [], true));
  } else {
    for (const s of [...groups.keys()].sort((a, b) => a - b)) {
      const g = groups.get(s)!;
      blocks.push(lay(`slot${s}`, "phase", g.tracks, g.labels, true));
    }
  }
  const timedSeconds = blocks.reduce((n, b) => n + b.seconds, 0);
  if (loose.length) blocks.push(lay("loose", "loose", loose, [], false));
  const looseSeconds = blocks.filter((b) => b.kind === "loose").reduce((n, b) => n + b.seconds, 0);
  return {
    blocks, phased, seed, songs: played.length, timedSeconds, looseSeconds,
    totalSeconds: timedSeconds + looseSeconds, medianSec,
    estimatedRows: blocks.reduce((n, b) => n + b.estimatedRows, 0), looseSongs: loose.length,
  };
}

// --------------------------------------------------------------- text output

/** "0:00", "12:05", "1:02:03". Rounds the whole value first. */
export function fmtClock(sec: number): string {
  const t = Math.max(0, Math.round(sec)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** Plain-text setlist with the running clock; "~" marks a stand-in length. */
export function simText(sim: Sim, nameOf: (personId: string | null) => string, blockTitle: (b: SimBlock) => string): string {
  const out: string[] = [`Simulated night (shuffle ${sim.seed}): one plausible order, not a record`];
  for (const b of sim.blocks) {
    out.push("", `${blockTitle(b)} (${fmtClock(b.seconds)})`);
    for (const r of b.rows) {
      const t = r.track;
      const name = t.title ? (t.artist ? `${t.artist} - ${t.title}` : t.title) : "unnamed track";
      const at = r.startSec === null ? "-" : `${r.startApprox ? "~" : ""}${fmtClock(r.startSec)}`;
      out.push(`${at}  ${name}  (${nameOf(t.personId)})${r.estimated ? " ~" + fmtClock(r.durSec) : ""}`);
    }
  }
  return out.join("\n");
}
