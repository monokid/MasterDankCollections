/** New Nights & sound sections: how long nights run, weather and moon, and how
 *  the sets are built. Numbers come from src/trendinsights.ts. Weather is not a
 *  field of an event: it is the vault's date -> weather map (read here through
 *  getBundle), and the moon is worked out from the date. */
import { memo, useMemo, useRef, useState } from "react";
import {
  BarChart, ChartCard, DataTable, Tooltip, niceScale, useTip, useWidth, type BarDatum,
} from "../charts.tsx";
import { catalogIndex } from "../catalogIndex.ts";
import { fmtDate } from "../format.ts";
import { mean, median } from "../insightstats.ts";
import { getBundle } from "../vault.ts";
import type { WeatherMap } from "../weather.ts";
import {
  MOON_SHORT, SKY_GROUPS, TEMP_BANDS, groupAverages, histogram, hoursLabel, nightStructure, summariseStructure,
  weatherInputs, type Group, type GroupInput,
} from "../trendinsights.ts";
import { NightList } from "./TrendsCharts.tsx";
import type { SectionDef, TabProps } from "./types.ts";
import "../insights-trends.css";

const DAY = 86400000;
const dayNo = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
const nightWord = (n: number) => (n === 1 ? "1 night" : `${n} nights`);

// ------------------------------------------------------------------ the strip

interface Dot { id: string; date: string; title: string; minutes: number }

/** One dot per night on a calendar axis, height = running time, with the average line. */
function Strip({ dots, onOpen }: { dots: Dot[]; onOpen: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const W = useWidth(ref);
  const { tip, bind } = useTip(ref);
  const H = 190, L = 44, R = 12, T = 14, B = 24;
  const avg = mean(dots.map((d) => d.minutes));
  const hi = Math.max(...dots.map((d) => d.minutes), 60);
  const scale = niceScale(hi / 60, 4);
  const d0 = dayNo(dots[0].date), d1 = Math.max(dayNo(dots[dots.length - 1].date), d0 + 1);
  const iw = Math.max(40, W - L - R), ih = H - T - B;
  const x = (iso: string) => L + ((dayNo(iso) - d0) / (d1 - d0)) * iw;
  const y = (min: number) => T + ih - (min / 60 / scale.max) * ih;
  const y0 = +dots[0].date.slice(0, 4), y1 = +dots[dots.length - 1].date.slice(0, 4);
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  const every = Math.max(1, Math.ceil(34 / Math.max(iw / years.length, 1)));
  return (
    <div className="ich" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Length of each night, by date">
        {scale.ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={W - R} y1={y(t * 60)} y2={y(t * 60)} className="ich-grid" />
            <text x={L - 6} y={y(t * 60)} className="ich-tick" textAnchor="end" dominantBaseline="middle">{t} h</text>
          </g>
        ))}
        {years.map((yr, i) => {
          const px = x(`${yr}-01-01`);
          return i % every === 0 && px >= L - 1 && px <= W - R ? <text key={yr} x={px} y={H - 7} className="ich-tick" textAnchor="middle">{yr}</text>
            : i % every === 0 && i === 0 ? <text key={yr} x={L} y={H - 7} className="ich-tick" textAnchor="start">{yr}</text> : null;
        })}
        {avg !== null && (
          <g>
            <line x1={L} x2={W - R} y1={y(avg)} y2={y(avg)} className="ich-avg" />
            <text x={W - R} y={y(avg) - 4} className="ich-avgtext" textAnchor="end">average {hoursLabel(avg)}</text>
          </g>
        )}
        {dots.map((d) => (
          <g key={d.id} className="itr-dotg" tabIndex={0} role="button"
            aria-label={`${d.date}${d.title ? `, ${d.title}` : ""}: ${hoursLabel(d.minutes)}. Open the night`}
            onClick={() => onOpen(d.id)}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(d.id); } }}
            {...bind(fmtDate(d.date), [hoursLabel(d.minutes), ...(d.title ? [d.title] : [])])}>
            <circle cx={x(d.date)} cy={y(d.minutes)} r={11} className="ich-hit" />
            <circle cx={x(d.date)} cy={y(d.minutes)} r={11} className="itr-ring" />
            <circle cx={x(d.date)} cy={y(d.minutes)} r={5} className="itr-dot" />
          </g>
        ))}
        <line x1={L} x2={W - R} y1={y(0)} y2={y(0)} className="ich-axis" />
      </svg>
      <Tooltip tip={tip} width={W} />
      <DataTable caption="Length of each night" head={["", "length"]} rows={dots.map((d) => [d.date, hoursLabel(d.minutes)])} />
    </div>
  );
}

