/** The drilldown: click anything on Insights and read what is under it.
 *
 *  A year opens its nights; a night opens its people; a person opens their
 *  artists; an artist opens its songs; a song opens every night it was played.
 *  Each step is a click, with a back button, and every level can send you to
 *  the timeline with that thing lit up.
 */
import { useMemo, type ReactNode } from "react";
import type { Catalog } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import { discovery, inRange, playedOf, type Range } from "./analytics.ts";

export type Drill =
  | { kind: "song"; id: string }
  | { kind: "artist"; id: string }
  | { kind: "person"; id: string }
  | { kind: "year"; year: string }
  | { kind: "night"; id: string }
  | { kind: "genre"; name: string };

interface Props {
  cat: Catalog;
  drill: Drill;
  range: Range | null;
  canBack: boolean;
  onBack: () => void;
  onClose: () => void;
  onDrill: (d: Drill) => void;
  onTrace: (t: Trace) => void;
  onRange: (r: Range | null) => void;
  onOpenNight: (id: string) => void;
}

const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d + "T00:00:00").toLocaleDateString(undefined,
    { year: "numeric", month: "short", day: "numeric" }) : "undated";

function Spark({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values, 1);
  return (
    <div className="spark" role="img" aria-label="by year">
      {values.map((v, i) => (
        <div key={labels[i]} className="spark-col" title={`${labels[i]}: ${v}`}>
          <div className="spark-bar" style={{ height: `${Math.max((v / max) * 100, v ? 6 : 0)}%` }} />
          <span>{labels[i].slice(2)}</span>
        </div>
      ))}
    </div>
  );
}

function Item({ label, sub, value, onClick }: {
  label: string; sub?: string; value?: string | number; onClick?: () => void;
}) {
  return (
    <button className="dr-item" onClick={onClick} disabled={!onClick}>
      <span className="l">{label}{sub && <i>{sub}</i>}</span>
      {value !== undefined && <span className="v">{value}</span>}
    </button>
  );
}

export default function DrillPanel(props: Props) {
  const { cat, drill, canBack, onBack, onClose } = props;
  const ctx = useMemo(() => {
    const events = new Map(cat.events.map((e) => [e.id, e]));
    return {
      events,
      people: new Map(cat.people.map((p) => [p.id, p])),
      songs: new Map(cat.songs.map((s) => [s.id, s])),
      artists: new Map(cat.artists.map((a) => [a.id, a])),
      played: playedOf(cat, null),
    };
  }, [cat]);

  let head: { kicker: string; title: string; sub?: string };
  let body: ReactNode;

  switch (drill.kind) {
    case "song": {
      const s = ctx.songs.get(drill.id);
      if (!s) return null;
      head = { kicker: "song", title: s.title, sub: s.artist };
      body = <SongBody {...props} ctx={ctx} id={drill.id} />;
      break;
    }
    case "artist": {
      const a = ctx.artists.get(drill.id);
      if (!a) return null;
      head = { kicker: "artist", title: a.name };
      body = <ArtistBody {...props} ctx={ctx} id={drill.id} />;
      break;
    }
    case "person": {
      const p = ctx.people.get(drill.id);
      if (!p) return null;
      head = { kicker: "contributor", title: p.name, sub: p.aliases.length ? `also ${p.aliases.join(", ")}` : undefined };
      body = <PersonBody {...props} ctx={ctx} id={drill.id} />;
      break;
    }
    case "year":
      head = { kicker: "year", title: drill.year };
      body = <YearBody {...props} ctx={ctx} year={drill.year} />;
      break;
    case "night": {
      const e = ctx.events.get(drill.id);
      if (!e) return null;
      head = { kicker: "night", title: fmtDate(e.date), sub: e.title || e.types.join(" + ") };
      body = <NightBody {...props} ctx={ctx} id={drill.id} />;
      break;
    }
    case "genre":
      head = { kicker: "genre", title: drill.name };
      body = <GenreBody {...props} ctx={ctx} name={drill.name} />;
      break;
  }

  return (
    <aside className="drill" aria-label="Drilldown">
      <div className="dr-head">
        {canBack && <button className="dr-back" onClick={onBack} aria-label="Back">←</button>}
        <div className="dr-titles">
          <div className="dr-kicker">{head.kicker}</div>
          <div className="dr-title">{head.title}</div>
          {head.sub && <div className="dr-sub">{head.sub}</div>}
        </div>
        <button className="np-x" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <div className="dr-body">{body}</div>
    </aside>
  );
}

