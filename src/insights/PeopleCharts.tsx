/** The People tab's group-level views: who was there, how big the nights were,
 *  how the group changed, how taste overlaps, the shape of each person's sets
 *  and how songs get handed on. Per-person profiles live on the People page.
 *  Maths is in src/peopleinsights.ts. Nobody is ranked: people are in joining
 *  order everywhere, and every comparison uses shared scales. */
import { memo, useMemo, useState } from "react";
import { BarChart, ChartCard, Heatmap, LineChart, Stack100, coverageText } from "../charts.tsx";
import { peopleIndex } from "../peoplestats.ts";
import { attendance, changes, groupSize, handing, overlap, shapes, sharedArtists } from "../peopleinsights.ts";
import { fmtCount, plural } from "../format.ts";
import "../insights-people.css";
import type { SectionDef, TabProps } from "./types.ts";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The range's night ids and the people index, shared by every card. */
function useScope({ cat, ctx }: TabProps) {
  const ix = useMemo(() => peopleIndex(cat), [cat]);
  const ids = useMemo(() => new Set(ctx.nights.map((n) => n.id)), [ctx.nights]);
  return { ix, ids };
}

// ------------------------------------------------------------ who was there

const WhoWasThere = memo(function WhoWasThere(props: TabProps) {
  const { ix, ids } = useScope(props);
  const a = useMemo(() => attendance(ix, ids), [ix, ids]);
  if (!a.people.length) return <p className="src">No nights with people in this range.</p>;
  const steady = a.people.filter((_, i) => {
    const cells = a.share[i].map((v, j) => (v === null ? null : { c: a.counts[i][j], n: a.nightsPerYear[j] }));
    const c = cells.filter((x) => x !== null) as Array<{ c: number; n: number }>;
    const n = c.reduce((s, x) => s + x.n, 0);
    return n > 0 && c.reduce((s, x) => s + x.c, 0) / n >= 0.8;
  }).length;
  const reading = `${plural(a.people.length, "person", "people")} across ${plural(props.ctx.nights.length, "night")}, in the order they first appeared. `
    + `${steady} came to at least four in five of the nights between their first and last year; the others came and went in stretches. `
    + `Hatched cells are years before someone joined or after their last night.`;
  return (
    <ChartCard title="Who was there" reading={reading}
      coverage={coverageText(a.people.length, props.cat.people.length, "people in the library")}
      csv={{
        header: ["person", ...a.years.map(String)],
        rows: a.people.map((p, i) => [p.name, ...a.share[i].map((v) => (v === null ? "" : Math.round(v * 100) / 100))]),
      }}>
      <Heatmap rows={a.people.map((p) => p.name)} cols={a.years.map(String)}
        rowKeys={a.people.map((p) => p.id)} colKeys={a.years.map(String)}
        values={a.share} format={pct} valueLabel="share of that year's nights"
        ariaLabel="Share of each year's nights each person attended"
        onSelect={(c) => props.open({ kind: "year", year: c.col })} />
    </ChartCard>
  );
});

// -------------------------------------------------------------- group size

const GroupSize = memo(function GroupSize(props: TabProps) {
  const { ix, ids } = useScope(props);
  const g = useMemo(() => groupSize(ix, ids), [ix, ids]);
  if (!g.nights) return <p className="src">No nights in this range.</p>;
  const data = g.sizes.map((n, size) => ({ key: String(size), label: String(size), values: [n] })).filter((d) => d.key !== "0" || d.values[0] > 0);
  const c = g.common;
  const reading = c
    ? `Most nights had ${c.from === c.to ? c.from : `${c.from}-${c.to}`} people (${plural(c.nights, "night")} of ${g.nights}). `
      + `The line shows the average number of people per night in each year.`
    : "";
  return (
    <ChartCard title="Group size" reading={reading}
      csv={{ header: ["people", "nights"], rows: g.sizes.map((n, s) => [s, n]) }}>
      <BarChart data={data} height={170} showValues ariaLabel="Nights by number of people"
        format={(v) => String(Math.round(v))}
        onSelect={(p) => props.open({ kind: "size", size: +p.key })} />
      <p className="pi-sub">Nights by number of people. Select a bar to see those nights.</p>
      <LineChart labels={g.perYear.map((y) => String(y.year))}
        series={[{ key: "avg", label: "People per night", values: g.perYear.map((y) => y.avg) }]}
        rolling={3} rollingLabel="3-year rolling average" height={170}
        format={(v) => v.toFixed(1)} ariaLabel="Average people per night, by year"
        onSelect={(p) => props.open({ kind: "year", year: p.label })} />
    </ChartCard>
  );
});

