import type { Event } from "./catalog.ts";

/** One colour per kind of night, shared by the timeline and Browse. */
export const TYPE_COLOUR: Record<string, string> = {
  roll: "#ff7ad9", trip: "#62e8ff", candyflip: "#ffc46b",
};
export const nightColour = (e: Event) =>
  e.types.map((t) => TYPE_COLOUR[t]).find(Boolean) ?? "#b98cff";

/** A person's colour is their place in `cat.people`, so the timeline lanes and
 *  every chip elsewhere agree. */
export const personColour = (i: number) => `hsl(${(i * 41 + 250) % 360} 80% 66%)`;