// -------------------------------------------------------------- how long

const LengthSection = memo(function LengthSection({ ctx }: TabProps) {
  const { report, onOpenNight } = ctx;
  const rows = report.nights;
  const timed = useMemo(() => rows.filter((r) => r.minutes !== null), [rows]);
  const minutes = useMemo(() => timed.map((r) => r.minutes!), [timed]);
  const len = useMemo(() => histogram(minutes, 30), [minutes]);
  const spn = useMemo(() => histogram(rows.map((r) => r.songs), 10), [rows]);
  const [lenSel, setLenSel] = useState<number | null>(null);
  const [songSel, setSongSel] = useState<number | null>(null);
  const item = (r: (typeof rows)[number]) => ({ id: r.id, date: r.date, detail: hoursLabel(r.minutes ?? 0) });

  const top = len.reduce<(typeof len)[number] | null>((b, x) => (!b || x.items.length > b.items.length ? x : b), null);
  const med = median(minutes);
  const lengthReading = !timed.length ? "No running times recorded in this range."
    : `Across ${timed.length} nights the middle night ran ${hoursLabel(med!)}, the shortest ${hoursLabel(Math.min(...minutes))} and the longest ${hoursLabel(Math.max(...minutes))}; the most common 30-minute band is ${hoursLabel(top!.start)} to ${hoursLabel(top!.end)} (${nightWord(top!.items.length)}).`;
  const songMed = median(rows.map((r) => r.songs));
  const topS = spn.reduce<(typeof spn)[number] | null>((b, x) => (!b || x.items.length > b.items.length ? x : b), null);
  const songReading = !rows.length ? "No nights in this range."
    : `The middle night had ${songMed} different songs (range ${Math.min(...rows.map((r) => r.songs))} to ${Math.max(...rows.map((r) => r.songs))}); the most common band is ${topS!.start} to ${topS!.end - 1} songs (${nightWord(topS!.items.length)}).`;

  const lenData: BarDatum[] = len.map((b, i) => ({ key: String(i), label: hoursLabel(b.start), values: [b.items.length], note: [`${hoursLabel(b.start)} to under ${hoursLabel(b.end)}`] }));
  const songData: BarDatum[] = spn.map((b, i) => ({ key: String(i), label: `${b.start}-${b.end - 1}`, values: [b.items.length], note: [`${b.start} to ${b.end - 1} songs`] }));
  const dots: Dot[] = timed.map((r) => ({ id: r.id, date: r.date, title: r.title, minutes: r.minutes! }));
  return (
    <div className="itr-stack">
      <ChartCard title="How long nights run" reading={lengthReading} coverage={`${timed.length} of ${rows.length} nights have a running time`}
        csv={{ header: ["from (min)", "to (min)", "nights"], rows: len.map((b) => [b.start, b.end, b.items.length]), title: "Night length in 30-minute bands" }}>
        <BarChart data={lenData} showValues ariaLabel="Number of nights by running time, 30-minute bands"
          onSelect={(p) => setLenSel(lenSel === +p.key ? null : +p.key)} />
        {lenSel !== null && len[lenSel] && (
          <NightList title={`${nightWord(len[lenSel].items.length)} from ${hoursLabel(len[lenSel].start)} to under ${hoursLabel(len[lenSel].end)}`}
            items={len[lenSel].items.map((i) => item(timed[i]))} onOpen={onOpenNight} />
        )}
        <p className="itr-note">Running time of what was played, each playlist counted once. Click a band to list its nights.</p>
      </ChartCard>
      {dots.length > 0 && (
        <ChartCard title="Every night, by date" coverage={`${dots.length} nights`}
          reading={`One dot per night; the dashed line is the average, ${hoursLabel(mean(minutes) ?? 0)}. Dots are placed by calendar date, so gaps between nights show as gaps.`}
          csv={{ header: ["date", "night", "minutes"], rows: dots.map((d) => [d.date, d.title, Math.round(d.minutes)]), title: "Length of each night" }}>
          <Strip dots={dots} onOpen={onOpenNight} />
          <p className="itr-note">Click a dot (or press Enter on it) to open the night.</p>
        </ChartCard>
      )}
      <ChartCard title="Songs per night" reading={songReading} coverage={`${rows.length} nights`}
        csv={{ header: ["from", "to", "nights"], rows: spn.map((b) => [b.start, b.end - 1, b.items.length]), title: "Songs per night in bands of ten" }}>
        <BarChart data={songData} showValues colour={1} ariaLabel="Number of nights by different songs played, bands of ten"
          onSelect={(p) => setSongSel(songSel === +p.key ? null : +p.key)} />
        {songSel !== null && spn[songSel] && (
          <NightList title={`${nightWord(spn[songSel].items.length)} with ${spn[songSel].start} to ${spn[songSel].end - 1} songs`}
            items={spn[songSel].items.map((i) => ({ id: rows[i].id, date: rows[i].date, detail: `${rows[i].songs} songs` }))} onOpen={onOpenNight} />
        )}
        <p className="itr-note">Different songs per night: a song several people brought counts once. Click a band to list its nights.</p>
      </ChartCard>
    </div>
  );
});

