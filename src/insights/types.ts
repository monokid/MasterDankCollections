/** The contract between the Insights shell and the tabs built on it.
 *
 *  A tab is `src/insights/Tab<Name>.tsx`, a default-exported component taking
 *  `TabProps`. It draws charts with src/charts.tsx, reads shared figures from
 *  `ctx`, and sends every click that should show detail to `open(drill)`. */
import type { Catalog, Event, Person, Track } from "../catalog.ts";
import type { Range } from "../analytics.ts";
import type { EnrichMap } from "../enrich.ts";
import type { Trace } from "../Timeline.tsx";
import type { Drill as BaseDrill } from "../Drill.tsx";
import type { KpiId, KpiReport } from "../insightstats.ts";

/** What a click can open. The first six are drawn by src/Drill.tsx; the rest by
 *  the registry in src/insights/DrillPanel.tsx. To add a kind: add it here, then
 *  add one entry to that registry (the compiler insists). */
export type Drill =
  | BaseDrill
  /** A headline figure. `year` narrows it to one year; `bucket` to a slice such
   *  as "weekday:2", "month:7", "size:4" (day 0 = Monday, month 1-12). */
  | { kind: "metric"; id: KpiId; year?: string; bucket?: string }
  /** A calendar month, 1-12, across all years or within `year`. */
  | { kind: "month"; month: number; year?: string }
  /** A day of the week, 0 = Monday ... 6 = Sunday. */
  | { kind: "weekday"; day: number; year?: string }
  /** Nights with this many people. */
  | { kind: "size"; size: number; year?: string }
  /** A release decade of the songs played, "1980s" (needs enrichment). */
  | { kind: "decade"; decade: string }
  /** A genre family of the songs played, "metal" (needs enrichment). */
  | { kind: "family"; family: string };

export type DrillKind = Drill["kind"];

export interface Row { label: string; sub?: string; value: number; text?: string; drill?: Drill }

export interface Agg {
  song: Map<string, { nights: Set<string>; plays: number }>;
  artist: Map<string, { nights: Set<string>; plays: number }>;
}

/** Figures every tab shares, computed once per catalogue and range. */
export interface SectionCtx {
  /** Dated nights in the range, oldest first. */
  nights: Event[];
  /** Named tracks played on them (anonymised copies are not played tracks). */
  T: Track[];
  /** What each song and artist did within the range. */
  agg: Agg;
  people: Map<string, Person>;
  /** The headline figures and the per-night rows behind them. */
  report: KpiReport;
  onOpenNight: (id: string) => void;
  onOpenSong: (songId: string) => void;
  onOpenArtist: (id: string | null) => void;
  onOpenPerson: (id: string | null) => void;
  onTrace: (t: Trace) => void;
}

export interface TabProps {
  cat: Catalog;
  /** The range every figure follows; null = the whole library. */
  range: Range | null;
  /** Null until (or unless) enrichment is available: every tab must work without it. */
  enrich: EnrichMap | null;
  ctx: SectionCtx;
  open: (d: Drill) => void;
}

/** One foldable, lazily computed block of a tab. */
export interface SectionDef {
  /** Unique across all tabs (it is remembered folded or open, and is an element id). */
  id: string;
  label: string;
  Body: import("react").ComponentType<TabProps>;
}
