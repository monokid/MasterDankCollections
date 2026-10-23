/** What a decade of playlists turns out to say.
 *
 *  Every bar is a door: click it and the drilldown opens beside the charts,
 *  and anything in there opens the next level. The whole page can be narrowed
 *  to a span -- drawn on the timeline, or by clicking a year -- and every
 *  figure follows. Figures that are facts about history (who first brought a
 *  song, how long it lasted) deliberately do not follow it, and say so.
 *
 *  Counts are of named tracks on dated nights: an anonymised copy is the same
 *  playlist again, and a collection is a shelf, not a night.
 *
 *  Cost: each section is its own component that computes its own figures, and
 *  only once it has scrolled within reach (a skeleton stands in until then), so
 *  opening the page computes the first screen instead of all eight. A section
 *  folded away computes nothing. Opening a drilldown re-renders none of them.
 */
import {
  createContext, memo, useCallback, useContext, useDeferredValue, useEffect, useMemo, useRef, useState,
  type ComponentType, type ReactNode,
} from "react";
import type { Catalog, Event, Track } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import DrillPanel, { drillName, type Drill } from "./Drill.tsx";
import {
  artistYears, cast, comebacks, discovery, evolutions, genreCoverage, lifespans, lowest,
  nightsOf, oneOffs, playedOf, realGenres, soloArtists, soloSongs, tastemakers, trendBreaks,
  qualityByYear, qualityCoverage, qualityByPerson, upgradeCandidates, weakestNights,
  type Range, type Trend, type QualityYear,
} from "./analytics.ts";
import { fmtCount, fmtHours, plural } from "./format.ts";
import {
  csvFilename, downloadText, scrollRootOf, sectionAt, toCsv, type Cell,
} from "./pagehelpers.ts";
import { useSessionState } from "./hooks.ts";
import { ChevronIcon, DownloadIcon } from "./icons.tsx";
import "./pages.css";

const TOP = 20;

interface Row { label: string; sub?: string; value: number; text?: string; drill?: Drill }

/** Appended to CSV file names so a download says which range it came from. */
const RangeTag = createContext("");
const rangeTag = (r: Range | null) => (r ? `${r.from}_${r.to}` : "");

function CsvButton({ title, header, rows }: { title: string; header: string[]; rows: Cell[][] }) {
  const tag = useContext(RangeTag);
  if (!rows.length) return null;
  return (
    <button className="csvbtn" title="Download these figures as a spreadsheet (CSV)"
      aria-label={`Download ${title} as CSV`}
      onClick={() => downloadText(csvFilename(title, tag), toCsv(header, rows))}>
      <DownloadIcon size={14} /> CSV
    </button>
  );
}

const Chart = memo(function Chart({ title, note, rows, onDrill, tall }: {
  title: string; note?: string; rows: Row[]; onDrill: (d: Drill) => void; tall?: boolean;
}) {
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className={`panel chart${tall ? " tall" : ""}`}>
      <div className="charthead">
        <h2>{title}</h2>
        <CsvButton title={title} header={["label", "detail", "value", "text"]}
          rows={rows.map((r) => [r.label, r.sub, r.value, r.text])} />
      </div>
      {note && <div className="chart-note">{note}</div>}
      {rows.length === 0 && <div className="src">not enough data</div>}
      {rows.map((r, i) => (
        <div key={r.label + i} className={`bar${r.drill ? " clickable" : ""}`}
          onClick={() => r.drill && onDrill(r.drill)}
          role={r.drill ? "button" : undefined} tabIndex={r.drill ? 0 : undefined}
          onKeyDown={(e) => { if (r.drill && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onDrill(r.drill); } }}
          title={r.drill ? "Open the detail" : undefined}>
          <span className="rank">{i + 1}</span>
          <span className="track">
            <span className="fill" style={{ width: `${(r.value / max) * 100}%` }} />
            <span className="label">{r.label}{r.sub && <i className="sublabel">{r.sub}</i>}</span>
          </span>
          <span className="val">{r.text ?? r.value}</span>
        </div>
      ))}
    </div>
  );
});

const BAND_LABEL = { lossless: "lossless", high: "256+ kbps", mid: "160–255 kbps", low: "under 160 kbps" } as const;

/** Every file's quality, a column a year, split into the four rungs. A click on
 *  a column opens the year. */
