/** Moon phase from the mean synodic month -- no network, no ephemeris.
 *
 *  The mean month drifts from the true moon by up to about half a day, which is
 *  invisible at the eight-phase resolution a card shows. */

const SYNODIC = 29.530588853;                       // days, new moon to new moon
const EPOCH = Date.UTC(2000, 0, 6, 18, 14);         // a new moon (2000-01-06 18:14 UTC)
const DAY = 86400000;

export const PHASE_NAMES = [
  "New moon", "Waxing crescent", "First quarter", "Waxing gibbous",
  "Full moon", "Waning gibbous", "Last quarter", "Waning crescent",
] as const;

export interface Moon {
  /** 0..1 through the month: 0 new, 0.5 full. */
  cycle: number;
  /** Lit share of the disc, 0..1. */
  illumination: number;
  /** 0..7, an index into PHASE_NAMES. */
  phase: number;
  name: string;
  waxing: boolean;
}

export function moonAt(when: Date | number): Moon {
  const ms = typeof when === "number" ? when : when.getTime();
  const cycle = ((((ms - EPOCH) / DAY) / SYNODIC) % 1 + 1) % 1;
  const illumination = (1 - Math.cos(2 * Math.PI * cycle)) / 2;
  const phase = Math.round(cycle * 8) % 8;
  return { cycle, illumination, phase, name: PHASE_NAMES[phase], waxing: cycle < 0.5 };
}

/** The moon on a night: an evening in Belgium, about 21:00 local = 19:00 UTC. */
export function moonOnNight(iso: string): Moon {
  const [y, m, d] = iso.split("-").map(Number);
  return moonAt(Date.UTC(y, m - 1, d, 19));
}
