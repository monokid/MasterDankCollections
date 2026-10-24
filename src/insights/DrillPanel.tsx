/** The drilldown beside the charts. The six original kinds (song, artist, person,
 *  year, night, genre) are drawn by src/Drill.tsx; every newer kind is drawn
 *  here, from ONE registry below.
 *
 *  Adding a kind: put it in the `Drill` union (./types.ts), then add one entry to
 *  REGISTRY. An entry needs a `head`; if it can also say which nights (`nights`)
 *  or songs (`songs`) lie behind the number, the generic body lists them, with a
 *  CSV download and a click-through to each. Give it a `Body` only when a list
 *  is not enough. The compiler fails the build until every kind has its entry. */
import { useEffect, useMemo, useRef, type ComponentType } from "react";
import type { Catalog } from "../catalog.ts";
import type { Range } from "../analytics.ts";
import type { EnrichMap } from "../enrich.ts";
import { decadeOf, familyOf, yearOf } from "../enrich.ts";
import type { Trace } from "../Timeline.tsx";
import LegacyDrill, { drillName, type Drill as BaseDrill } from "../Drill.tsx";
import { BarChart } from "../charts.tsx";
import {
  MONTHS, WEEKDAYS, formatKpi, kpiLabel, kpiReport, nightValue, weekdayOf,
  type KpiReport, type NightRow,
} from "../insightstats.ts";
import { fmtDate, fmtCount, plural } from "../format.ts";
import { lookups, csvFilename, downloadText, toCsv, type Cell, type Lookups } from "../pagehelpers.ts";
import { CloseIcon, DownloadIcon } from "../icons.tsx";
import type { Drill } from "./types.ts";

/** Everything an entry may need. */
export interface DrillCtx {
  cat: Catalog;
  range: Range | null;
  enrich: EnrichMap | null;
  /** The figures for the range, with the nights they are made of. */
  report: KpiReport;
  lk: Lookups;
  onDrill: (d: Drill) => void;
  onRange: (r: Range | null) => void;
  onOpenNight: (id: string) => void;
}

type NewDrill = Exclude<Drill, BaseDrill>;
type NewKind = NewDrill["kind"];
type Of<K extends NewKind> = Extract<Drill, { kind: K }>;

interface Head { kicker: string; title: string; sub?: string }

interface DrillEntry<D> {
  head: (d: D, cat: Catalog) => Head;
  /** The nights behind the number, within the range. */
  nights?: (d: D, c: DrillCtx) => NightRow[];
  /** The songs behind the number (id, on how many of those nights). */
  songs?: (d: D, c: DrillCtx) => Array<{ id: string; n: number }>;
  stats?: (d: D, c: DrillCtx, nights: NightRow[]) => Array<[string | number, string]>;
  note?: (d: D, c: DrillCtx) => string | undefined;
  /** Replaces the generic list body. */
  Body?: ComponentType<{ d: D; c: DrillCtx }>;
}

// ---------------------------------------------------------------- helpers

const inYear = (rows: NightRow[], year?: string) => (year ? rows.filter((r) => r.year === year) : rows);
const avg = (rows: NightRow[], f: (r: NightRow) => number) =>
  rows.length ? rows.reduce((a, r) => a + f(r), 0) / rows.length : 0;
const stdStats = (_: unknown, __: DrillCtx, ns: NightRow[]): Array<[string | number, string]> => [
  [ns.length, "nights"], [fmtCount(ns.reduce((a, r) => a + r.plays, 0)), "plays"],
  [avg(ns, (r) => r.people).toFixed(1), "people / night"],
  [ns.length ? `${Math.round(avg(ns, (r) => r.minutes ?? 0))}` : "–", "min / night"],
];

/** "weekday:2", "month:7", "size:4" narrow a figure to a slice. */
function bucketFilter(bucket: string | undefined): ((r: NightRow) => boolean) | null {
  const m = /^(weekday|month|size|year):(\d+)$/.exec(bucket ?? "");
  if (!m) return null;
  const v = +m[2];
  switch (m[1]) {
    case "weekday": return (r) => weekdayOf(r.date) === v;
    case "month": return (r) => +r.date.slice(5, 7) === v;
    case "size": return (r) => r.people === v;
    default: return (r) => +r.year === v;
  }
}