function QualityBlock({ years, onDrill }: { years: QualityYear[]; onDrill: (d: Drill) => void }) {
  return (
    <div className="panel chart">
      <div className="charthead">
        <h2>Quality of the files, by year</h2>
        <CsvButton title="Quality of the files, by year"
          header={["year", "files", "lossless", "256+ kbps", "160-255 kbps", "under 160 kbps", "median kbps (lossy)"]}
          rows={years.map((q) => [q.year, q.files, q.lossless, q.high, q.mid, q.low, q.medianKbps])} />
      </div>
      <div className="chart-note">Share of each year's files in each rung. Anonymised copies count: they are files too.</div>
      <div className="stack" role="img" aria-label="File quality by year">
        {years.map((q) => (
          <div key={q.year} className="stack-col clickable" role="button" tabIndex={0}
            title={`${q.year}: ${q.files} files, median ${q.medianKbps ?? "–"} kbps (lossy)`}
            onClick={() => onDrill({ kind: "year", year: q.year })}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDrill({ kind: "year", year: q.year }); } }}>
            <div className="stack-bar">
              {(["lossless", "high", "mid", "low"] as const).map((b) => (
                <div key={b} className={`seg ${b}`} style={{ height: `${(q[b] / q.files) * 100}%` }} />
              ))}
            </div>
            <span>{q.year.slice(2)}</span>
          </div>
        ))}
      </div>
      <div className="legend">
        {(["lossless", "high", "mid", "low"] as const).map((b) => (
          <span key={b}><i className={`seg ${b}`} />{BAND_LABEL[b]}</span>
        ))}
      </div>
    </div>
  );
}

/** One yearly series with the years that break the trend marked, and what each
 *  break says. A click on a reading opens that year. */