type Ctx = {
  events: Map<string, Catalog["events"][number]>;
  people: Map<string, Catalog["people"][number]>;
  songs: Map<string, Catalog["songs"][number]>;
  artists: Map<string, Catalog["artists"][number]>;
  played: Catalog["tracks"];
};
type BodyProps = Props & { ctx: Ctx };

const Stats = ({ items }: { items: Array<[string | number, string]> }) => (
  <div className="dr-stats">
    {items.map(([v, k]) => <div key={k}><b>{v}</b><span>{k}</span></div>)}
  </div>
);

// ---------------------------------------------------------------------- song

function SongBody({ ctx, id, onDrill, onTrace }: BodyProps & { id: string }) {
  const s = ctx.songs.get(id)!;
  const aid = id.split("|")[0];
  const by = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const t of ctx.played) {
      if (t.songId !== id || !t.personId) continue;
      if (!m.has(t.eventId)) m.set(t.eventId, []);
      m.get(t.eventId)!.push(ctx.people.get(t.personId)?.name ?? "");
    }
    return m;
  }, [ctx, id]);
  const nights = [...s.nights].reverse();
  return (
    <>
      <Stats items={[
        [s.nights.length, "nights"], [s.plays, "plays"],
        [s.people.length, "people"], [`${s.firstPlayed?.slice(0, 4)}–${s.lastPlayed?.slice(2, 4)}`, "span"],
      ]} />
      {s.variants.length > 0 && <div className="dr-note">also played as {s.variants.join(", ")}</div>}
      <div className="dr-actions">
        <button className="dr-btn"
          onClick={() => onTrace({ kind: "song", id: s.id, label: `${s.artist} — ${s.title}`, nights: new Set(s.nights) })}>
          show on the timeline →
        </button>
        {ctx.artists.has(aid) && (
          <button className="dr-btn ghost" onClick={() => onDrill({ kind: "artist", id: aid })}>
            more by {s.artist}
          </button>
        )}
      </div>
      <h3>Played on</h3>
      {nights.map((n) => (
        <Item key={n} label={fmtDate(ctx.events.get(n)?.date)}
          sub={ctx.events.get(n)?.title || ctx.events.get(n)?.types.join(" + ")}
          value={[...new Set(by.get(n) ?? [])].join(", ")}
          onClick={() => onDrill({ kind: "night", id: n })} />
      ))}
    </>
  );
}

// -------------------------------------------------------------------- artist