/** Songs (and the nights they were on) that satisfy `keep`, from the range's nights. */
function songsWhere(c: DrillCtx, keep: (songId: string) => boolean) {
  const n = new Map<string, number>();
  const rows: NightRow[] = [];
  for (const r of c.report.nights) {
    let hit = false;
    for (const s of r.songIds) if (keep(s)) { n.set(s, (n.get(s) ?? 0) + 1); hit = true; }
    if (hit) rows.push(r);
  }
  return { rows, songs: [...n.entries()].map(([id, k]) => ({ id, n: k })).sort((a, b) => b.n - a.n) };
}

const ENRICH_NOTE = "Only songs matched to a public music database have this; the rest are not counted here.";

// --------------------------------------------------------------- registry

const REGISTRY: { [K in NewKind]: DrillEntry<Of<K>> } = {
  metric: {
    head: (d) => ({ kicker: "figure", title: d.year ? `${kpiLabel(d.id)}, ${d.year}` : kpiLabel(d.id) }),
    nights: (d, c) => {
      const b = bucketFilter(d.bucket);
      return inYear(c.report.nights, d.year).filter((r) => !b || b(r));
    },
    Body: MetricBody,
  },
  month: {
    head: (d) => ({ kicker: "month", title: MONTHS[d.month - 1] ?? `Month ${d.month}`, sub: d.year ? d.year : "all years in the range" }),
    nights: (d, c) => inYear(c.report.nights, d.year).filter((r) => +r.date.slice(5, 7) === d.month),
    stats: stdStats,
  },
  weekday: {
    head: (d) => ({ kicker: "day of the week", title: WEEKDAYS[d.day] ?? `Day ${d.day}`, sub: d.year ? d.year : "all years in the range" }),
    nights: (d, c) => inYear(c.report.nights, d.year).filter((r) => weekdayOf(r.date) === d.day),
    stats: stdStats,
  },
  size: {
    head: (d) => ({ kicker: "night size", title: plural(d.size, "person", "people"), sub: d.year ? d.year : "nights with exactly this many people" }),
    nights: (d, c) => inYear(c.report.nights, d.year).filter((r) => r.people === d.size),
    stats: stdStats,
  },
  decade: {
    head: (d) => ({ kicker: "release decade", title: d.decade, sub: "songs played, by the year they were released" }),
    songs: (d, c) => songsWhere(c, (s) => decadeOf(yearOf(c.enrich?.[s])) === d.decade).songs,
    nights: (d, c) => songsWhere(c, (s) => decadeOf(yearOf(c.enrich?.[s])) === d.decade).rows,
    stats: stdStats,
    note: (_, c) => (c.enrich ? ENRICH_NOTE : "Release years are not loaded, so there is nothing to show here."),
  },
  family: {
    head: (d) => ({ kicker: "genre family", title: d.family, sub: "songs played in this family" }),
    songs: (d, c) => songsWhere(c, (s) => familyOf(c.enrich?.[s]) === d.family).songs,
    nights: (d, c) => songsWhere(c, (s) => familyOf(c.enrich?.[s]) === d.family).rows,
    stats: stdStats,
    note: (_, c) => (c.enrich ? ENRICH_NOTE : "Genre families are not loaded, so there is nothing to show here."),
  },
};

/** A short name for a level, for the Back button. */
export function drillLabel(cat: Catalog, d: Drill): string {
  if (isNew(d)) return (REGISTRY[d.kind].head as (d: Drill, cat: Catalog) => Head)(d, cat).title;
  return drillName(cat, d);
}

const isNew = (d: Drill): d is NewDrill => d.kind in REGISTRY;

// ------------------------------------------------------------ generic body

