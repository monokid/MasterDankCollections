/** The pace of "play the decade": a steady sweep that eases down to read the
 *  milestones. Pure (no React, no DOM, no clock of its own): the caller feeds it
 *  elapsed real milliseconds, so tools/playpace.test.ts can run it.
 *
 *  The playhead moves at span / BASE_SECONDS per second at 1x. When it crosses a
 *  night that has milestones it dwells: the rate eases down to FLOOR (15%),
 *  holds, and eases back. The dwell is measured in real time, so a pause (the
 *  caller simply stops stepping) resumes the remainder, and speed shortens it.
 *
 *    dwell (ms) = clamp(1200 + 45 * characters, 1500, 6000) / speed
 *
 *  Nights that come in a run (the next crossing within CHAIN_GAP_MS of the last
 *  dwell ending) share one budget of CHAIN_CAP_MS / speed, so a cluster of
 *  milestone nights never stalls the play for more than 8 s at 1x. */

/** The whole decade at 1x with no dwelling, in seconds (it was 26 before). */
export const BASE_SECONDS = 60;
export const SPEEDS = [0.5, 1, 2, 4] as const;
export const FLOOR = 0.15;
export const DWELL_BASE_MS = 1200;
export const DWELL_PER_CHAR_MS = 45;
export const DWELL_MIN_MS = 1500;
export const DWELL_MAX_MS = 6000;
export const CHAIN_CAP_MS = 8000;
export const CHAIN_GAP_MS = 1500;
const EASE_IN_MS = 350;
const EASE_OUT_MS = 500;
const SUBSTEP_MS = 16;

/** Real milliseconds to dwell on a night whose visible milestone text is `chars` long. */
export function dwellMs(chars: number, speed: number): number {
  const base = Math.min(DWELL_MAX_MS, Math.max(DWELL_MIN_MS, DWELL_BASE_MS + DWELL_PER_CHAR_MS * Math.max(0, chars)));
  return base / Math.max(speed, 0.01);
}

/** Share of full speed, `elapsed` ms into a dwell of `total` ms: eases down, holds, eases back. */
export function paceFactor(elapsed: number, total: number): number {
  if (total <= 0 || elapsed < 0 || elapsed >= total) return 1;
  const inMs = Math.min(EASE_IN_MS, total * 0.25), outMs = Math.min(EASE_OUT_MS, total * 0.3);
  const smooth = (u: number) => u * u * (3 - 2 * u);
  let depth = 1;                                    // 0 = full speed, 1 = at the floor
  if (elapsed < inMs) depth = smooth(elapsed / inMs);
  else if (elapsed > total - outMs) depth = smooth((total - elapsed) / outMs);
  return 1 - (1 - FLOOR) * depth;
}

export interface Stop { pos: number; chars: number }
export interface PaceOptions { speed: number; pause: boolean }
export interface PaceResult {
  pos: number;
  done: boolean;
  /** Indices (into stops) crossed during this step, in order. */
  crossed: number[];
}

export function createPacer(o: { start: number; end: number; stops: Stop[]; baseSeconds?: number }) {
  const { start, end } = o;
  const stops = [...o.stops].sort((a, b) => a.pos - b.pos);
  const perMs = (end - start) / ((o.baseSeconds ?? BASE_SECONDS) * 1000);
  let pos = start, next = 0;
  let elapsed = 0, total = 0;                 // the current dwell; total 0 = not dwelling
  let chain = 0, free = Infinity;             // dwell spent in this run of nights; real ms since the last dwell ended

  const reset = () => { elapsed = 0; total = 0; chain = 0; free = Infinity; };
  const seek = (p: number) => {
    pos = Math.min(end, Math.max(start, p));
    next = stops.findIndex((s) => s.pos > pos);
    if (next < 0) next = stops.length;
    reset();                                  // jumping about cancels whatever was dwelling
  };

  function cross(i: number, speed: number) {
    if (free >= CHAIN_GAP_MS) chain = 0;
    const cap = CHAIN_CAP_MS / speed;
    const add = Math.max(0, Math.min(dwellMs(stops[i].chars, speed), cap - chain));
    if (add <= 0) return;
    chain += add;
    if (total > 0) total += add;              // already dwelling: stay a little longer
    else { elapsed = 0; total = add; }
    free = 0;
  }

  function step(dtMs: number, { speed, pause }: PaceOptions): PaceResult {
    const crossed: number[] = [];
    let left = Math.max(0, dtMs);
    while (left > 0) {
      const h = Math.min(left, SUBSTEP_MS);
      left -= h;
      const f = pause && total > 0 ? paceFactor(elapsed, total) : 1;
      pos += h * perMs * speed * f;
      if (total > 0) { elapsed += h; if (elapsed >= total) { elapsed = 0; total = 0; free = 0; } }
      else free += h;
      if (pos >= end) { pos = end; return { pos, done: true, crossed }; }
      while (next < stops.length && stops[next].pos <= pos) {
        if (pause) cross(next, speed);
        crossed.push(next++);
      }
    }
    return { pos, done: false, crossed };
  }

  return {
    step, seek,
    get pos() { return pos; },
    /** Null when moving freely; otherwise how far into the dwell and how long it is, in ms. */
    get dwell(): { elapsed: number; total: number } | null { return total > 0 ? { elapsed, total } : null; },
  };
}