// --------------------------------------------------------- how it changes

const HowItChanges = memo(function HowItChanges(props: TabProps) {
  const { ix, ids } = useScope(props);
  const ch = useMemo(() => changes(ix, ids), [ix, ids]);
  if (!ch.length) return <p className="src">No nights in this range.</p>;
  const joined = ch.reduce((a, y) => a + y.joined.length, 0);
  const back = ch.reduce((a, y) => a + y.back.length, 0);
  const sentences = ch.filter((y) => y.joined.length || y.back.length || y.away.length).map((y) => {
    const bits = [
      y.joined.length ? `${list(y.joined)} joined` : "",
      y.back.length ? `${list(y.back)} came back` : "",
      y.away.length ? `${list(y.away)} ${y.away.length === 1 ? "was" : "were"} away` : "",
    ].filter(Boolean);
    return { year: y.year, text: `${y.year}: ${bits.join("; ")}.` };
  });
  const reading = `${plural(joined, "person", "people")} joined over the years and ${plural(back, "return")} followed a year away. `
    + `Away means someone who came both before and after, but not that year.`;
  return (
    <ChartCard title="How the group changes" reading={reading}
      csv={{
        header: ["year", "joined", "away", "came back", "who joined", "who was away", "who came back"],
        rows: ch.map((y) => [y.year, y.joined.length, y.away.length, y.back.length, y.joined.join("; "), y.away.join("; "), y.back.join("; ")]),
      }}>
      <BarChart stacked height={190} ariaLabel="People who joined, were away and came back, by year"
        series={[{ key: "joined", label: "Joined" }, { key: "back", label: "Came back" }, { key: "away", label: "Away" }]}
        data={ch.map((y) => ({
          key: String(y.year), label: String(y.year), values: [y.joined.length, y.back.length, y.away.length],
          note: [y.joined.length ? `Joined: ${y.joined.join(", ")}` : "", y.back.length ? `Came back: ${y.back.join(", ")}` : "",
            y.away.length ? `Away: ${y.away.join(", ")}` : ""].filter(Boolean),
        }))}
        format={(v) => String(Math.round(v))}
        onSelect={(p) => props.open({ kind: "year", year: p.key })} />
      <ul className="pi-lines">
        {sentences.map((s) => (
          <li key={s.year}><button className="pi-link" onClick={() => props.open({ kind: "year", year: String(s.year) })}>{s.text}</button></li>
        ))}
      </ul>
    </ChartCard>
  );
});

// ------------------------------------------------------------------- taste