function nightsCsv(name: string, rows: NightRow[], tag: string) {
  const header = ["date", "night", "songs", "plays", "minutes", "people", "new songs", "heard before"];
  const body: Cell[][] = rows.map((r) => [r.date, r.title, r.songs, r.plays, r.minutes === null ? null : Math.round(r.minutes), r.people, r.opening ? null : r.fresh, r.opening ? null : r.returning]);
  downloadText(csvFilename(name, tag), toCsv(header, body));
}

function NightsTable({ rows, c, name, highlight }: { rows: NightRow[]; c: DrillCtx; name: string; highlight?: (r: NightRow) => string }) {
  const tag = c.range ? `${c.range.from}_${c.range.to}` : "";
  if (!rows.length) return <div className="dr-note">No nights.</div>;
  return (
    <>
      <div className="dr-actions">
        <button className="dr-btn ghost" onClick={() => nightsCsv(name, rows, tag)}><DownloadIcon size={13} /> CSV</button>
      </div>
      <table className="dr-table">
        <thead><tr><th scope="col">Night</th><th scope="col">Songs</th><th scope="col">Length</th><th scope="col">People</th>{highlight && <th scope="col">Figure</th>}</tr></thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.id}>
              <th scope="row">
                <button className="dr-link" onClick={() => c.onOpenNight(r.id)} title="Open the night">
                  {fmtDate(r.date)}{r.title && <i>{r.title}</i>}
                </button>
              </th>
              <td>{r.songs}</td>
              <td>{r.minutes === null ? "–" : `${Math.round(r.minutes)} min`}</td>
              <td>{r.people}</td>
              {highlight && <td>{highlight(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

// The entry and the drill always agree (REGISTRY is keyed by kind), which the type cannot say.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function GenericBody({ entry, d, c }: { entry: DrillEntry<any>; d: NewDrill; c: DrillCtx }) {
  const rows = useMemo(() => entry.nights?.(d, c) ?? [], [entry, d, c]);
  const songs = useMemo(() => entry.songs?.(d, c) ?? [], [entry, d, c]);
  const stats = entry.stats?.(d, c, rows);
  const note = entry.note?.(d, c);
  return (
    <>
      {stats && (
        <div className="dr-stats">
          {stats.map(([v, k]) => <div key={k}><b>{v}</b><span>{k}</span></div>)}
        </div>
      )}
      {note && <div className="dr-note">{note}</div>}
      {songs.length > 0 && (
        <>
          <h3>Songs</h3>
          {songs.slice(0, 40).map((s) => (
            <button key={s.id} className="dr-item" onClick={() => c.onDrill({ kind: "song", id: s.id })}>
              <span className="l">{c.lk.songs.get(s.id)?.title ?? s.id}<i>{c.lk.songs.get(s.id)?.artist}</i></span>
              <span className="v">{plural(s.n, "night")}</span>
            </button>
          ))}
        </>
      )}
      <h3>Nights</h3>
      <NightsTable rows={rows} c={c} name={entry.head(d, c.cat).title} />
    </>
  );
}

// ------------------------------------------------------------ metric body

function MetricBody({ d, c }: { d: Of<"metric">; c: DrillCtx }) {
  const k = c.report.byId[d.id];
  const rows = useMemo(() => REGISTRY.metric.nights!(d, c), [d, c]);
  const point = d.year ? k.yearSeries.find((p) => p.year === d.year) : undefined;
  const value = point ? point.value : k.value;
  const bucket = d.bucket && bucketFilter(d.bucket) ? d.bucket : null;
  const data = k.yearSeries.map((p) => ({
    key: p.year, label: p.year, values: [p.value], highlight: p.year === d.year,
    note: p.nights ? [`${plural(p.nights, "night")}`] : ["no nights this year"],
  }));
  return (
    <>
      <div className="dr-stats">
        <div><b>{formatKpi(k.format, value)}</b><span>{d.year ?? "whole range"}</span></div>
        {k.median !== undefined && !d.year && <div><b>{formatKpi(k.format, k.median)}</b><span>median</span></div>}
        <div><b>{rows.length}</b><span>nights</span></div>
        {k.deltaVsPrev && !d.year && <div className="wide"><b>{k.deltaVsPrev.short}</b><span>last full year</span></div>}
      </div>
      <div className="dr-note">{k.sentence}{bucket && ` Narrowed to ${bucket.replace(":", " ")}.`}</div>
      {k.yearSeries.length > 1 && (
        <>
          <h3>By year</h3>
          <BarChart data={data} height={150} average={k.value ?? null} avgLabel="range"
            format={(v) => formatKpi(k.format, v)} ariaLabel={`${k.label} by year`}
            onSelect={(p) => c.onDrill({ kind: "metric", id: d.id, year: p.key })} />
        </>
      )}
      {d.year && (
        <div className="dr-actions">
          <button className="dr-btn ghost" onClick={() => c.onDrill({ kind: "metric", id: d.id })}>all years</button>
          <button className="dr-btn" onClick={() => c.onRange({ from: `${d.year}-01-01`, to: `${d.year}-12-31` })}>focus Insights on {d.year} →</button>
        </div>
      )}
      <h3>Nights behind it</h3>
      <NightsTable rows={rows} c={c} name={`${k.label}${d.year ? " " + d.year : ""}`}
        highlight={(r) => formatKpi(k.format, nightValue(d.id, r))} />
    </>
  );
}

// ------------------------------------------------------------------ panel

export interface InsightsDrillProps {
  cat: Catalog;
  drill: Drill;
  range: Range | null;
  enrich: EnrichMap | null;
  canBack: boolean;
  backLabel?: string;
  onBack: () => void;
  onClose: () => void;
  onDrill: (d: Drill) => void;
  onTrace: (t: Trace) => void;
  onRange: (r: Range | null) => void;
  onOpenNight: (id: string) => void;
}

export default function InsightsDrill(props: InsightsDrillProps) {
  if (!isNew(props.drill)) return <LegacyDrill {...props} drill={props.drill} />;
  return <NewKindPanel {...props} drill={props.drill} />;
}

function NewKindPanel(props: InsightsDrillProps & { drill: NewDrill }) {
  const { cat, drill, range, enrich, canBack, backLabel, onBack, onClose, onDrill, onRange, onOpenNight } = props;
  const asideRef = useRef<HTMLElement>(null);
  const trigger = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const key = JSON.stringify(drill);

  // Same manners as the original panel: focus moves in, returns on close, Esc closes.
  useEffect(() => { asideRef.current?.focus({ preventScroll: true }); }, [key]);
  useEffect(() => () => {
    const t = trigger.current as HTMLElement | null;
    if (t && t !== document.body && t.isConnected) t.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.key !== "Escape" || k.defaultPrevented) return;
      const t = k.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      k.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const c = useMemo<DrillCtx>(() => ({
    cat, range, enrich, report: kpiReport(cat, range), lk: lookups(cat), onDrill, onRange, onOpenNight,
  }), [cat, range, enrich, onDrill, onRange, onOpenNight]);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entry = REGISTRY[drill.kind] as DrillEntry<any>;
  const head = entry.head(drill, cat);
  const Body = entry.Body;
  return (
    <aside className="drill" aria-label={`Detail: ${head.kicker} ${head.title}`} ref={asideRef} tabIndex={-1}>
      <div className="dr-head">
        {canBack && (
          <button className="dr-back" onClick={onBack}
            aria-label={backLabel ? `Back to ${backLabel}` : "Back"} title={backLabel ? `Back to ${backLabel}` : "Back"}>←</button>
        )}
        <div className="dr-titles">
          <div className="dr-kicker">{head.kicker}</div>
          <div className="dr-title" role="heading" aria-level={2}>{head.title}</div>
          {head.sub && <div className="dr-sub">{head.sub}</div>}
        </div>
        <button className="np-x" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)"><CloseIcon size={14} /></button>
      </div>
      <div className="dr-body">
        {Body ? <Body d={drill} c={c} /> : <GenericBody entry={entry} d={drill} c={c} />}
      </div>
    </aside>
  );
}
