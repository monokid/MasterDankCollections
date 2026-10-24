/** The amoeba's occasional behaviours: pure scheduling, no DOM, no GL.
 *
 *  One behaviour at a time, ~2-5 s each, eased in and out, with a calm idle between.
 *  The next pick is weighted and never repeats the last one (and leans away from the
 *  one before). The shader gets `id`, `env` (eased 0..1), `progress` and `seed`. */

export const BEHAVIOURS = ["bloom", "split", "reach", "jelly", "shimmer", "sneeze"] as const;
export type BehaviourName = (typeof BEHAVIOURS)[number];

/** Relative likelihood of each pick. */
export const WEIGHT: Record<BehaviourName, number> = {
  bloom: 1.2, split: 0.8, reach: 1.2, jelly: 1, shimmer: 1.1, sneeze: 0.7,
};
/** Seconds a behaviour lasts [min, max]. */
export const DURATION: Record<BehaviourName, [number, number]> = {
  bloom: [3, 4.5], split: [4, 5], reach: [3, 4.5], jelly: [2.2, 3.2], shimmer: [3, 4.2], sneeze: [2, 3],
};
/** Calm seconds between behaviours, and before the first one. */
export const IDLE: [number, number] = [6, 14];
export const FIRST_IDLE: [number, number] = [3.5, 6];
/** The behaviour before last is this much less likely again. */
export const RECENT_PENALTY = 0.35;

const sstep = (x: number) => { const k = x < 0 ? 0 : x > 1 ? 1 : x; return k * k * (3 - 2 * k); };

/** Eased in over the first 30%, held, eased out over the last 35%. 0 at both ends. */
export function envelope(p: number): number {
  if (!(p > 0 && p < 1)) return 0;
  return sstep(p / 0.3) * sstep((1 - p) / 0.35);
}

/** The id the shader branches on: 0 for none, else 1-based index into BEHAVIOURS. */
export const behaviourId = (n: BehaviourName | null): number => (n ? BEHAVIOURS.indexOf(n) + 1 : 0);

/** Weighted pick. `last` is never chosen again straight away; `prev` is less likely. */
export function pickBehaviour(
  rand: () => number, last: BehaviourName | null, prev: BehaviourName | null = null,
  weights: Record<BehaviourName, number> = WEIGHT,
): BehaviourName {
  const w = BEHAVIOURS.map((n) => (n === last ? 0 : weights[n] * (n === prev ? RECENT_PENALTY : 1)));
  const total = w.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return BEHAVIOURS.find((n) => n !== last) ?? BEHAVIOURS[0];
  let r = Math.min(Math.max(rand(), 0), 0.999999) * total;
  for (let i = 0; i < w.length; i++) {
    r -= w[i];
    if (r < 0) return BEHAVIOURS[i];
  }
  return BEHAVIOURS[BEHAVIOURS.length - 1];
}

export interface Scheduler {
  /** Advance by dt seconds (ignored unless positive and finite). */
  step(dt: number): void;
  /** Ask for a behaviour: starts at once if calm, otherwise right after the current one. */
  trigger(name: BehaviourName): void;
  readonly name: BehaviourName | null;
  readonly id: number;
  /** 0..1 through the running behaviour, else 0. */
  readonly progress: number;
  /** Eased strength 0..1, else 0. */
  readonly env: number;
  /** A fresh 0..1 number per behaviour, for its random choices. */
  readonly seed: number;
}

export function createScheduler(rand: () => number = Math.random): Scheduler {
  const span = (r: [number, number]) => r[0] + rand() * (r[1] - r[0]);
  let name: BehaviourName | null = null;
  let age = 0, dur = 1, idle = span(FIRST_IDLE), seed = 0;
  let last: BehaviourName | null = null, prev: BehaviourName | null = null;
  let pending: BehaviourName | null = null;

  function begin(n: BehaviourName) {
    name = n; age = 0; dur = span(DURATION[n]); seed = rand();
    prev = last; last = n;
  }
  return {
    step(dt) {
      if (!(dt > 0) || !Number.isFinite(dt)) return;
      if (name) {
        age += dt;
        if (age >= dur) { name = null; idle = pending ? 0 : span(IDLE); }
      } else if ((idle -= dt) <= 0) {
        const n = pending ?? pickBehaviour(rand, last, prev);
        pending = null;
        begin(n);
      }
    },
    trigger(n) { if (name) pending = n; else begin(n); },
    get name() { return name; },
    get id() { return behaviourId(name); },
    get progress() { return name ? Math.min(1, age / dur) : 0; },
    get env() { return name ? envelope(age / dur) : 0; },
    get seed() { return seed; },
  };
}