const Taste = memo(function Taste(props: TabProps) {
  const { ix, ids } = useScope(props);
  const o = useMemo(() => overlap(ix, ids), [ix, ids]);
  const [pair, setPair] = useState<[number, number] | null>(null);
  if (o.people.length < 2) return <p className="src">Overlap needs at least two people in this range.</p>;
  const names = o.people.map((p) => p.name);
  const s = o.split, tot = Math.max(s.total, 1);
  const shown = pair && pair[0] < names.length && pair[1] < names.length ? sharedArtists(o, pair[0], pair[1]) : [];
  const reading = `Each cell is the share of artists, out of those either person brought, that both brought; it reads the same from either side. `
    + `Of ${fmtCount(s.total)} artists, ${Math.round((s.one / tot) * 100)}% were brought by one person, ${Math.round((s.two / tot) * 100)}% by two and ${Math.round((s.three / tot) * 100)}% by three or more.`;
  return (
    <ChartCard title="Shared and distinct taste" reading={reading}
      coverage="artists with an identity; tracks nobody claimed are left out"
      csv={{ header: ["person", ...names], rows: names.map((n, i) => [n, ...o.jaccard[i].map((v) => (v === null ? "" : Math.round(v * 100) / 100))]) }}>
      <Heatmap rows={names} cols={names} values={o.jaccard} format={pct} valueLabel="artists in common"
        rowKeys={o.people.map((p) => p.id)} colKeys={o.people.map((p) => p.id)}
        ariaLabel="Overlap of artists between each pair of people"
        onSelect={(c) => {
          const i = o.people.findIndex((p) => p.id === c.row), j = o.people.findIndex((p) => p.id === c.col);
          setPair(i === j || i < 0 || j < 0 ? null : [i, j]);
        }} />
      {pair && (
        <div className="pi-pair" aria-live="polite">
          <b>{names[pair[0]]} and {names[pair[1]]}</b> both brought {plural(shown.length, "artist")}
          <ul className="pi-chips">
            {shown.map((a) => (
              <li key={a.id}><button className="pi-link" onClick={() => props.ctx.onOpenArtist(a.id)}>{a.name}</button></li>
            ))}
          </ul>
        </div>
      )}
      <h3 className="pi-h">How many people brought each artist</h3>
      <Stack100 ariaLabel="Artists by how many people brought them"
        parts={[{ key: "one", label: "1 person", value: s.one }, { key: "two", label: "2 people", value: s.two }, { key: "three", label: "3 or more", value: s.three }]} />
    </ChartCard>
  );
});

// ------------------------------------------------------------- set shapes