function ArtistBody({ ctx, id, onDrill, onTrace }: BodyProps & { id: string }) {
  const a = ctx.artists.get(id)!;
  const { songs, years, labels, who } = useMemo(() => {
    const ts = ctx.played.filter((t) => t.songId?.startsWith(id + "|"));
    const sm = new Map<string, Set<string>>();
    const ym = new Map<string, number>();
    const pm = new Map<string, number>();
    for (const t of ts) {
      if (!sm.has(t.songId!)) sm.set(t.songId!, new Set());
      sm.get(t.songId!)!.add(t.eventId);
      const y = ctx.events.get(t.eventId)?.date?.slice(0, 4);
      if (y) ym.set(y, (ym.get(y) ?? 0) + 1);
      if (t.personId) pm.set(t.personId, (pm.get(t.personId) ?? 0) + 1);
    }
    const ys = [...ym.keys()].sort();
    const all: string[] = [];
    if (ys.length) for (let y = +ys[0]; y <= +ys[ys.length - 1]; y++) all.push(String(y));
    return {
      songs: [...sm.entries()].map(([sid, n]) => ({ sid, n: n.size }))
        .sort((x, y) => y.n - x.n).slice(0, 20),
      years: all.map((y) => ym.get(y) ?? 0), labels: all,
      who: [...pm.entries()].sort((x, y) => y[1] - x[1]),
    };
  }, [ctx, id]);
  return (
    <>
      <Stats items={[
        [a.nights.length, "nights"], [a.songs, "songs"], [a.plays, "plays"],
        [labels.filter((_, i) => years[i] > 0).length, "years"],
      ]} />
      <div className="dr-actions">
        <button className="dr-btn"
          onClick={() => onTrace({ kind: "artist", id: a.id, label: a.name, nights: new Set(a.nights) })}>
          show on the timeline →
        </button>
      </div>
      {labels.length > 1 && <><h3>Plays by year</h3><Spark values={years} labels={labels} /></>}
      <h3>Brought by</h3>
      {who.map(([pid, n]) => (
        <Item key={pid} label={ctx.people.get(pid)?.name ?? pid} value={`${n} plays`}
          onClick={() => onDrill({ kind: "person", id: pid })} />
      ))}
      <h3>Songs</h3>
      {songs.map(({ sid, n }) => (
        <Item key={sid} label={ctx.songs.get(sid)?.title ?? sid} value={`${n} night${n === 1 ? "" : "s"}`}
          onClick={() => onDrill({ kind: "song", id: sid })} />
      ))}
    </>
  );
}

// -------------------------------------------------------------------- person

