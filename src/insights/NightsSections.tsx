/** The Nights & sound tab's long-standing sections, moved out of Insights.tsx as
 *  they were: outliers (the floor of each measure, the longest nights and
 *  tracks) and the quality of the files. */
import { memo, useMemo } from "react";
import {
  lowest, qualityByPerson, qualityByYear, qualityCoverage, upgradeCandidates, weakestNights,
} from "../analytics.ts";
import { fmtCount, fmtHours, plural } from "../format.ts";
import { Chart, CsvButton, QualityBlock, TOP } from "./shared.tsx";
import type { Drill, Row, SectionDef, TabProps } from "./types.ts";

const OutliersSection = memo(function OutliersSection({ cat, range, ctx, open }: TabProps) {
  const { T, nights } = ctx;
  const lows = useMemo(() => lowest(cat, range), [cat, range]);
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
      <Chart tall title="Longest nights" rows={longestNights} onDrill={open}
        note="Running time of what was played, each playlist counted once." />
      <Chart tall title="Longest tracks" rows={longestTracks} onDrill={open} />
    </div>
  );
});

const QualitySection = memo(function QualitySection({ cat, range, ctx, open }: TabProps) {
  const { people } = ctx;
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

export const NIGHTS_SECTIONS: SectionDef[] = [
  { id: "outliers", label: "Outliers", Body: OutliersSection },
  { id: "quality", label: "Sound quality", Body: QualitySection },
];
