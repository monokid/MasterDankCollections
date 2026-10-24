/** The Music tab's chart sections: what the library sounds like over time, release
 *  decades, the genre x decade map, concentration, song lifespans, track length and
 *  where new music comes from. The figures are computed in src/musicinsights.ts.
 *
 *  Sections that need the music-database layer (`ENRICH_ONLY`) are left out of the tab
 *  when it is not loaded (TabMusic says so once). Every enrichment chart carries a
 *  coverage badge, because the layer only knows part of the library. */
import { memo, useMemo, useState } from "react";
import type { Catalog } from "../catalog.ts";
import {
  BarChart, ChartCard, Heatmap, LineChart, coverageText,
  type BarDatum, type ChartPoint,
} from "../charts.tsx";
import { fmtCount, plural } from "../format.ts";
import { kpiReport, median } from "../insightstats.ts";
import {
  LENGTH_EDGES, NIGHTS_EDGES, REPEAT_EDGES, SPAN_EDGES,
  ageByYear, bin, collapse, concentrationByYear, decadeOrder, distinctSongs, firstSightings,
  heatTable, keyTable, lengthLabel, littleExplored, medianLengthByYear, newByYear, nightsLabel,
  shareSeries, songDecade, songFamily, songSeconds, songSpans, songsByYear, songsInCell,
  spanLabel, topShare,
} from "../musicinsights.ts";
import type { SectionDef, TabProps } from "./types.ts";
import "../insights-music.css";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
const yrs = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(1)} yr`;
const mins = (v: number) => `${v.toFixed(1)} min`;
const REST = "__rest";

const songMaps = new WeakMap<Catalog, Map<string, Catalog["songs"][number]>>();
function songMap(cat: Catalog) {
  let m = songMaps.get(cat);
  if (!m) { m = new Map(cat.songs.map((s) => [s.id, s])); songMaps.set(cat, m); }
  return m;
}

/** The songs behind a clicked bar or cell; each opens that song. */
function SongList({ cat, items, open, heading, actions }: {
  cat: Catalog; items: Array<{ id: string; text: string }>; open: TabProps["open"];
  heading: string; actions?: React.ReactNode;
}) {
  const songs = songMap(cat), SHOW = 12;
  return (
    <div className="mi-list" role="region" aria-label={heading}>
      <div className="mi-listhead"><b>{heading}</b>{actions}</div>
      {items.length === 0 && <div className="src">No songs.</div>}
      {items.slice(0, SHOW).map((it) => (
        <button key={it.id} className="mi-song" onClick={() => open({ kind: "song", id: it.id })}>
          <span>{songs.get(it.id)?.title ?? it.id}<i>{songs.get(it.id)?.artist}</i></span>
          <em>{it.text}</em>
        </button>
      ))}
      {items.length > SHOW && <div className="src">and {fmtCount(items.length - SHOW)} more</div>}
    </div>
  );
}

const Unknown = ({ what }: { what: string }) => <div className="src">No {what} known for any song in this range yet.</div>;

/** The one place a year's bar says how many of its songs the figure rests on. */
const knownNote = (known: number, total: number) =>
  total ? [`known for ${fmtCount(known)} of ${fmtCount(total)} songs`] : ["no nights this year"];

// -------------------------------------------------------------- 1. sounds

const SoundsSection = memo(function SoundsSection({ cat, enrich, ctx, open }: TabProps) {
  const { years, nights } = ctx.report;
  const [sel, setSel] = useState<string | null>(null);
  const full = useMemo(
    () => keyTable(years, songsByYear(nights, years), (id) => songFamily(enrich, id)),
    [years, nights, enrich],
  );
  const top = useMemo(() => collapse(full, 4), [full]);
  void cat;
  if (!full.keys.length) {
    return <ChartCard title="Genre families per year" coverage={coverageText(0, full.cover.total, "songs")}
      reading="No song in this range has a genre family yet."><Unknown what="genre family" /></ChartCard>;
  }
  const series = [...top.keys.map((k) => ({ key: k, label: k })), ...(top.rest.length ? [{ key: REST, label: "other families" }] : [])];
  const data: BarDatum[] = years.map((y, i) => ({ key: y, label: y, values: top.cells[i], note: knownNote(full.known[i], full.total[i]) }));
  const lastI = full.known.map((k) => k > 0).lastIndexOf(true);
  const overall = full.keys.map((k, j) => ({ k, n: full.cells.reduce((a, r) => a + r[j], 0) }));
  const topOverall = overall[0];
  const lastTop = lastI >= 0 ? full.keys.map((k, j) => ({ k, n: full.cells[lastI][j] })).sort((a, b) => b.n - a.n)[0] : null;
  const reading = (
    <>
      Share of each year's songs by genre family, among the songs a family is known for.
      Over the whole range <b>{topOverall.k}</b> is the largest family ({pct(topOverall.n / full.cover.known)} of the
      songs with a family)
      {lastTop && lastI >= 0 && <>; in {years[lastI]} it was <b>{lastTop.k}</b> at {pct(lastTop.n / full.known[lastI])}</>}.
      Known for {fmtCount(full.cover.known)} of {fmtCount(full.cover.total)} songs.
    </>
  );
  const line = sel ? shareSeries(full, sel) : null;
  return (
    <ChartCard title="Genre families per year" reading={reading}
      coverage={coverageText(full.cover.known, full.cover.total, "songs")}
      csv={{
        title: "Genre families per year", header: ["year", ...full.keys, "songs with a family", "songs"],
        rows: years.map((y, i) => [y, ...full.cells[i], full.known[i], full.total[i]]),
      }}>
      <BarChart data={data} series={series} stacked percent height={230} ariaLabel="Genre family share of songs, by year"
        format={(v) => fmtCount(v)}
        onSelect={(p: ChartPoint) => open(p.series === REST ? { kind: "year", year: p.key } : { kind: "family", family: p.series })} />
      <div className="mi-chips" role="group" aria-label="Pick a family to follow its share over time">
        <button className="mi-chip" aria-pressed={sel === null} onClick={() => setSel(null)}>no highlight</button>
        {overall.map(({ k, n }) => (
          <button key={k} className="mi-chip" aria-pressed={sel === k} onClick={() => setSel(sel === k ? null : k)}
            title={`${fmtCount(n)} song-years`}>{k}</button>
        ))}
      </div>
      {sel && line && (
        <LineChart labels={years} series={[{ key: sel, label: sel, values: line }]} height={170} format={pct}
          ariaLabel={`Share of ${sel} among songs with a family, by year`}
          onSelect={(p) => open({ kind: "year", year: p.key })} />
      )}
      {sel && <div className="mi-hint">Share of that year's songs with a known family. Click a point for the year, a bar segment for the family.</div>}
    </ChartCard>
  );
});

// ------------------------------------------------------------- 2. decades

const DecadesSection = memo(function DecadesSection({ enrich, ctx, open }: TabProps) {
  const { years, nights } = ctx.report;
  const byYear = useMemo(() => songsByYear(nights, years), [nights, years]);
  const full = useMemo(() => keyTable(years, byYear, (id) => songDecade(enrich, id), decadeOrder), [years, byYear, enrich]);
  const top = useMemo(() => collapse(full, 4, decadeOrder), [full]);
  const ages = useMemo(() => ageByYear(years, byYear, enrich), [years, byYear, enrich]);
  if (!full.keys.length) {
    return <ChartCard title="Release decades" coverage={coverageText(0, full.cover.total, "songs")}
      reading="No song in this range has a release year yet."><Unknown what="release year" /></ChartCard>;
  }
  const series = [...top.keys.map((k) => ({ key: k, label: k })), ...(top.rest.length ? [{ key: REST, label: "other decades" }] : [])];
  const data: BarDatum[] = years.map((y, i) => ({ key: y, label: y, values: top.cells[i], note: knownNote(full.known[i], full.total[i]) }));
  const withAge = years.map((y, i) => ({ y, m: ages[i].median })).filter((p): p is { y: string; m: number } => p.m !== null);
  const a0 = withAge[0], a1 = withAge[withAge.length - 1];
  const reading = (
    <>
      Songs by the decade they were released, for each year they were brought.
      {a0 && a1 && a0.y !== a1.y
        ? <> The typical song was {yrs(a0.m)} old when brought in {a0.y} and {yrs(a1.m)} old in {a1.y}.</>
        : a1 && <> The typical song was {yrs(a1.m)} old when brought in {a1.y}.</>}
      {" "}Known for {fmtCount(full.cover.known)} of {fmtCount(full.cover.total)} songs.
    </>
  );
  return (
    <ChartCard title="Release decades" reading={reading}
      coverage={coverageText(full.cover.known, full.cover.total, "songs")}
      csv={{
        title: "Release decades", header: ["year", ...full.keys, "songs with a release year", "songs", "median age (years)"],
        rows: years.map((y, i) => [y, ...full.cells[i], full.known[i], full.total[i], ages[i].median]),
      }}>
      <BarChart data={data} series={series} stacked height={220} ariaLabel="Songs by release decade, per year brought"
        onSelect={(p) => open(p.series === REST ? { kind: "year", year: p.key } : { kind: "decade", decade: p.series })} />
      <h3 className="mi-sub">How old is the music when it is brought?</h3>
      <LineChart labels={years} height={180} format={yrs} ariaLabel="Median release age of the songs brought, by year"
        series={[{ key: "age", label: "median age", values: ages.map((a) => a.median) }]}
        onSelect={(p) => open({ kind: "year", year: p.key })} />
      <div className="mi-hint">Median of (year of the night minus release year) over that year's songs with a release year.</div>
    </ChartCard>
  );
});

// ------------------------------------------------------------- 3. the map

const MapSection = memo(function MapSection({ cat, enrich, ctx, open }: TabProps) {
  const songs = useMemo(() => distinctSongs(ctx.report.nights), [ctx.report.nights]);
  const h = useMemo(() => heatTable(songs, enrich), [songs, enrich]);
  const quiet = useMemo(() => littleExplored(h), [h]);
  const [cell, setCell] = useState<{ family: string; decade: string } | null>(null);
  const inCell = useMemo(() => {
    if (!cell) return [];
    const nightsOf = new Map<string, number>();
    for (const r of ctx.report.nights) for (const id of r.songIds) nightsOf.set(id, (nightsOf.get(id) ?? 0) + 1);
    return songsInCell(songs, enrich, cell.family, cell.decade)
      .map((id) => ({ id, n: nightsOf.get(id) ?? 0 })).sort((a, b) => b.n - a.n)
      .map((s) => ({ id: s.id, text: plural(s.n, "night") }));
  }, [cell, songs, enrich, ctx.report.nights]);
  if (!h.families.length) {
    return <ChartCard title="Genre by release decade" coverage={coverageText(0, h.cover.total, "songs")}
      reading="No song in this range has both a genre family and a release year yet."><Unknown what="family and release year" /></ChartCard>;
  }
  const reading = (
    <>
      How many different songs sit in each genre family and release decade. Based on the {fmtCount(h.cover.known)} songs
      with both a family and a release year, {fmtCount(h.cover.total)} songs in all.
      {quiet.length > 0 && <> Barely brought so far, given how much of each there is elsewhere: {quiet.map((q, i) => (
        <span key={q.family + q.decade}>{i ? "; " : " "}<b>{q.family}</b> from the {q.decade}</span>
      ))}.</>}
    </>
  );
  return (
    <ChartCard title="Genre by release decade" reading={reading}
      coverage={coverageText(h.cover.known, h.cover.total, "songs")}
      csv={{
        title: "Genre by release decade", header: ["family", ...h.decades],
        rows: h.families.map((f, i) => [f, ...h.counts[i]]),
      }}>
      <Heatmap rows={h.families} cols={h.decades} values={h.counts} valueLabel="songs"
        ariaLabel="Songs by genre family and release decade" format={(v) => fmtCount(v)}
        onSelect={(c) => setCell({ family: c.row, decade: c.col })} />
      {cell && (
        <SongList cat={cat} open={open} items={inCell} heading={`${cell.family}, ${cell.decade}: ${plural(inCell.length, "song")}`}
          actions={(
            <span className="mi-acts">
              <button className="mi-chip" onClick={() => open({ kind: "family", family: cell.family })}>all {cell.family}</button>
              <button className="mi-chip" onClick={() => open({ kind: "decade", decade: cell.decade })}>all {cell.decade}</button>
            </span>
          )} />
      )}
    </ChartCard>
  );
});

// ------------------------------------------------------- 4. concentration

const ConcentrationSection = memo(function ConcentrationSection({ cat, ctx, open }: TabProps) {
  const { years, nights } = ctx.report;
  const conc = useMemo(() => concentrationByYear(nights, years), [nights, years]);
  const spans = useMemo(() => songSpans(nights), [nights]);
  const [pick, setPick] = useState<string | null>(null);
  const bins = useMemo(() => bin(spans, (s) => s.nights, REPEAT_EDGES, nightsLabel), [spans]);
  if (!spans.length) {
    return <ChartCard title="Concentration" reading="No songs in this range."><div className="src">Nothing to show.</div></ChartCard>;
  }
  const once = bins[0].items.length;
  const counts = spans.map((s) => s.nights);
  const top10 = topShare(counts, 10);
  const mostOnce = once / spans.length > 0.5;
  const series = [
    { key: "s10", label: "top 10 songs", values: conc.map((c) => c.song10) },
    { key: "s50", label: "top 50 songs", values: conc.map((c) => c.song50) },
    { key: "a10", label: "top 10 artists", values: conc.map((c) => c.artist10) },
    { key: "a50", label: "top 50 artists", values: conc.map((c) => c.artist50) },
  ];
  const reading = (
    <>
      {mostOnce ? "Most songs are brought once" : "Fewer than half the songs are brought only once"}:
      {" "}{fmtCount(once)} of {fmtCount(spans.length)} songs ({pct(once / spans.length)}) were on a single night.
      {top10 !== null && <> The ten most-brought songs make up {pct1(top10)} of all song-nights.</>}
      {" "}The lines show how much of each year's song-nights (a song on a night counts once) the biggest 10 and 50 account for;
      a year with no more than 10 (or 50) songs is left blank, and a bigger year spreads thinner by arithmetic.
    </>
  );
  const data: BarDatum[] = bins.map((b) => ({
    key: b.key, label: b.label, values: [b.items.length],
    note: [`${pct(b.items.length / spans.length)} of songs`],
  }));
  const picked = bins.find((b) => b.key === pick);
  return (
    <ChartCard title="Concentration" reading={reading}
      csv={{
        title: "Concentration", header: ["year", "top 10 songs", "top 50 songs", "top 10 artists", "top 50 artists"],
        rows: conc.map((c) => [c.year, c.song10, c.song50, c.artist10, c.artist50]),
      }}>
      <LineChart labels={years} series={series} height={210} format={pct} ariaLabel="Share of song-nights and artist-nights held by the biggest 10 and 50, by year"
        onSelect={(p) => open({ kind: "year", year: p.key })} />
      <h3 className="mi-sub">How many nights each song is brought on</h3>
      <BarChart data={data} height={170} showValues ariaLabel="Songs by number of nights brought on"
        onSelect={(p) => setPick(p.key)} />
      {picked && (
        <SongList cat={cat} open={open} heading={`Songs brought on ${picked.label} night${picked.label === "1" ? "" : "s"}: ${fmtCount(picked.items.length)}`}
          items={[...picked.items].sort((a, b) => b.nights - a.nights || a.id.localeCompare(b.id)).map((s) => ({ id: s.id, text: plural(s.nights, "night") }))} />
      )}
    </ChartCard>
  );
});

// --------------------------------------------------------- 5. lifespans

const LifespanSection = memo(function LifespanSection({ cat, ctx, open }: TabProps) {
  const spans = useMemo(() => songSpans(ctx.report.nights), [ctx.report.nights]);
  const [pick, setPick] = useState<{ chart: "n" | "y"; key: string } | null>(null);
  const nBins = useMemo(() => bin(spans, (s) => s.nights, NIGHTS_EDGES, nightsLabel), [spans]);
  const back = useMemo(() => spans.filter((s) => s.nights >= 2), [spans]);
  const yBins = useMemo(() => bin(back, (s) => s.years, SPAN_EDGES, spanLabel), [back]);
  if (!spans.length) {
    return <ChartCard title="Song lifespans" reading="No songs in this range."><div className="src">Nothing to show.</div></ChartCard>;
  }
  const med = median(back.map((s) => s.years));
  const longest = [...back].sort((a, b) => b.years - a.years || b.nights - a.nights)[0];
  const songs = songMap(cat);
  const reading = (
    <>
      {fmtCount(back.length)} of {fmtCount(spans.length)} songs came back on a later night. For those, the middle span between
      first and last night is {med === null ? "–" : yrs(med)}
      {longest && longest.years > 0 && <>; the longest is {songs.get(longest.id)?.title ?? longest.id} at {longest.years} years</>}.
      Spans are counted inside the chosen range.
    </>
  );
  const nData: BarDatum[] = nBins.map((b) => ({ key: b.key, label: b.label, values: [b.items.length] }));
  const yData: BarDatum[] = yBins.map((b) => ({ key: b.key, label: b.label, values: [b.items.length], note: ["songs on 2 or more nights"] }));
  const list = pick && (pick.chart === "n" ? nBins : yBins).find((b) => b.key === pick.key);
  return (
    <ChartCard title="Song lifespans" reading={reading}
      csv={{
        title: "Song lifespans", header: ["chart", "bin", "songs"],
        rows: [...nBins.map((b) => ["nights per song", b.label, b.items.length]), ...yBins.map((b) => ["years between first and last night", b.label, b.items.length])],
      }}>
      <h3 className="mi-sub">Nights per song</h3>
      <BarChart data={nData} height={170} showValues ariaLabel="Songs by number of nights"
        onSelect={(p) => setPick({ chart: "n", key: p.key })} />
      <h3 className="mi-sub">Years between a song's first and last night (songs on 2+ nights)</h3>
      <BarChart data={yData} height={170} showValues colour={1} ariaLabel="Songs by years between first and last night"
        onSelect={(p) => setPick({ chart: "y", key: p.key })} />
      {list && pick && (
        <SongList cat={cat} open={open}
          heading={`${pick.chart === "n" ? `${list.label} nights` : `${list.label} years apart`}: ${plural(list.items.length, "song")}`}
          items={[...list.items].sort((a, b) => (pick.chart === "n" ? b.nights - a.nights : b.years - a.years) || a.id.localeCompare(b.id))
            .map((s) => ({ id: s.id, text: pick.chart === "n" ? plural(s.nights, "night") : `${s.years} yr, ${plural(s.nights, "night")}` }))} />
      )}
    </ChartCard>
  );
});

// ------------------------------------------------------- 6. track length

const LengthSection = memo(function LengthSection({ cat, ctx, open }: TabProps) {
  const { years, nights } = ctx.report;
  const secs = useMemo(() => songSeconds(cat), [cat]);
  const songs = useMemo(() => [...distinctSongs(nights)], [nights]);
  const known = useMemo(() => songs.filter((id) => secs.has(id)).map((id) => ({ id, min: secs.get(id)! / 60 })), [songs, secs]);
  const bins = useMemo(() => bin(known, (s) => s.min, LENGTH_EDGES, lengthLabel), [known]);
  const byYear = useMemo(() => medianLengthByYear(nights, years, secs), [nights, years, secs]);
  const [pick, setPick] = useState<string | null>(null);
  if (!known.length) {
    return <ChartCard title="Track length" reading="No track lengths are recorded for the songs in this range."><div className="src">Nothing to show.</div></ChartCard>;
  }
  const med = median(known.map((k) => k.min))!;
  const under4 = known.filter((k) => k.min < 4).length;
  const long = known.filter((k) => k.min >= 12).length;
  const reading = (
    <>
      The typical song runs {mins(med)}; {pct(under4 / known.length)} are under four minutes and {fmtCount(long)} {long === 1 ? "runs" : "run"} twelve or more.
      Length known for {fmtCount(known.length)} of {fmtCount(songs.length)} songs.
    </>
  );
  const data: BarDatum[] = bins.map((b) => ({ key: b.key, label: b.label, values: [b.items.length] }));
  const picked = bins.find((b) => b.key === pick);
  return (
    <ChartCard title="Track length" reading={reading}
      coverage={coverageText(known.length, songs.length, "songs")}
      csv={{
        title: "Track length", header: ["minutes", "songs"],
        rows: bins.map((b) => [b.label, b.items.length]),
      }}>
      <BarChart data={data} height={190} showValues ariaLabel="Songs by track length in minutes (12 and over lumped)"
        onSelect={(p) => setPick(p.key)} />
      {picked && (
        <SongList cat={cat} open={open} heading={`${picked.label} minutes: ${plural(picked.items.length, "song")}`}
          items={[...picked.items].sort((a, b) => b.min - a.min).map((s) => ({ id: s.id, text: mins(s.min) }))} />
      )}
      <h3 className="mi-sub">Median length by year</h3>
      <LineChart labels={years} height={170} format={mins} ariaLabel="Median song length in minutes, by year"
        series={[{ key: "len", label: "median length", values: byYear }]}
        onSelect={(p) => open({ kind: "year", year: p.key })} />
      <div className="mi-hint">Median over song-nights: a song brought on three nights counts three times.</div>
    </ChartCard>
  );
});

// ------------------------------------------------------- 7. new music

const NewMusicSection = memo(function NewMusicSection({ cat, enrich, ctx, open }: TabProps) {
  const { years, nights } = ctx.report;
  const history = useMemo(() => kpiReport(cat, null).nights, [cat]);
  const first = useMemo(() => firstSightings(history), [history]);
  const newArtists = useMemo(() => newByYear(nights, years, first.artist, "artist"), [nights, years, first]);
  const newSongs = useMemo(() => newByYear(nights, years, first.song, "song"), [nights, years, first]);
  const table = useMemo(
    () => (enrich ? collapse(keyTable(years, newSongs, (id) => songFamily(enrich, id)), 4) : null),
    [years, newSongs, enrich],
  );
  const opening = history[0]?.date.slice(0, 4);
  const aData: BarDatum[] = years.map((y) => ({
    key: y, label: y, values: [newArtists.get(y)!.size],
    note: [`${plural(newSongs.get(y)!.size, "new song")}`],
  }));
  const total = aData.reduce((a, d) => a + (d.values[0] ?? 0), 0);
  const peak = [...aData].sort((a, b) => (b.values[0] ?? 0) - (a.values[0] ?? 0))[0];
  const withFam = table && table.keys.length > 0;
  const reading = (
    <>
      {fmtCount(total)} artists were heard for the first time ever in this range
      {peak && (peak.values[0] ?? 0) > 0 && <>, most of them in {peak.label} ({fmtCount(peak.values[0] ?? 0)})</>}.
      Judged against the whole history; the first night has no "before", so nothing on it counts as new
      {opening && <> (so {opening} starts one night in)</>}.
    </>
  );
  const sData: BarDatum[] = table ? years.map((y, i) => ({ key: y, label: y, values: table.cells[i], note: knownNote(table.known[i], table.total[i]) })) : [];
  return (
    <ChartCard title="Where new music comes from" reading={reading}
      csv={{
        title: "New music by year", header: ["year", "new artists", "new songs", ...(table && withFam ? ["new songs with a family"] : [])],
        rows: years.map((y, i) => [y, newArtists.get(y)!.size, newSongs.get(y)!.size, ...(table && withFam ? [table.known[i]] : [])]),
      }}>
      <BarChart data={aData} height={190} showValues ariaLabel="New artists per year"
        onSelect={(p) => open({ kind: "year", year: p.key })} />
      {table && withFam && (
        <>
          <h3 className="mi-sub">Genre families of the new songs</h3>
          <div className="mi-cover"><span className="ich-cover">{coverageText(table.cover.known, table.cover.total, "new songs")}</span></div>
          <BarChart data={sData} stacked percent height={210} colour={1} ariaLabel="Genre family share of new songs, by year"
            series={[...table.keys.map((k) => ({ key: k, label: k })), ...(table.rest.length ? [{ key: REST, label: "other families" }] : [])]}
            format={(v) => fmtCount(v)}
            onSelect={(p) => open(p.series === REST ? { kind: "year", year: p.key } : { kind: "family", family: p.series })} />
          <div className="mi-hint">Each bar is the new songs of that year whose family is known; the badge says how many that is.</div>
        </>
      )}
      {enrich && !withFam && <div className="src">No new song in this range has a genre family yet.</div>}
    </ChartCard>
  );
});

// ---------------------------------------------------------------- registry

export const MUSIC_CHART_SECTIONS: SectionDef[] = [
  { id: "m-sounds", label: "Sounds over time", Body: SoundsSection },
  { id: "m-decades", label: "Release decades", Body: DecadesSection },
  { id: "m-map", label: "Genre x decade map", Body: MapSection },
  { id: "m-concentration", label: "Concentration", Body: ConcentrationSection },
  { id: "m-lifespans", label: "Song lifespans", Body: LifespanSection },
  { id: "m-length", label: "Track length", Body: LengthSection },
  { id: "m-new", label: "Where new music comes from", Body: NewMusicSection },
];

/** Sections that have nothing to draw without the music-database layer. */
export const ENRICH_ONLY = new Set(["m-sounds", "m-decades", "m-map"]);
