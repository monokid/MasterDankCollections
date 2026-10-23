/** Numbers for one night's page: songs, phases and running time, per person and
 *  per phase.
 *
 *  Only tracks the distiller marked `played` count. A contributor's anonymised
 *  list and its named twin are one playlist, and a Spotify entry can duplicate a
 *  file; counting every Track would double both. */
import type { Phase, Track } from "./catalog.ts";

export interface PhaseStat {
  /** The phase id, or "" for the tracks that sit in no phase. */
  key: string;
  phase: Phase | null;
  songs: number;
  seconds: number;
  /** This phase's share of its person's running time, 0-1. */
  share: number;
}

export interface PersonStat {
  /** Only for tracks with no owner: what to call them. */
  label: string;
  personId: string | null;
  songs: number;
  /** Phases that have at least one played track. */
  phases: number;
  seconds: number;
  /** In position order; the phaseless remainder, if any, last. */
  byPhase: PhaseStat[];
}

export interface NightStats {
  persons: PersonStat[];   // most songs first
  songs: number;
  seconds: number;
  phases: number;
}

/** What to call tracks nobody owns: a shared pile ("Shared"), albums played as a
 *  unit ("Albums"), or files lying loose at the top of the night. "Unattributed"
 *  made them sound like a failure when they are usually just communal. */
export function ownerlessLabel(list: Track[]): string {
  const dirs = new Set(list.map((t) => ((t.path?.length ?? 0) > 2 ? t.path[1] : "")));
  if (dirs.size === 1) return [...dirs][0] || "Loose files";
  return "Shared & loose";
}

export function nightStats(tracks: Track[], phases: Phase[]): NightStats {
  const phaseById = new Map(phases.map((p) => [p.id, p]));
  const people = new Map<string, Track[]>();
  for (const t of tracks) {
    if (!t.played) continue;
    const k = t.personId ?? "";
    if (!people.has(k)) people.set(k, []);
    people.get(k)!.push(t);
  }

  const persons: PersonStat[] = [...people.entries()].map(([pid, list]) => {
    const groups = new Map<string, Track[]>();
    for (const t of list) {
      // A phase id we cannot look up is as good as none.
      const k = t.phaseId && phaseById.has(t.phaseId) ? t.phaseId : "";
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(t);
    }
    const seconds = sum(list);
    const byPhase = [...groups.entries()]
      .map(([key, ts]): PhaseStat => ({
        key, phase: key ? phaseById.get(key)! : null, songs: ts.length, seconds: sum(ts),
        share: seconds > 0 ? sum(ts) / seconds : ts.length / list.length,
      }))
      .sort((a, b) => (a.phase ? a.phase.position : 1e9) - (b.phase ? b.phase.position : 1e9));
    return {
      personId: pid || null, label: pid ? "" : ownerlessLabel(list), songs: list.length, seconds, byPhase,
      phases: byPhase.filter((p) => p.phase).length,
    };
  }).sort((a, b) => b.songs - a.songs);

  return {
    persons,
    songs: persons.reduce((n, p) => n + p.songs, 0),
    seconds: persons.reduce((n, p) => n + p.seconds, 0),
    phases: persons.reduce((n, p) => n + p.phases, 0),
  };
}

const sum = (ts: Track[]) => ts.reduce((n, t) => n + (t.durationSec ?? 0), 0);