/** A small line on a domain fixed by the caller, so cards drawn side by side compare fairly. */
function Shape({ values, max, label }: { values: Array<number | null>; max: number; label: string }) {
  const W = 120, H = 34, pad = 3, n = values.length;
  const x = (i: number) => (n <= 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (n - 1));
  const y = (v: number) => H - pad - (max > 0 ? (v / max) * (H - 2 * pad) : 0);
  const runs: Array<Array<[number, number]>> = [[]];
  values.forEach((v, i) => { if (v === null) runs.push([]); else runs[runs.length - 1].push([x(i), y(v)]); });
  return (
    <svg className="pi-shape" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <line x1={pad} x2={W - pad} y1={H - pad} y2={H - pad} className="ich-grid" />
      {runs.filter((r) => r.length > 1).map((r, i) => (
        <path key={i} d={r.map(([px, py], k) => `${k ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join("")} className="ich-line" style={{ stroke: "var(--accent)" }} />
      ))}
      {runs.filter((r) => r.length === 1).map(([[px, py]], i) => <circle key={i} cx={px} cy={py} r={2.6} style={{ fill: "var(--accent)" }} />)}
    </svg>
  );
}

const SetShapes = memo(function SetShapes(props: TabProps) {
  const { ix, ids } = useScope(props);
  const sh = useMemo(() => shapes(ix, ids), [ix, ids]);
  if (!sh.shapes.length) return <p className="src">No nights with people in this range.</p>;
  const f1 = (v: number | null) => (v === null ? "" : Math.round(v * 10) / 10);
  const first = sh.years[0], last = sh.years[sh.years.length - 1];
  return (
    <ChartCard title="Set shapes"
      reading={`How each person's sets changed from ${first} to ${last}, in joining order. Every small chart uses the same scale (songs per night up to ${Math.ceil(sh.maxSongs)}, new share 0-100%), so shapes can be compared. Gaps are years without a set. Select a name to open the profile.`}
      csv={{
        header: ["person", ...sh.years.map((y) => `songs per night ${y}`), ...sh.years.map((y) => `new share ${y}`)],
        rows: sh.shapes.map((s) => [s.name, ...s.songsPerNight.map(f1), ...s.newShare.map((v) => (v === null ? "" : Math.round(v * 100) / 100))]),
      }}>
      <div className="pi-shapes">
        {sh.shapes.map((s) => (
          <div key={s.id} className="pi-shapecard">
            <button className="pi-link pi-name" onClick={() => props.ctx.onOpenPerson(s.id)}
              title={`Open ${s.name}'s profile`}>{s.name}</button>
            <span className="pi-cap">songs per night</span>
            <Shape values={s.songsPerNight} max={sh.maxSongs} label={`${s.name}: songs per night by year ${sh.years[0]} to ${last}`} />
            <span className="pi-cap">new music</span>
            <Shape values={s.newShare} max={1} label={`${s.name}: share of new music by year`} />
          </div>
        ))}
      </div>
    </ChartCard>
  );
});

// ------------------------------------------------------------ handing on

const HandingOn = memo(function HandingOn(props: TabProps) {
  const { ix, ids } = useScope(props);
  const h = useMemo(() => handing(ix, ids), [ix, ids]);
  const [pair, setPair] = useState<[number, number] | null>(null);
  if (h.people.length < 2) return <p className="src">Needs at least two people in this range.</p>;
  const names = h.people.map((p) => p.name);
  const values = h.counts.map((r, i) => r.map((v, j) => (i === j ? null : v)));
  const shown = pair && h.songs.get(`${pair[0]}|${pair[1]}`) || [];
  const reading = h.considered
    ? `${fmtCount(h.passed)} of ${fmtCount(h.considered)} songs were later brought by someone other than the person who first did, so they were passed along. `
      + `Rows are who first brought a song, columns who brought it on later. The opening night and songs from unclaimed tracks are left out.`
    : "No song has a known first bringer in this range.";
  return (
    <ChartCard title="Handing songs on" reading={reading}
      csv={{ header: ["first brought by", ...names.map((n) => `later brought by ${n}`)], rows: names.map((n, i) => [n, ...values[i].map((v) => (v === null ? "" : v))]) }}>
      <Heatmap rows={names} cols={names} values={values} valueLabel="songs passed along"
        format={(v) => String(Math.round(v))}
        rowKeys={h.people.map((p) => p.id)} colKeys={h.people.map((p) => p.id)}
        ariaLabel="Songs first brought by one person and later brought by another"
        onSelect={(c) => {
          const i = h.people.findIndex((p) => p.id === c.row), j = h.people.findIndex((p) => p.id === c.col);
          setPair(i === j || i < 0 || j < 0 ? null : [i, j]);
        }} />
      {pair && (
        <div className="pi-pair" aria-live="polite">
          <b>First {names[pair[0]]}, later {names[pair[1]]}</b>: {plural(shown.length, "song")}
          <ul className="pi-chips">
            {shown.slice(0, 60).map((s) => (
              <li key={s.id}><button className="pi-link" onClick={() => props.ctx.onOpenSong(s.id)}>{s.title}<i> {s.artist}</i></button></li>
            ))}
          </ul>
        </div>
      )}
    </ChartCard>
  );
});

export const PEOPLE_CHART_SECTIONS: SectionDef[] = [
  { id: "people-who", label: "Who was there", Body: WhoWasThere },
  { id: "people-size", label: "Group size", Body: GroupSize },
  { id: "people-changes", label: "How the group changes", Body: HowItChanges },
  { id: "people-taste", label: "Shared taste", Body: Taste },
  { id: "people-shapes", label: "Set shapes", Body: SetShapes },
  { id: "people-handing", label: "Handing songs on", Body: HandingOn },
];
