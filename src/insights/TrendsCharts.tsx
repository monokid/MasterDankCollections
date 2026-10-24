/** New Trends sections: compare two measures, the rolling shape of the nights,
 *  seasons, and what kind of night. Numbers come from src/trendinsights.ts;
 *  these components only draw them. Every chart says in one sentence what its
 *  numbers show (never why), carries a CSV, and is a door to the detail. */
import { memo, useMemo } from "react";
import { BarChart, ChartCard, Heatmap, LineChart, type BarDatum, type LineMarker } from "../charts.tsx";
import { fmtDate } from "../format.ts";
import { KPI_IDS, MONTHS, WEEKDAYS, formatKpi, kpiLabel, type KpiId } from "../insightstats.ts";
import { useSessionState } from "../hooks.ts";
import {
  compareKpis, compareReading, isOutlier, kindsByYear, monthCounts, monthName, monthYearGrid, neighbourZ,
  peakReading, weekdayCounts, weekdayName,
} from "../trendinsights.ts";
import type { SectionDef, TabProps } from "./types.ts";
import "../insights-trends.css";

/** Nights as small buttons that open the night: what a clicked bar or bin reveals. */
export function NightList({ title, items, onOpen }: {
  title: string; items: Array<{ id: string; date: string; detail?: string }>; onOpen: (id: string) => void;
}) {
  return (
    <>
      <p className="itr-list-head">{title}</p>
      <ul className="itr-list">
        {items.map((n) => (
          <li key={n.id}>
            <button className="itr-night" onClick={() => onOpen(n.id)} title="Open the night">
              {fmtDate(n.date)}{n.detail && <i>{n.detail}</i>}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
const SHORT_DAYS = WEEKDAYS.map((d) => d.slice(0, 3));

// ------------------------------------------------------------------- compare

interface Pick { a: KpiId; b: KpiId; smooth: boolean }

const CompareSection = memo(function CompareSection({ ctx, open }: TabProps) {
  const { report } = ctx;
  const [stored, setPick] = useSessionState<Pick>("insights.compare", { a: "songsPerNight", b: "peoplePerNight", smooth: false });
  const pick: Pick = {
    a: KPI_IDS.includes(stored.a) ? stored.a : "songsPerNight",
    b: KPI_IDS.includes(stored.b) ? stored.b : "peoplePerNight",
    smooth: !!stored.smooth,
  };
  const W = 3;
  const cmp = useMemo(() => compareKpis(report, pick.a, pick.b, pick.smooth ? W : 0), [report, pick.a, pick.b, pick.smooth]);
  const reading = useMemo(() => compareReading(report, pick.a, pick.b), [report, pick.a, pick.b]);

  // The chart plots each against its own peak, so its tooltip would only know
  // percentages. Each plotted number is made unique (a billionth apart) so the
  // tooltip can look up the real value that sits behind it.
  const { pa, pb, look } = useMemo(() => {
    const look = new Map<number, string>();
    const make = (norm: Array<number | null>, real: Array<number | null>, id: KpiId, salt: number) =>
      norm.map((n, i) => {
        if (n === null) return null;
        const v = n + (i + 1) * 1e-9 + salt;
        look.set(v, `${formatKpi(report.byId[id].format, real[i])} (${Math.round(n * 100)}% of its peak)`);
        return v;
      });
    return { pa: make(cmp.na, cmp.ra, pick.a, 0), pb: make(cmp.nb, cmp.rb, pick.b, 5e-10), look };
  }, [cmp, report, pick.a, pick.b]);

  const sel = (key: "a" | "b") => (
    <select value={pick[key]} aria-label={key === "a" ? "First measure" : "Second measure"}
      onChange={(e) => setPick({ ...pick, [key]: e.target.value as KpiId })}>
      {KPI_IDS.map((id) => <option key={id} value={id}>{kpiLabel(id)}</option>)}
    </select>
  );
  const la = kpiLabel(pick.a), lb = pick.a === pick.b ? `${kpiLabel(pick.b)} (2)` : kpiLabel(pick.b);
  const sm = pick.smooth ? ` (${W}-year average)` : "";
  return (
    <ChartCard title="Compare two measures" reading={reading}
      coverage={`${cmp.years.length} years, ${report.nights.length} nights`}
      csv={{
        header: ["year", la, lb],
        rows: cmp.years.map((y, i) => [y, cmp.a[i] === null ? null : Math.round(cmp.a[i]! * 100) / 100, cmp.b[i] === null ? null : Math.round(cmp.b[i]! * 100) / 100]),
        title: `Compare ${la} and ${lb}`,
      }}>
      <div className="itr-controls">
        <label>Compare {sel("a")}</label>
        <label>with {sel("b")}</label>
        <label><input type="checkbox" checked={pick.smooth} onChange={(e) => setPick({ ...pick, smooth: e.target.checked })} />
          {W}-year rolling average</label>
      </div>
      <LineChart labels={cmp.years}
        series={[{ key: "a", label: la + sm, values: pa }, { key: "b", label: lb + sm, values: pb }]}
        format={(v) => look.get(v) ?? `${Math.round(v * 100)}%`}
        ariaLabel={`${la} and ${lb} by year, each against its own peak`}
        onSelect={(p) => open({ kind: "year", year: p.label })} />
      <p className="itr-note">
        Each line is drawn against its own highest year (100%), so measures of different size share one chart;
        the tooltip gives the real figure. A year with no nights is a gap in an average and a zero in a count.
        Click a year to open it.
      </p>
    </ChartCard>
  );
});

// ----------------------------------------------------------- rolling shape

const MEASURES = [
  { key: "songs", label: "Songs per night", fmt: (v: number) => String(Math.round(v)) },
  { key: "minutes", label: "Minutes of music", fmt: (v: number) => `${Math.round(v)} min` },
  { key: "people", label: "People", fmt: (v: number) => String(Math.round(v * 10) / 10) },
] as const;

const RollingShapeSection = memo(function RollingShapeSection({ ctx }: TabProps) {
  const { report, onOpenNight } = ctx;
  const rows = report.nights;
  const view = useMemo(() => {
    // Two nights can share a date; the label must still be unique.
    const seen = new Map<string, number>();
    const labels = rows.map((r) => {
      const k = (seen.get(r.date) ?? 0) + 1; seen.set(r.date, k);
      return k === 1 ? r.date : `${r.date} (${k})`;
    });
    return MEASURES.map((m) => {
      const values = rows.map((r) => (m.key === "songs" ? r.songs : m.key === "people" ? r.people : r.minutes === null ? null : Math.round(r.minutes)));
      const z = neighbourZ(values);
      const markers: LineMarker[] = [];
      const flagged: string[] = [];
      z.forEach((zi, i) => {
        if (!isOutlier(zi)) return;
        const text = `${zi! > 0 ? "+" : "−"}${Math.abs(zi!).toFixed(1)} standard deviations from the nights around it`;
        markers.push({ x: labels[i], kind: "outlier", series: m.key, note: text });
        flagged.push(`${rows[i].date} (${m.fmt(values[i]!)})`);
      });
      return { m, values, markers, flagged };
    }).map((v) => ({ ...v, labels }));
  }, [rows]);
  const idOf = (label: string) => rows[view[0].labels.indexOf(label)]?.id;
  const anyFlag = view.flatMap((v) => v.flagged.map((f) => `${v.m.label.toLowerCase()}: ${f}`));
  const reading = !rows.length ? "No nights in this range."
    : rows.length < 6 ? `Only ${rows.length} nights in this range: too few to say what is usual.`
    : anyFlag.length === 0 ? `None of the ${rows.length} nights is more than 2 standard deviations from the nights around it on songs, minutes or people.`
    : `${anyFlag.length} point${anyFlag.length === 1 ? "" : "s"} more than 2 standard deviations from the 8 nights around: ${anyFlag.slice(0, 4).join("; ")}${anyFlag.length > 4 ? "; …" : ""}.`;
  return (
    <ChartCard title="Rolling shape of the nights" reading={reading} coverage={`${rows.length} nights`}
      csv={{
        header: ["date", "night", ...MEASURES.map((m) => m.label)],
        rows: rows.map((r, i) => [r.date, r.title, ...view.map((v) => v.values[i])]),
        title: "Rolling shape of the nights",
      }}>
      {view.map((v) => (
        <div key={v.m.key}>
          <p className="itr-sub">{v.m.label}</p>
          <LineChart labels={v.labels} height={150} rolling={5} rollingLabel="5-night rolling average"
            series={[{ key: v.m.key, label: v.m.label, values: v.values }]} markers={v.markers} format={v.m.fmt}
            ariaLabel={`${v.m.label}, night by night`}
            onSelect={(p) => { const id = idOf(p.label); if (id) onOpenNight(id); }} />
        </div>
      ))}
      <p className="itr-note">
        Ringed points sit more than 2 standard deviations from the (up to) 8 nights around them, the point itself
        left out; the first and last few nights are judged on fewer neighbours, and a stretch of identical
        nights has no spread to be far from. With so few nights a ring means "different from its neighbours",
        nothing more. Click a point to open the night.
      </p>
    </ChartCard>
  );
});

// -------------------------------------------------------------------- seasons

const SeasonsSection = memo(function SeasonsSection({ ctx, open }: TabProps) {
  const { report } = ctx;
  const rows = report.nights;
  const months = useMemo(() => monthCounts(rows), [rows]);
  const days = useMemo(() => weekdayCounts(rows), [rows]);
  const grid = useMemo(() => monthYearGrid(rows, report.years), [rows, report.years]);
  const total = rows.length;
  const bars = (counts: number[], names: string[]): BarDatum[] =>
    counts.map((c, i) => ({ key: String(i), label: names[i], values: [c], note: [`${Math.round((c / (total || 1)) * 100)}% of ${total} nights`] }));
  return (
    <div className="itr-stack">
      <ChartCard title="Nights by month" coverage={`${total} nights in total`}
        reading={peakReading(months, (i) => monthName(i), "month", "in")}
        csv={{ header: ["month", "nights"], rows: months.map((c, i) => [monthName(i), c]), title: "Nights by month" }}>
        <BarChart data={bars(months, SHORT_MONTHS)} showValues ariaLabel="Nights by calendar month, all years in the range"
          onSelect={(p) => open({ kind: "month", month: +p.key + 1 })} />
        <p className="itr-note">All years added together. {total < 60 ? `With ${total} nights, one night moves a bar a lot. ` : ""}Click a month to see its nights.</p>
      </ChartCard>
      <ChartCard title="Nights by day of the week" coverage={`${total} nights in total`}
        reading={peakReading(days, (i) => weekdayName(i), "day")}
        csv={{ header: ["weekday", "nights"], rows: days.map((c, i) => [weekdayName(i), c]), title: "Nights by day of the week" }}>
        <BarChart data={bars(days, SHORT_DAYS)} showValues colour={1} ariaLabel="Nights by day of the week, all years in the range"
          onSelect={(p) => open({ kind: "weekday", day: +p.key })} />
        <p className="itr-note">Days are the calendar date of the night as written, Monday first. Click a day to see its nights.</p>
      </ChartCard>
      <ChartCard title="Month by year" coverage={`${total} nights in total`}
        reading={total ? `Each cell counts the nights in that month of that year; blank-looking cells are months with none.` : "No nights in this range."}
        csv={{ header: ["year", ...MONTHS], rows: report.years.map((y, i) => [y, ...grid[i]]), title: "Nights by month and year" }}>
        <Heatmap rows={report.years} cols={SHORT_MONTHS} values={grid} rowKeys={report.years} colKeys={SHORT_MONTHS.map((_, i) => String(i + 1))}
          valueLabel="nights" ariaLabel="Nights by month (columns) and year (rows)"
          onSelect={(c) => { if (c.value) open({ kind: "month", month: +c.col, year: c.row }); }} />
      </ChartCard>
    </div>
  );
});

// ----------------------------------------------------------- kinds of night

const KindsSection = memo(function KindsSection({ ctx, open }: TabProps) {
  const { nights, report } = ctx;
  const k = useMemo(() => kindsByYear(nights, report.years), [nights, report.years]);
  const totals = k.kinds.map((_, j) => k.counts.reduce((a, row) => a + row[j], 0));
  const reading = !nights.length ? "No nights in this range."
    : `${nights.length} nights: ${k.kinds.map((n, j) => `${totals[j]} ${n}`).join(", ")}.`;
  const data: BarDatum[] = report.years.map((y, i) => ({
    key: y, label: y.slice(2), values: k.counts[i], note: [`${k.counts[i].reduce((a, b) => a + b, 0)} nights in ${y}`],
  }));
  return (
    <ChartCard title="What kind of night" reading={reading} coverage={`${nights.length} nights`}
      csv={{ header: ["year", ...k.kinds], rows: report.years.map((y, i) => [y, ...k.counts[i]]), title: "Kinds of night by year" }}>
      <BarChart data={data} series={k.kinds.map((n) => ({ key: n, label: n }))} stacked
        ariaLabel="Nights per year, split by kind of night" onSelect={(p) => open({ kind: "year", year: p.key })} />
      <p className="itr-note">
        The kind comes from the night's folder name (a night with a candyflip in it counts as Candyflip; Roll and
        Trip together as Roll + Trip). Click a year to open it.
      </p>
    </ChartCard>
  );
});

export const TRENDS_NEW_SECTIONS: SectionDef[] = [
  { id: "t-compare", label: "Compare two measures", Body: CompareSection },
  { id: "t-rolling", label: "Rolling shape", Body: RollingShapeSection },
  { id: "t-seasons", label: "Seasons", Body: SeasonsSection },
  { id: "t-kinds", label: "What kind of night", Body: KindsSection },
];