function TrendBlock({ trend, onDrill }: { trend: Trend; onDrill: (d: Drill) => void }) {
  const max = Math.max(...trend.points.map((p) => p.value), 1);
  return (
    <div className="panel chart">
      <div className="charthead">
        <h2>{trend.title}</h2>
        <CsvButton title={trend.title} header={["year", "value", "breaks the trend"]}
          rows={trend.points.map((p) => [p.year, Math.round(p.value * 100) / 100, p.flagged ? "yes" : ""])} />
      </div>
      <div className="spark" role="img" aria-label={`${trend.title} by year`}>
        {trend.points.map((p) => (
          <div key={p.year} className={`spark-col${p.flagged ? " flag" : ""}`}
            title={`${p.year}: ${Math.round(p.value * 100) / 100}${p.flagged ? " (breaks the trend)" : ""}`}>
            <div className="spark-bar" style={{ height: `${Math.max((p.value / max) * 100, p.value ? 6 : 0)}%` }} />
            <span>{p.year.slice(2)}</span>
          </div>
        ))}
      </div>
      {trend.breaks.length === 0 && <div className="reading"><span className="calm">No year stands out from its neighbours.</span></div>}
      {trend.breaks.map((b) => (
        <div key={b.year} className="reading clickable" role="button" tabIndex={0}
          onClick={() => onDrill({ kind: "year", year: b.year })}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onDrill({ kind: "year", year: b.year }); } }}>
          {b.reading}
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ sections

interface Agg { song: Map<string, { nights: Set<string>; plays: number }>; artist: Map<string, { nights: Set<string>; plays: number }> }

/** What every section is given. One object, so a section re-renders only when
 *  the catalogue or the range really changes. */
interface Data {
  cat: Catalog; range: Range | null; nights: Event[]; T: Track[]; agg: Agg;
  open: (d: Drill) => void;
  people: Map<string, Catalog["people"][number]>;
}

const SECTIONS = [
  { id: "canon", label: "The canon" },
  { id: "discovery", label: "Discovery" },
  { id: "longevity", label: "Longevity" },
  { id: "people", label: "People" },
  { id: "trends", label: "Trends" },
  { id: "outliers", label: "Outliers" },
  { id: "quality", label: "Sound quality" },
  { id: "unusual", label: "Unusual" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

const CanonSection = memo(function CanonSection({ d }: { d: Data }) {
  const { cat, agg, open } = d;
  const songs = useMemo(() => new Map(cat.songs.map((s) => [s.id, s])), [cat]);
  const artists = useMemo(() => new Map(cat.artists.map((a) => [a.id, a])), [cat]);
  const { canonRows, recurring, once, artistRows } = useMemo(() => {
    const recurringSongs = [...agg.song.entries()].filter(([, v]) => v.nights.size > 1);
    return {
      canonRows: recurringSongs
        .sort((a, b) => b[1].nights.size - a[1].nights.size || b[1].plays - a[1].plays)
        .slice(0, TOP)
        .map(([id, v]): Row => {
          const s = songs.get(id);
          return {
            label: s?.title ?? id, sub: s?.artist, value: v.nights.size,
            text: `${v.nights.size} nights`, drill: { kind: "song", id },
          };
        }),
      recurring: recurringSongs.length,
      once: agg.song.size - recurringSongs.length,
      artistRows: [...agg.artist.entries()]
        .sort((a, b) => b[1].nights.size - a[1].nights.size || b[1].plays - a[1].plays)
        .slice(0, TOP)
        .map(([id, v]): Row => ({
          label: artists.get(id)?.name ?? id, value: v.nights.size,
          text: `${v.nights.size} nights`, drill: { kind: "artist", id },
        })),
    };
  }, [agg, songs, artists]);
  const loyalRows = useMemo<Row[]>(() => artistYears(cat).slice(0, TOP).map((l) => ({
    label: l.artist.name, value: l.years, text: `${l.years} years`,
    drill: { kind: "artist" as const, id: l.artist.id },
  })), [cat]);
  return (
    <div className="charts">
      <Chart tall title="Songs that keep coming back" rows={canonRows} onDrill={open}
        note={`${fmtCount(recurring)} songs were played on more than one night. ${fmtCount(once)} were played exactly once.`} />
      <Chart tall title="Artists across the most nights" rows={artistRows} onDrill={open} />
      <Chart tall title="Artist loyalty" rows={loyalRows} onDrill={open}
        note="Different years an artist turned up in — not nights. All history." />
    </div>
  );
});

const DiscoverySection = memo(function DiscoverySection({ d }: { d: Data }) {
  const { cat, range, nights, people, open } = d;
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

const LongevitySection = memo(function LongevitySection({ d }: { d: Data }) {
  const { cat, open } = d;
  const spans = useMemo(() => lifespans(cat).slice(0, TOP).map((s): Row => ({
    label: s.song.title, sub: s.song.artist, value: s.years, text: `${s.years} yrs`,
    drill: { kind: "song", id: s.song.id },
  })), [cat]);
  const comeback = useMemo(() => comebacks(cat), [cat]);
  const comebackRows = useMemo<Row[]>(() => comeback.slice(0, TOP).map((c) => ({
    label: c.song.title, sub: c.song.artist, value: c.gapYears, text: `${c.gapYears.toFixed(1)} yrs`,
    drill: { kind: "song" as const, id: c.song.id },
  })), [comeback]);
  return (
    <div className="charts">
      <Chart tall title="Outliving the trends" onDrill={open} rows={spans}
        note="Years between a song's first and last night. All history." />
      <Chart tall title="Comebacks" onDrill={open} rows={comebackRows}
        note={`${comeback.length} songs vanished for 5+ years and returned. Longest gaps shown.`} />
    </div>
  );
});

const PeopleSection = memo(function PeopleSection({ d }: { d: Data }) {
  const { cat, range, open } = d;
  const personRows = useMemo<Row[]>(() => cat.people.map((p) => ({
    label: p.name, value: p.trackCount, text: `${fmtCount(p.trackCount)} tracks`,
    drill: { kind: "person", id: p.id },
  })), [cat]);
  const signature = useMemo<Row[]>(() => cat.people.map((p) => ({
    label: p.name,
    value: cat.artists.filter((a) => a.people.length === 1 && a.people[0] === p.id && a.plays >= 3).length,
    drill: { kind: "person" as const, id: p.id },
  })).filter((r) => r.value > 0).sort((a, b) => b.value - a.value), [cat]);
  const shared = useMemo<Row[]>(() => {
    const out: Row[] = [];
    for (let i = 0; i < cat.people.length; i++) for (let j = i + 1; j < cat.people.length; j++) {
      const a = cat.people[i], b = cat.people[j];
      const n = cat.artists.filter((x) => x.people.includes(a.id) && x.people.includes(b.id)).length;
      if (n > 0) out.push({ label: `${a.name} + ${b.name}`, value: n, text: `${n} artists` });
    }
    return out.sort((x, y) => y.value - x.value).slice(0, TOP);
  }, [cat]);
  const castRows = useMemo<Row[]>(() => cast(cat, range).map((c) => ({
    label: c.year, value: Math.round(c.avgPeople * 10) / 10,
    text: `${c.avgPeople.toFixed(1)} people`, sub: plural(c.nights, "night"),
    drill: { kind: "year", year: c.year },
  })), [cat, range]);
  return (
    <div className="charts">
      <Chart title="Tracks brought" rows={personRows} onDrill={open} />
      <Chart title="Artists nobody else brings" rows={signature} onDrill={open}
        note="Artists played 3+ times and only ever by this one person." />
      <Chart title="Shared taste" rows={shared} onDrill={open}
        note="Artists both people have brought." />
      <Chart title="The cast over time" rows={castRows} onDrill={open}
        note="Average number of contributors per night." />
    </div>
  );
});

const TrendsSection = memo(function TrendsSection({ d }: { d: Data }) {
  const { T, nights, open } = d;
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

const OutliersSection = memo(function OutliersSection({ d }: { d: Data }) {
  const { T, nights, open } = d;
  const longestNights = useMemo<Row[]>(() => [...nights].sort((a, b) => b.durationSec - a.durationSec).slice(0, TOP)
    .map((e) => ({
      label: e.date!, sub: e.title || e.types.join(" + "), value: Math.round(e.durationSec / 360) / 10,
      text: `${fmtHours(e.durationSec)} h`, drill: { kind: "night", id: e.id },
    })), [nights]);
  const longestTracks = useMemo<Row[]>(() => T.filter((t) => t.durationSec)
    .sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0)).slice(0, TOP)
    .map((t) => ({
      label: t.title ?? "?", sub: t.artist ?? undefined, value: Math.round((t.durationSec ?? 0) / 60),
      text: `${Math.round((t.durationSec ?? 0) / 60)} min`,
      drill: t.songId ? { kind: "song" as const, id: t.songId } : undefined,
    })), [T]);
  return (
    <div className="charts">
      <Chart tall title="Longest nights" rows={longestNights} onDrill={open}
        note="Running time of what was played, each playlist counted once." />
      <Chart tall title="Longest tracks" rows={longestTracks} onDrill={open} />
    </div>
  );
});

const QualitySection = memo(function QualitySection({ d }: { d: Data }) {
  const { cat, range, people, open } = d;
  const quality = useMemo(() => qualityByYear(cat, range), [cat, range]);
  const qCover = useMemo(() => qualityCoverage(cat), [cat]);
  const weak = useMemo(() => weakestNights(cat, range), [cat, range]);
  const qPeople = useMemo(() => qualityByPerson(cat, range), [cat, range]);
  const upgrades = useMemo(() => upgradeCandidates(cat), [cat]);
  const who = (id: string) => people.get(id)?.name ?? id;
  return (
    <>
      <p className="sub">
        Measured on {fmtCount(qCover.known)} of {fmtCount(qCover.files)} files — every audio
        file on a dated night. {fmtCount(qCover.noFile)} tracks exist only as Spotify playlist
        entries; they have no file to measure and are left out.
      </p>
      <QualityBlock years={quality} onDrill={open} />
      <div className="charts" style={{ marginTop: 20 }}>
        <Chart tall title="Nights with the weakest files" onDrill={open}
          note="Share of a night's files under 160 kbps (at least 10 measured). Follows the range."
          rows={weak.map((w) => ({
            label: w.event.date ?? w.event.id, sub: w.event.type ?? undefined,
            value: Math.round(w.share * 100), text: `${w.low} of ${w.files}`,
            drill: { kind: "night" as const, id: w.event.id },
          }))} />
        <Chart tall title="Whose files are weakest" onDrill={open}
          note="Share of each person's files under 160 kbps. 30+ files. Follows the range."
          rows={[...qPeople].sort((a, b) => b.low / b.files - a.low / a.files).map((p) => ({
            label: who(p.personId), value: Math.round((p.low / p.files) * 100),
            text: `${Math.round((p.low / p.files) * 100)}% · ${p.lossless} lossless of ${p.files}`,
            drill: { kind: "person" as const, id: p.personId },
          }))} />
        <Chart tall title="Worth replacing" onDrill={open}
          note={`${fmtCount(upgrades.total)} of ${fmtCount(upgrades.known)} songs exist only in files under 160 kbps. Shown: the ones played most nights. All history.`}
          rows={upgrades.rows.map((u) => ({
            label: u.song.title, sub: u.song.artist, value: u.nights,
            text: `${u.kbps} kbps · ${plural(u.nights, "night")}`,
            drill: { kind: "song" as const, id: u.song.id },
          }))} />
      </div>
    </>
  );
});

const UnusualSection = memo(function UnusualSection({ d }: { d: Data }) {
  const { cat, range, people, open } = d;
  const trends = useMemo(() => trendBreaks(cat, range), [cat, range]);
  const lows = useMemo(() => lowest(cat, range), [cat, range]);
  const evo = useMemo(() => evolutions(cat, range), [cat, range]);
  const soloA = useMemo(() => soloArtists(cat), [cat]);
  const soloS = useMemo(() => soloSongs(cat), [cat]);
  const lone = useMemo(() => oneOffs(cat), [cat]);
  const who = (id: string) => people.get(id)?.name ?? id;
  const evoRow = (t: { artist: { id: string; name: string }; early: number; late: number }): Row => ({
    label: t.artist.name, value: Math.round(Math.abs(t.late - t.early) * 100),
    text: `${Math.round(t.early * 100)}% → ${Math.round(t.late * 100)}%`,
    drill: { kind: "artist", id: t.artist.id },
  });
  return (
    <>
      <p className="sub">
        A year is marked when it is at least twice or at most half the median of the two years
        either side of it (and the gap is more than a rounding error). It follows the range above.
      </p>
      <div className="charts">
        {trends.map((t) => <TrendBlock key={t.key} trend={t} onDrill={open} />)}
      </div>

      <div className="charts" style={{ marginTop: 20 }}>
        <div className="panel chart">
          <div className="charthead">
            <h2>Lowest results</h2>
            <CsvButton title="Lowest results" header={["measure", "when", "result", "tied with"]}
              rows={lows.map((l) => [l.title, l.at.kind === "year" ? l.at.year : l.at.id, l.text, l.ties])} />
          </div>
          <div className="chart-note">The floor of each measure. Follows the range.</div>
          {lows.length === 0 && <div className="src">not enough data</div>}
          {lows.map((l) => {
            const dr: Drill = l.at.kind === "year" ? { kind: "year", year: l.at.year } : { kind: "night", id: l.at.id };
            const when = l.at.kind === "year" ? l.at.year : l.at.id;
            return (
              <div key={l.key} className="low clickable" role="button" tabIndex={0} onClick={() => open(dr)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(dr); } }}>
                <span className="k">{l.title}</span>
                <span>{when}{l.ties > 0 && <i className="sublabel">and {l.ties} other{l.ties === 1 ? "" : "s"} tied</i>}</span>
                <span className="v">{l.text}</span>
              </div>
            );
          })}
        </div>
        <Chart tall title="Artists only one person brings" onDrill={open}
          note={`${soloA.length} artists have been on 3+ nights and always from the same person. All history.`}
          rows={soloA.slice(0, TOP).map((s) => ({
            label: s.label, sub: `only ${who(s.personId)}`, value: s.nights, text: `${s.nights} nights`,
            drill: { kind: "artist" as const, id: s.id },
          }))} />
        <Chart tall title="Songs only one person keeps bringing" onDrill={open}
          note={`${soloS.length} songs came back on 3+ nights, always from the same person. All history.`}
          rows={soloS.slice(0, TOP).map((s) => ({
            label: s.label, sub: `${s.sub} · only ${who(s.personId)}`, value: s.nights, text: `${s.nights} nights`,
            drill: { kind: "song" as const, id: s.id },
          }))} />
        <Chart tall title="Played once, never back" onDrill={open}
          note={`${fmtCount(lone.total)} of ${fmtCount(lone.songs)} songs were played on a single night and not since. Shown: one per artist, for the artists with the most nights. All history.`}
          rows={lone.rows.slice(0, TOP).map((o) => ({
            label: o.song.title, sub: o.song.artist, value: o.artistNights, text: o.date,
            drill: { kind: "song" as const, id: o.song.id },
          }))} />
        <Chart tall title="Rising artists" onDrill={open}
          note={evo.split ? `Share of nights an artist appeared on, first half of the nights against the second (the split falls at ${evo.split}). 5+ nights. Follows the range.` : "Needs at least four nights in range."}
          rows={evo.rising.map(evoRow)} />
        <Chart tall title="Fading artists" onDrill={open}
          note={evo.split ? "The same measure, falling instead of rising." : "Needs at least four nights in range."}
          rows={evo.fading.map(evoRow)} />
      </div>
    </>
  );
});

const BODY: Record<SectionId, ComponentType<{ d: Data }>> = {
  canon: CanonSection, discovery: DiscoverySection, longevity: LongevitySection,
  people: PeopleSection, trends: TrendsSection, outliers: OutliersSection,
  quality: QualitySection, unusual: UnusualSection,
};

// -------------------------------------------------------------------- shell

/** A stand-in the height of a typical section while it waits to scroll in. */
function Skeleton() {
  return (
    <div className="skel-grid" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="panel skel">
          <span className="skel-line w60" />
          {Array.from({ length: 7 }, (_, k) => <span key={k} className="skel-line" style={{ width: `${92 - k * 9}%` }} />)}
        </div>
      ))}
    </div>
  );
}

/** Computes nothing until it has scrolled within reach (or something asked for
 *  it, like a jump chip), and nothing at all while folded away. */
function Section({ id, label, forced, folded, onToggle, children }: {
  id: SectionId; label: string; forced: boolean; folded: boolean; onToggle: (id: SectionId) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (seen || forced || !el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: "700px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen, forced]);
  const live = seen || forced;
  return (
    <section ref={ref} id={`ins-${id}`} data-sec={id} className={`inssec${folded ? " is-folded" : ""}`}>
      <h2 className="section">
        <button className="secfold" aria-expanded={!folded} aria-controls={`ins-body-${id}`}
          title={folded ? "Show this section" : "Fold this section away"} onClick={() => onToggle(id)}>
          <ChevronIcon size={16} />{label}
        </button>
      </h2>
      <div id={`ins-body-${id}`} hidden={folded}>
        {!folded && (live ? children : <Skeleton />)}
      </div>
    </section>
  );
}

export default function Insights({ cat, range, onRange, onTrace, onOpenNight }: {
  cat: Catalog;
  range: Range | null;
  onRange: (r: Range | null) => void;
  onTrace: (t: Trace) => void;
  onOpenNight: (id: string) => void;
}) {
  const [stack, setStack] = useState<Drill[]>([]);
  const drill = stack[stack.length - 1] ?? null;
  const open = useCallback((d: Drill) => setStack((s) => [...s, d]), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const close = useCallback(() => setStack([]), []);

  const [foldedIds, setFoldedIds] = useSessionState<string[]>("insights.folded", []);
  const folded = useMemo(() => new Set(foldedIds), [foldedIds]);
  const toggleFold = useCallback((id: SectionId) =>
    setFoldedIds((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id])), [setFoldedIds]);

  // A range change recomputes the sections at lower priority; they dim until done.
  const dRange = useDeferredValue(range);
  const updating = dRange !== range;

  const people = useMemo(() => new Map(cat.people.map((p) => [p.id, p])), [cat]);
  const nights = useMemo(() => nightsOf(cat, dRange), [cat, dRange]);
  const T = useMemo(() => playedOf(cat, dRange), [cat, dRange]);

  // What each song and artist did *within the range*.
  const agg = useMemo<Agg>(() => {
    const song = new Map<string, { nights: Set<string>; plays: number }>();
    const artist = new Map<string, { nights: Set<string>; plays: number }>();
    for (const t of T) {
      if (!t.songId) continue;
      const s = song.get(t.songId) ?? { nights: new Set<string>(), plays: 0 };
      s.nights.add(t.eventId); s.plays++; song.set(t.songId, s);
      const aid = t.songId.split("|")[0];
      const a = artist.get(aid) ?? { nights: new Set<string>(), plays: 0 };
      a.nights.add(t.eventId); a.plays++; artist.set(aid, a);
    }
    return { song, artist };
  }, [T]);

  const data = useMemo<Data>(
    () => ({ cat, range: dRange, nights, T, agg, open, people }),
    [cat, dRange, nights, T, agg, open, people]);

  const hours = nights.reduce((s, n) => s + n.durationSec, 0) / 3600;
  const recurring = useMemo(() => [...agg.song.values()].filter((v) => v.nights.size > 1).length, [agg]);

  // ------------------------------------------------ section chips & scroll-spy
  const tocRef = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState<SectionId | null>(null);
  const [armedTo, setArmedTo] = useState(-1);          // sections up to this index are forced live
  const [jump, setJump] = useState<SectionId | null>(null);

  useEffect(() => {
    const root = scrollRootOf(tocRef.current);
    if (!root) return;
    let raf = 0;
    const spy = () => {
      raf = 0;
      const secs = [...root.querySelectorAll<HTMLElement>("[data-sec]")];
      const line = root.getBoundingClientRect().top + (tocRef.current?.offsetHeight ?? 0) + 24;
      const atBottom = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      const i = sectionAt(secs.map((s) => s.getBoundingClientRect().top), line, atBottom);
      setCurrent(i >= 0 ? (secs[i].dataset.sec as SectionId) : null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    root.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // A chip: unfold the target, make everything above it real so nothing
  // changes height under the scroll, then scroll once that has rendered.
  const goto = (id: SectionId) => {
    const i = SECTIONS.findIndex((s) => s.id === id);
    setFoldedIds((f) => f.filter((x) => x !== id));
    setArmedTo((a) => Math.max(a, i));
    setJump(id);
  };
  useEffect(() => {
    if (!jump) return;
    const root = scrollRootOf(tocRef.current);
    const el = root?.querySelector<HTMLElement>(`#ins-${jump}`);
    setJump(null);
    if (!root || !el) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.scrollTo({ top: top - (tocRef.current?.offsetHeight ?? 0) - 6, behavior: reduced ? "auto" : "smooth" });
  }, [jump]);

  // Keep the current chip in view in the (sideways-scrolling) strip.
  useEffect(() => {
    const strip = tocRef.current?.querySelector<HTMLElement>(".strip");
    const chip = strip?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!strip || !chip) return;
    strip.scrollTo({ left: chip.offsetLeft - (strip.clientWidth - chip.offsetWidth) / 2 });
  }, [current]);

  const stats = cat.stats;
  const backTo = stack.length > 1 ? drillName(cat, stack[stack.length - 2]) : undefined;

  return (
    <RangeTag.Provider value={rangeTag(dRange)}>
      <div className={`page wide insights${drill ? " has-drill" : ""}`}>
        <div className={`ins-main${updating ? " is-updating" : ""}`}>
          <h1>Insights</h1>
          <p className="sub">
            Named tracks on dated nights only. <b>Click any bar</b> to open what is under it;
            click a year to narrow the whole page to it.
          </p>

          <div className="statgrid">
            <div className="stat"><div className="v">{fmtCount(T.length)}</div><div className="k">tracks played</div></div>
            <div className="stat"><div className="v">{fmtCount(agg.song.size)}</div><div className="k">distinct songs</div></div>
            <div className="stat"><div className="v">{fmtCount(recurring)}</div><div className="k">played more than once</div></div>
            <div className="stat"><div className="v">{fmtCount(agg.artist.size)}</div><div className="k">artists</div></div>
            <div className="stat"><div className="v">{fmtCount(nights.length)}</div><div className="k">nights</div></div>
            <div className="stat"><div className="v">{dRange ? hours.toFixed(0) : stats.totalHours}h</div><div className="k">of music</div></div>
          </div>

          <nav className="instoc" ref={tocRef} aria-label="Sections of this page">
            <div className="strip toc-chips">
              {SECTIONS.map((s) => (
                <button key={s.id} className="tocchip" aria-current={current === s.id}
                  onClick={() => goto(s.id)}>{s.label}</button>
              ))}
            </div>
            {range && (
              <div className="toc-range" role="status">
                <span>
                  <b>{range.from}</b> → <b>{range.to}</b> · {plural(nights.length, "night")}
                </span>
                <button className="resetrange" onClick={() => onRange(null)}
                  title="Show the whole decade again">Reset range</button>
              </div>
            )}
          </nav>

          {SECTIONS.map((s, i) => {
            const Body = BODY[s.id];
            return (
              <Section key={s.id} id={s.id} label={s.label} forced={i <= armedTo}
                folded={folded.has(s.id)} onToggle={toggleFold}>
                <Body d={data} />
              </Section>
            );
          })}
        </div>

        {drill && (
          <DrillPanel cat={cat} drill={drill} range={range} canBack={stack.length > 1} backLabel={backTo}
            onBack={back} onClose={close} onDrill={open}
            onTrace={onTrace} onRange={(r) => { onRange(r); close(); }}
            onOpenNight={onOpenNight} />
        )}
      </div>
    </RangeTag.Provider>
  );
}
