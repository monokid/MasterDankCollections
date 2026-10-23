/** Lookup tables over a catalogue, built once per catalogue object.
 *  Components used to `find()` through thousands of tracks on every render;
 *  they ask this instead. Keyed by the catalogue itself, so a new catalogue
 *  (a new unlock) gets fresh tables and the old ones are collected. */
import type { ArtistEntry, Catalog, Event, Person, Phase, Song, Track } from "./catalog.ts";

export interface CatalogIndex {
  track: Map<string, Track>;
  event: Map<string, Event>;
  person: Map<string, Person>;
  phase: Map<string, Phase>;
  song: Map<string, Song>;
  artist: Map<string, ArtistEntry>;
  /** Every track of an event, in catalogue order. */
  tracksOfEvent: Map<string, Track[]>;
}

const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
const cache = new WeakMap<Catalog, CatalogIndex>();

export function catalogIndex(cat: Catalog): CatalogIndex {
  let ix = cache.get(cat);
  if (!ix) {
    const tracksOfEvent = new Map<string, Track[]>();
    for (const t of cat.tracks) {
      const list = tracksOfEvent.get(t.eventId);
      if (list) list.push(t); else tracksOfEvent.set(t.eventId, [t]);
    }
    ix = {
      track: byId(cat.tracks), event: byId(cat.events), person: byId(cat.people),
      phase: byId(cat.phases), song: byId(cat.songs), artist: byId(cat.artists),
      tracksOfEvent,
    };
    cache.set(cat, ix);
  }
  return ix;
}