function PersonBody({ cat, ctx, id, onDrill, onTrace }: BodyProps & { id: string }) {
  const p = ctx.people.get(id)!;
  const { nights, labels, years, top, signature } = useMemo(() => {
    const ns = cat.events.filter((e) => e.kind !== "collection" && e.date && e.people.includes(id))
      .sort((a, b) => a.date!.localeCompare(b.date!));
    const ym = new Map<string, number>();
    ns.forEach((e) => ym.set(e.date!.slice(0, 4), (ym.get(e.date!.slice(0, 4)) ?? 0) + 1));
    const all: string[] = [];
    if (ns.length) for (let y = +ns[0].date!.slice(0, 4); y <= +ns[ns.length - 1].date!.slice(0, 4); y++) all.push(String(y));
    const mine = cat.artists.filter((a) => a.people.includes(id));
    return {
      nights: ns, labels: all, years: all.map((y) => ym.get(y) ?? 0),
      top: [...mine].sort((a, b) => b.nights.length - a.nights.length).slice(0, 15),
      signature: mine.filter((a) => a.people.length === 1 && a.plays >= 3).length,
    };
  }, [cat, id]);
  return (
    <>
      <Stats items={[
        [p.trackCount, "tracks"], [nights.length, "nights"],
        [nights[0]?.date?.slice(0, 4) ?? "", "first"], [signature, "signature artists"],
      ]} />
      <div className="dr-actions">
        <button className="dr-btn" onClick={() => onTrace({
          kind: "person", id: p.id, label: p.name,
          nights: new Set(nights.map((n) => n.id)),
        })}>show their nights →</button>
      </div>
      {labels.length > 1 && <><h3>Nights attended by year</h3><Spark values={years} labels={labels} /></>}
      <h3>Most-played artists</h3>
      {top.map((a) => (
        <Item key={a.id} label={a.name} value={`${a.nights.length} nights`}
          onClick={() => onDrill({ kind: "artist", id: a.id })} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------- year

function YearBody({ cat, ctx, year, onDrill, onRange }: BodyProps & { year: string }) {
  const r: Range = { from: `${year}-01-01`, to: `${year}-12-31` };
  const { nights, hours, rate, songs, artists } = useMemo(() => {
    const ns = cat.events.filter((e) => e.kind !== "collection" && e.date && inRange(e.date, r))
      .sort((a, b) => a.date!.localeCompare(b.date!));
    const ts = playedOf(cat, r);
    const sm = new Map<string, number>(), am = new Map<string, number>();
    for (const t of ts) {
      if (t.songId) sm.set(t.songId, (sm.get(t.songId) ?? 0) + 1);
      if (t.songId) { const a = t.songId.split("|")[0]; am.set(a, (am.get(a) ?? 0) + 1); }
    }
    return {
      nights: ns, hours: ns.reduce((s, n) => s + n.durationSec, 0) / 3600,
      rate: discovery(cat, r)[0]?.rate ?? 0,
      songs: [...sm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      artists: [...am.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cat, year]);
  return (
    <>
      <Stats items={[
        [nights.length, "nights"], [hours.toFixed(0), "hours"],
        [`${Math.round(rate * 100)}%`, "new music"],
        [(nights.reduce((s, n) => s + n.people.length, 0) / Math.max(nights.length, 1)).toFixed(1), "people / night"],
      ]} />
      <div className="dr-actions">
        <button className="dr-btn" onClick={() => onRange(r)}>focus Insights on {year} →</button>
      </div>
      <h3>Nights</h3>
      {nights.map((n) => (
        <Item key={n.id} label={fmtDate(n.date)} sub={n.title || n.types.join(" + ")}
          value={`${n.playedCount} tracks`} onClick={() => onDrill({ kind: "night", id: n.id })} />
      ))}
      <h3>Most-played songs that year</h3>
      {songs.map(([sid, n]) => (
        <Item key={sid} label={ctx.songs.get(sid)?.title ?? sid} sub={ctx.songs.get(sid)?.artist}
          value={n} onClick={() => onDrill({ kind: "song", id: sid })} />
      ))}
      <h3>Most-played artists that year</h3>
      {artists.map(([aid, n]) => (
        <Item key={aid} label={ctx.artists.get(aid)?.name ?? aid} value={n}
          onClick={() => onDrill({ kind: "artist", id: aid })} />
      ))}
    </>
  );
}

// --------------------------------------------------------------------- night

function NightBody({ ctx, id, onDrill, onOpenNight }: BodyProps & { id: string }) {
  const e = ctx.events.get(id)!;
  const per = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of ctx.played) if (t.eventId === id && t.personId) m.set(t.personId, (m.get(t.personId) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [ctx, id]);
  return (
    <>
      <Stats items={[
        [e.playedCount, "tracks"], [(e.durationSec / 3600).toFixed(1), "hours"],
        [e.people.length, "people"], [e.debuts, "debuts"],
      ]} />
      <div className="dr-actions">
        <button className="dr-btn" onClick={() => onOpenNight(id)}>open the full night →</button>
      </div>
      <h3>Who brought what</h3>
      {per.map(([pid, n]) => (
        <Item key={pid} label={ctx.people.get(pid)?.name ?? pid} value={`${n} tracks`}
          onClick={() => onDrill({ kind: "person", id: pid })} />
      ))}
    </>
  );
}

// --------------------------------------------------------------------- genre

function GenreBody({ ctx, name, onDrill }: BodyProps & { name: string }) {
  const { tracks, artists } = useMemo(() => {
    const ts = ctx.played.filter((t) => t.genre === name);
    const am = new Map<string, number>();
    for (const t of ts) if (t.songId) { const a = t.songId.split("|")[0]; am.set(a, (am.get(a) ?? 0) + 1); }
    return { tracks: ts, artists: [...am.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20) };
  }, [ctx, name]);
  return (
    <>
      <Stats items={[[tracks.length, "tracks"], [artists.length, "artists"]]} />
      <div className="dr-note">
        Only a small share of this library carries a genuine genre tag, so read this as
        "tagged {name}", not "all the {name}".
      </div>
      <h3>Artists</h3>
      {artists.map(([aid, n]) => (
        <Item key={aid} label={ctx.artists.get(aid)?.name ?? aid} value={n}
          onClick={() => onDrill({ kind: "artist", id: aid })} />
      ))}
    </>
  );
}
