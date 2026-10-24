/** The Trends tab's long-standing sections, moved out of Insights.tsx as they
 *  were: discovery, the year-by-year figures, the years that break a trend, and
 *  the artists rising and fading. */
import { memo, useMemo } from "react";
import {
  discovery, evolutions, genreCoverage, realGenres, tastemakers, trendBreaks,
} from "../analytics.ts";
import { Chart, TOP, TrendBlock } from "./shared.tsx";
import type { Row, SectionDef, TabProps } from "./types.ts";

const DiscoverySection = memo(function DiscoverySection({ cat, range, ctx, open }: TabProps) {
  const { nights, people } = ctx;
  const disc = useMemo(() => discovery(cat, range), [cat, range]);
  const taste = useMemo(() => tastemakers(cat), [cat]);
  const discRows = useMemo<Row[]>(() => disc.map((y) => ({
    label: y.year, value: Math.round(y.rate * 100), text: `${Math.round(y.rate * 100)}%`,
    sub: `${y.fresh} of ${y.played}`, drill: { kind: "year", year: y.year },
  })), [disc]);
  const freshRows = useMemo<Row[]>(() => nights
    .map((e) => ({ e, share: e.debuts / Math.max(e.playedCount, 1) }))
    .sort((a, b) => b.share - a.share).slice(0, TOP)
    .map(({ e, share }) => ({
      label: e.date!, sub: e.title || e.types.join(" + "), value: Math.round(share * 100),
      text: `${Math.round(share * 100)}%`, drill: { kind: "night" as const, id: e.id },
    })), [nights]);
  const tasteRows = useMemo<Row[]>(() => taste.rows.map((r) => ({
    label: people.get(r.personId)?.name ?? r.personId, value: r.count, text: `${r.count} songs`,
    drill: { kind: "person" as const, id: r.personId },
  })), [taste, people]);
  return (
    <div className="charts">
      <Chart title="New music, by year" rows={discRows} onDrill={open}
        note="Share of each year's tracks never played at any earlier night." />
      <Chart tall title="Most new music" rows={freshRows} onDrill={open}
        note="Share of a night that had never been heard before." />
      <Chart title="Tastemakers" rows={tasteRows} onDrill={open}
        note={`Who first brought the ${taste.songs} songs that went on to be played on 3+ nights. All history.`} />
    </div>
  );
});

const YearByYearSection = memo(function YearByYearSection({ ctx, open }: TabProps) {
  const { T, nights } = ctx;
  const byYear = useMemo(() => {
    const m = new Map<string, { nights: number; hours: number; tracks: number }>();
    for (const e of nights) {
      const y = e.date!.slice(0, 4);
      const r = m.get(y) ?? { nights: 0, hours: 0, tracks: 0 };
      r.nights++; r.hours += e.durationSec / 3600; r.tracks += e.playedCount;
      m.set(y, r);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [nights]);
  const yearRow = (y: string, value: number, text: string): Row =>
    ({ label: y, value, text, drill: { kind: "year", year: y } });
  const nightRows = useMemo(() => byYear.map(([y, r]) => yearRow(y, r.nights, `${r.nights}`)), [byYear]);
  const hourRows = useMemo(() => byYear.map(([y, r]) => yearRow(y, Math.round(r.hours), `${Math.round(r.hours)} h`)), [byYear]);
  const lengthRows = useMemo(() => byYear.map(([y, r]) => {
    const min = (r.hours * 60) / Math.max(r.tracks, 1);
    return yearRow(y, Math.round(min * 10) / 10, `${min.toFixed(1)} min`);
  }), [byYear]);
  const genres = useMemo(() => realGenres(T).slice(0, TOP).map((g): Row => ({
    label: g.genre, value: g.count, drill: { kind: "genre", name: g.genre },
  })), [T]);
  const genreShare = useMemo(() => genreCoverage(T), [T]);
  return (
    <div className="charts">
      <Chart title="Nights per year" onDrill={open} rows={nightRows} />
      <Chart title="Hours of music per year" onDrill={open} rows={hourRows} />
      <Chart title="Average track length" onDrill={open} note="Minutes, by year." rows={lengthRows} />
      <Chart tall title="Genres" onDrill={open} rows={genres}
        note={`Only ${(genreShare * 100).toFixed(0)}% of tracks carry a real genre tag — most "genres" in the files are the night's label, which is left out.`} />
    </div>
  );
});

const BreaksSection = memo(function BreaksSection({ cat, range, open }: TabProps) {
  const trends = useMemo(() => trendBreaks(cat, range), [cat, range]);
  return (
    <>
      <p className="sub">
        A year is marked when it is at least twice or at most half the median of the two years
        either side of it (and the gap is more than a rounding error). It follows the range above.
      </p>
      <div className="charts">
        {trends.map((t) => <TrendBlock key={t.key} trend={t} onDrill={open} />)}
      </div>
    </>
  );
});

const EvolutionsSection = memo(function EvolutionsSection({ cat, range, open }: TabProps) {
  const evo = useMemo(() => evolutions(cat, range), [cat, range]);
  const evoRow = (t: { artist: { id: string; name: string }; early: number; late: number }): Row => ({
    label: t.artist.name, value: Math.round(Math.abs(t.late - t.early) * 100),
    text: `${Math.round(t.early * 100)}% → ${Math.round(t.late * 100)}%`,
    drill: { kind: "artist", id: t.artist.id },
  });
  return (
    <div className="charts">
      <Chart tall title="Rising artists" onDrill={open}
        note={evo.split ? `Share of nights an artist appeared on, first half of the nights against the second (the split falls at ${evo.split}). 5+ nights. Follows the range.` : "Needs at least four nights in range."}
        rows={evo.rising.map(evoRow)} />
      <Chart tall title="Fading artists" onDrill={open}
        note={evo.split ? "The same measure, falling instead of rising." : "Needs at least four nights in range."}
        rows={evo.fading.map(evoRow)} />
    </div>
  );
});

export const TRENDS_SECTIONS: SectionDef[] = [
  { id: "discovery", label: "Discovery", Body: DiscoverySection },
  { id: "trends", label: "Year by year", Body: YearByYearSection },
  { id: "breaks", label: "Years that stand out", Body: BreaksSection },
  { id: "evolutions", label: "Rising & fading", Body: EvolutionsSection },
];
