/** The Music tab's long-standing sections, moved out of Insights.tsx as they
 *  were: the canon, longevity, songs played once, and what only one person brings. */
import { memo, useMemo } from "react";
import { artistYears, comebacks, lifespans, oneOffs, soloArtists, soloSongs } from "../analytics.ts";
import { fmtCount } from "../format.ts";
import { Chart, TOP } from "./shared.tsx";
import type { Row, SectionDef, TabProps } from "./types.ts";

const CanonSection = memo(function CanonSection({ cat, ctx, open }: TabProps) {
  const { agg } = ctx;
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

const LongevitySection = memo(function LongevitySection({ cat, open }: TabProps) {
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

const OneOffsSection = memo(function OneOffsSection({ cat, open }: TabProps) {
  const lone = useMemo(() => oneOffs(cat), [cat]);
  return (
    <div className="charts">
      <Chart tall title="Played once, never back" onDrill={open}
        note={`${fmtCount(lone.total)} of ${fmtCount(lone.songs)} songs were played on a single night and not since. Shown: one per artist, for the artists with the most nights. All history.`}
        rows={lone.rows.slice(0, TOP).map((o) => ({
          label: o.song.title, sub: o.song.artist, value: o.artistNights, text: o.date,
          drill: { kind: "song" as const, id: o.song.id },
        }))} />
    </div>
  );
});

const SoloSection = memo(function SoloSection({ cat, ctx, open }: TabProps) {
  const { people } = ctx;
  const soloA = useMemo(() => soloArtists(cat), [cat]);
  const soloS = useMemo(() => soloSongs(cat), [cat]);
  const who = (id: string) => people.get(id)?.name ?? id;
  return (
    <div className="charts">
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
    </div>
  );
});

export const MUSIC_SECTIONS: SectionDef[] = [
  { id: "canon", label: "The canon", Body: CanonSection },
  { id: "longevity", label: "Longevity", Body: LongevitySection },
  { id: "oneoffs", label: "Played once", Body: OneOffsSection },
  { id: "solo", label: "Solo artists", Body: SoloSection },
];
