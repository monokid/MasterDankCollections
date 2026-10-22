import type { Catalog, Event } from "./catalog.ts";

/** Standing piles (favs, mix, Albums...) are hidden for now. Flip this one flag
 *  to bring them back everywhere: Browse, search, lists, planner notes. */
export const SHOW_COLLECTIONS = false;

export const isShown = (e: Pick<Event, "kind">) => SHOW_COLLECTIONS || e.kind !== "collection";

/** The catalogue as the app should see it: collections removed from the events,
 *  their tracks and phases, and from every count that was built with them in.
 *  Applied once, when the catalogue loads, so no view has to remember to filter. */
export function visibleCatalog(cat: Catalog): Catalog {
  if (SHOW_COLLECTIONS) return cat;
  const events = cat.events.filter(isShown);
  if (events.length === cat.events.length) return cat;
  const ids = new Set(events.map((e) => e.id));
  const tracks = cat.tracks.filter((t) => ids.has(t.eventId));
  const phases = cat.phases.filter((p) => ids.has(p.eventId));

  const plays = new Map<string, number>();
  const who = new Map<string, Set<string>>();
  const trackPeople = new Map<string, number>();
  for (const t of tracks) {
    if (t.personId) trackPeople.set(t.personId, (trackPeople.get(t.personId) ?? 0) + 1);
    if (!t.songId) continue;
    plays.set(t.songId, (plays.get(t.songId) ?? 0) + 1);
    if (t.personId) {
      if (!who.has(t.songId)) who.set(t.songId, new Set());
      who.get(t.songId)!.add(t.personId);
    }
  }
  const songs = cat.songs
    .map((s) => ({
      ...s, nights: s.nights.filter((n) => ids.has(n)),
      plays: plays.get(s.id) ?? 0, people: [...(who.get(s.id) ?? [])],
    }))
    .filter((s) => s.nights.length > 0);
  const songsOf = new Map<string, number>();
  const playsOf = new Map<string, number>();
  for (const s of songs) {
    const a = s.id.split("|")[0];
    songsOf.set(a, (songsOf.get(a) ?? 0) + 1);
    playsOf.set(a, (playsOf.get(a) ?? 0) + s.plays);
  }
  const artists = cat.artists
    .map((a) => ({
      ...a, nights: a.nights.filter((n) => ids.has(n)), songs: songsOf.get(a.id) ?? 0,
      plays: playsOf.get(a.id) ?? 0,
    }))
    .filter((a) => a.nights.length > 0);
  const people = cat.people.map((p) => ({
    ...p,
    trackCount: trackPeople.get(p.id) ?? 0,
    eventCount: events.filter((e) => e.people.includes(p.id)).length,
  }));
  const flagCounts: Record<string, number> = {};
  for (const t of tracks) for (const f of t.flags) flagCounts[f] = (flagCounts[f] ?? 0) + 1;

  return {
    ...cat, events, tracks, phases, songs, artists, people,
    stats: {
      ...cat.stats,
      tracks: tracks.length, events: events.length, songs: songs.length,
      artists: artists.length,
      anonTracks: flagCounts.anon ?? 0, flagCounts,
      recurringSongs: songs.filter((s) => s.nights.length > 1).length,
      recurringArtists: artists.filter((a) => a.nights.length > 1).length,
      totalHours: Math.round(events.reduce((n, e) => n + e.durationSec, 0) / 3600),
    },
  };
}