// ----------------------------------------------------------- weather and moon

/** Two bar charts (songs, minutes) and a table of n, for one way of grouping nights. */
function GroupCard({ title, reading, coverage, groups, labels, unknown, empty, onOpen, dates, csvTitle }: {
  title: string; reading: string; coverage: string; groups: Group[]; labels: Record<string, string>;
  unknown: number; empty?: string; onOpen: (id: string) => void; dates: Map<string, string>; csvTitle: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const shown = groups.filter((g) => g.n > 0);
  const bars = (pick: (g: Group) => number | null): BarDatum[] => groups.map((g) => ({
    key: g.key, label: `${labels[g.key] ?? g.key} · ${g.n}`,
    values: [g.n ? pick(g) : null],
    note: [nightWord(g.n), ...(g.n > 0 && g.n < 3 ? ["too few nights to read anything from"] : [])],
  }));
  const chosen = groups.find((g) => g.key === sel);
  return (
    <ChartCard title={title} reading={reading} coverage={coverage}
      csv={{
        header: ["group", "nights", "average songs", "average minutes"],
        rows: groups.map((g) => [g.key, g.n, g.songs === null ? null : Math.round(g.songs * 10) / 10, g.minutes === null ? null : Math.round(g.minutes)]),
        title: csvTitle,
      }}>
      {empty ? <p className="itr-note">{empty}</p> : (
        <>
          <p className="itr-sub">Average songs per night</p>
          <BarChart data={bars((g) => g.songs)} height={160} showValues format={(v) => v.toFixed(1)} ariaLabel={`${title}: average songs per night`}
            onSelect={(p) => setSel(sel === p.key ? null : p.key)} />
          <p className="itr-sub">Average night length, minutes</p>
          <BarChart data={bars((g) => g.minutes)} height={160} showValues colour={1} format={(v) => String(Math.round(v))} ariaLabel={`${title}: average night length`}
            onSelect={(p) => setSel(sel === p.key ? null : p.key)} />
          <table className="itr-table">
            <thead><tr><th scope="col">Group</th><th scope="col">Nights</th><th scope="col">Songs</th><th scope="col">Minutes</th></tr></thead>
            <tbody>
              {groups.map((g) => (
                <tr key={g.key} className={sel === g.key ? "is-sel" : undefined}>
                  <td>{g.n > 0
                    ? <button className="itr-night" onClick={() => setSel(sel === g.key ? null : g.key)} title="List these nights">{g.key}</button>
                    : g.key}</td>
                  <td>{g.n}</td><td>{g.songs === null ? "–" : g.songs.toFixed(1)}</td><td>{g.minutes === null ? "–" : Math.round(g.minutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {chosen && chosen.n > 0 && (
            <NightList title={`${nightWord(chosen.n)}: ${chosen.key}`}
              items={chosen.ids.map((id) => ({ id, date: dates.get(id) ?? id }))} onOpen={onOpen} />
          )}
          <p className="itr-note">
            The number after each label is how many nights are behind the bar ({shown.length} of {groups.length} groups have any).
            Averages of a few nights move with a single night, so a gap between bars is not evidence of anything.
            {unknown > 0 ? ` ${nightWord(unknown)} could not be placed in a group and are left out.` : ""}
          </p>
        </>
      )}
    </ChartCard>
  );
}

function spread(groups: Group[], what: string): string {
  const g = groups.filter((x) => x.n > 0 && x.songs !== null);
  if (!g.length) return `No nights with ${what}.`;
  const lo = g.reduce((a, b) => (b.songs! < a.songs! ? b : a)), hi = g.reduce((a, b) => (b.songs! > a.songs! ? b : a));
  const ns = g.map((x) => x.n);
  return `Average songs per night runs from ${lo.songs!.toFixed(1)} (${lo.key}, ${nightWord(lo.n)}) to ${hi.songs!.toFixed(1)} (${hi.key}, ${nightWord(hi.n)}); the groups hold ${Math.min(...ns)} to ${Math.max(...ns)} nights each, which is too few to prove anything.`;
}

const WeatherSection = memo(function WeatherSection({ ctx }: TabProps) {
  const { report, onOpenNight } = ctx;
  const rows = report.nights;
  const weather = (getBundle()?.weather ?? {}) as WeatherMap;
  const w = useMemo(() => weatherInputs(rows, weather), [rows, weather]);
  const dates = useMemo(() => new Map(rows.map((r) => [r.id, r.date])), [rows]);
  const temp = useMemo(() => groupAverages(w.temp, [...TEMP_BANDS]), [w]);
  const sky = useMemo(() => groupAverages(w.sky, [...SKY_GROUPS]), [w]);
  const moon = useMemo(() => groupAverages(w.moon as GroupInput[], [...MOON_SHORT]), [w]);
  const none = w.known === 0 ? "No weather is loaded for these nights." : undefined;
  const cover = `known for ${w.known} of ${rows.length} nights`;
  const moonLabels = Object.fromEntries(MOON_SHORT.map((m) => [m, m.replace("Waxing", "Wax.").replace("Waning", "Wan.").replace("crescent", "cres.").replace("gibbous", "gib.").replace("quarter", "qtr")]));
  return (
    <div className="itr-stack">
      <GroupCard title="By temperature" csvTitle="Nights by evening temperature" groups={temp.groups} labels={{}} unknown={temp.unknown}
        coverage={cover} empty={none} onOpen={onOpenNight} dates={dates}
        reading={none ?? `Temperature at 21:00 in Hasselt. ${spread(temp.groups, "temperature")}`} />
      <GroupCard title="By clear, cloudy or rain" csvTitle="Nights by evening sky" groups={sky.groups} labels={{}} unknown={sky.unknown}
        coverage={cover} empty={none} onOpen={onOpenNight} dates={dates}
        reading={none ?? `Sky at 21:00 in Hasselt (clear or partly cloudy; overcast or fog; drizzle, rain or thunder; snow). ${spread(sky.groups, "sky")}`} />
      <GroupCard title="By moon phase" csvTitle="Nights by moon phase" groups={moon.groups} labels={moonLabels} unknown={moon.unknown}
        coverage={`worked out from the date for all ${rows.length} nights`} onOpen={onOpenNight} dates={dates}
        reading={`Eight phases of the mean lunar month at about 21:00 (accurate to within half a day). ${spread(moon.groups, "a moon phase")}`} />
    </div>
  );
});

// ------------------------------------------------------------- set structure

const StructureSection = memo(function StructureSection({ cat, ctx, open }: TabProps) {
  const { nights, report } = ctx;
  const per = useMemo(() => {
    const ix = catalogIndex(cat);
    return nights.map((e) => nightStructure({ id: e.id, date: e.date! }, ix.tracksOfEvent.get(e.id) ?? [], cat.phases));
  }, [cat, nights]);
  const all = useMemo(() => summariseStructure(per), [per]);
  const byYear = useMemo(() => report.years.map((y) => ({ y, s: summariseStructure(per.filter((p) => p.date.startsWith(y))) })), [per, report.years]);
  if (!cat.phases.length) return <p className="sub">This catalogue has no phases, so there is no set structure to show.</p>;
  const bars = (f: (s: (typeof byYear)[number]["s"]) => number | null): BarDatum[] =>
    byYear.map(({ y, s }) => ({ key: y, label: y.slice(2), values: [s.nights ? f(s) : null], note: [nightWord(s.nights) + " with named lists"] }));
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const reading = all.nights === 0 ? "No nights with named lists in this range."
    : `Across ${all.nights} nights: ${all.listsPerNight!.toFixed(1)} lists a night; ${pct(all.phasedListShare ?? 0)} of lists are split into phases (and ${pct(all.phasedTrackShare ?? 0)} of their tracks sit in one); a phase holds ${all.tracksPerPhase === null ? "–" : all.tracksPerPhase.toFixed(1)} tracks on average.`;
  const csvRows = byYear.map(({ y, s }) => [y, s.nights, s.listsPerNight === null ? null : +s.listsPerNight.toFixed(2), s.phasedListShare === null ? null : +s.phasedListShare.toFixed(3), s.phasedTrackShare === null ? null : +s.phasedTrackShare.toFixed(3), s.tracksPerPhase === null ? null : +s.tracksPerPhase.toFixed(2)]);
  const drill = (p: { key: string }) => open({ kind: "year", year: p.key });
  return (
    <div className="itr-stack">
      <ChartCard title="Set structure" reading={reading} coverage={`${all.nights} nights with named lists`}
        csv={{ header: ["year", "nights", "lists per night", "share of lists with phases", "share of tracks in a phase", "tracks per phase"], rows: csvRows, title: "Set structure by year" }}>
        <p className="itr-sub">Lists per night</p>
        <BarChart data={bars((s) => s.listsPerNight)} height={150} showValues average={all.listsPerNight} avgLabel="all nights"
          format={(v) => v.toFixed(1)} ariaLabel="Average number of lists per night, by year" onSelect={drill} />
        <p className="itr-sub">Share of lists split into phases</p>
        <BarChart data={bars((s) => s.phasedListShare)} height={150} showValues colour={1} format={pct}
          ariaLabel="Share of lists with phases, by year" onSelect={drill} />
        <p className="itr-sub">Tracks per phase</p>
        <BarChart data={bars((s) => s.tracksPerPhase)} height={150} showValues colour={2} format={(v) => v.toFixed(1)}
          ariaLabel="Average tracks per phase, by year" onSelect={drill} />
        <p className="itr-note">
          A list is one person's playlist (their anonymised twin is the same list); tracks nobody owns are not counted.
          A year's bar is the mean over its nights, not over its lists. Click a year to open it.
        </p>
      </ChartCard>
    </div>
  );
});

export const NIGHTS_NEW_SECTIONS: SectionDef[] = [
  { id: "n-length", label: "How long nights run", Body: LengthSection },
  { id: "n-weather", label: "Weather and moon", Body: WeatherSection },
  { id: "n-structure", label: "Set structure", Body: StructureSection },
];
