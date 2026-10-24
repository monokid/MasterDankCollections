/** Everyone as a profile. A gallery of the people who have been part of it, and
 *  for each a page about their history and taste.
 *
 *  Deliberately not a scoreboard: people are listed in the order they first
 *  appeared, nothing is sorted by a count, and every comparison is either within
 *  one person across their own years or an overlap between two people's artists.
 *  The numbers live in peoplestats.ts (pure, tested); this file only lays them out. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog } from "./catalog.ts";
import type { EnrichMap } from "./enrich.ts";
import type { Trace } from "./Timeline.tsx";
import { personColour } from "./colours.ts";
import { fmtCount, fmtDate, fmtDur, pct, plural } from "./format.ts";
import { copyText, scrollRootOf, sectionAt } from "./pagehelpers.ts";
import {
  collective, galleryCards, musicProfile, neighbours, profileOf, summaryText,
  type Card, type Profile, type YearRow,
} from "./peoplestats.ts";
import { useToast } from "./Toast.tsx";
import { CopyIcon } from "./icons.tsx";
import SongLinks, { CellText } from "./SongLinks.tsx";
import { songColumns, songFactsFor, type SongInfo } from "./songcols.ts";
import { linkable } from "./songrows.ts";
import "./people.css";

export interface PeoplePageProps {
  cat: Catalog;
  /** Public-database facts about songs; null when none shipped. Partial by nature. */
  enrich: EnrichMap | null;
  /** The person whose profile is open, or null for the gallery. */
  personId: string | null;
  onOpenPerson: (id: string | null) => void;
  onOpenNight: (eventId: string) => void;
  /** Opens a song's history (the track detail screen). */
  onOpenSong: (songId: string) => void;
  /** Opens an artist's discography on the Music page. */
  onOpenArtist: (artistId: string) => void;
  onTrace: (t: Trace) => void;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
const colourStyle = (i: number, extra: Record<string, string | number> = {}) =>
  ({ ["--pc" as string]: personColour(i), ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`--${k}`, v])) }) as React.CSSProperties;

/** A soft, breathing ball of the person's colour. Decorative. */
function Orb({ colourIndex, size, delay = 0 }: { colourIndex: number; size: "card" | "head"; delay?: number }) {
  return <span className={`pp-orb ${size}`} aria-hidden="true" style={colourStyle(colourIndex, { d: `${delay}ms` })}><i /></span>;
}

export default function PeoplePage(props: PeoplePageProps) {
  const { cat, personId } = props;
  const cards = useMemo(() => galleryCards(cat), [cat]);
  const known = personId !== null && cards.some((c) => c.id === personId);
  return known
    ? <ProfileView key={personId} {...props} personId={personId} cards={cards} />
    : <Gallery cat={cat} cards={cards} onOpenPerson={props.onOpenPerson} />;
}

// ------------------------------------------------------------------ gallery

function Gallery({ cat, cards, onOpenPerson }: { cat: Catalog; cards: Card[]; onOpenPerson: (id: string | null) => void }) {
  const co = useMemo(() => collective(cat), [cat]);
  const sizes = co.sizes.map((nights, size) => ({ size, nights })).filter((s) => s.size > 0 && s.nights > 0);
  return (
    <div className="page pp-page">
      <h1>People</h1>
      <p className="sub">Everyone who has been part of it, in the order they first appeared. Open a profile to see their history and taste.</p>

      <section className="pp-collective" aria-label="The group over the years">
        <div className="pp-coltext">
          <div><strong>{fmtCount(co.people)}</strong> {co.people === 1 ? "person has" : "people have"} been part of it, across <strong>{fmtCount(co.nights)}</strong> {co.nights === 1 ? "night" : "nights"}.</div>
          <div className="pp-sizes">
            {sizes.map((s) => <span key={s.size}>{plural(s.nights, "night")} with {plural(s.size, "person", "people")}</span>)}
          </div>
        </div>
        <div className="pp-hist" role="img"
          aria-label={"How many people were at each night, by year. " + co.byYear.map((y) => `${y.year}: ${y.sizes.join(", ")}`).join("; ")}>
          {co.byYear.map((y) => (
            <div key={y.year} className="pp-histyear">
              <div className="pp-histbars">
                {y.sizes.map((s, i) => (
                  <span key={i} className="pp-histbar" style={{ height: `${Math.max(8, (s / Math.max(1, co.maxSize)) * 100)}%` }} title={`${plural(s, "person", "people")}`} />
                ))}
              </div>
              <span className="pp-histlabel">{String(y.year).slice(2)}</span>
            </div>
          ))}
        </div>
      </section>

      <div className="pp-grid">
        {cards.map((c, i) => (
          <button key={c.id} className="pp-card" onClick={() => onOpenPerson(c.id)}
            style={colourStyle(c.colourIndex, { i })} aria-label={`Open ${c.name}'s profile`}>
            <Orb colourIndex={c.colourIndex} size="card" delay={i * 370} />
            <span className="pp-cname">{c.name}</span>
            <span className="pp-cspan">{c.span}</span>
            <span className="pp-cnums">
              <span><b>{fmtCount(c.nights)}</b> {c.nights === 1 ? "night" : "nights"}</span>
              <span><b>{fmtCount(c.songs)}</b> {c.songs === 1 ? "song" : "songs"} brought</span>
            </span>
            {c.line && <span className="pp-cline">{c.line}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ song row facts

/** Album, length, year and genre cells come from the shared song columns, so they
 *  say exactly what Search and Music say. */
const STD = Object.fromEntries(songColumns<SongInfo>((i) => i).map((c) => [c.id, c]));

/** The facts and links that end a song row. Album and genre carry .pp-fc: hidden below 1100px. */
function SongBits({ info }: { info: SongInfo }) {
  const cell = (id: string) => <CellText value={STD[id].text(info)} title={STD[id].title?.(info)} />;
  return (
    <>
      <span className="pp-fc" title="Album">{cell("album")}</span>
      <span title="Length">{cell("duration")}</span>
      <span title="Released">{cell("released")}</span>
      <span className="pp-fc" title="Genre">{cell("genre")}</span>
    </>
  );
}
const SongTail = ({ info }: { info: SongInfo }) => (
  <span className="pp-fk">{linkable(info) && <SongLinks song={info} />}</span>
);

// ------------------------------------------------------------------ profile

type SecId = "story" | "taste" | "first" | "sets" | "outliers" | "music";
const SEC_LABEL: Record<SecId, string> = {
  story: "Their story", taste: "Their taste", first: "First brought", sets: "How sets changed",
  outliers: "Outliers", music: "Decades and genres",
};

function ProfileView({ cat, enrich, personId, cards, onOpenPerson, onOpenNight, onOpenSong, onOpenArtist, onTrace }:
  PeoplePageProps & { personId: string; cards: Card[] }) {
  const pr = useMemo(() => profileOf(cat, personId)!, [cat, personId]);
  const music = useMemo(() => musicProfile(cat, personId, enrich), [cat, personId, enrich]);
  const { prev, next } = useMemo(() => neighbours(cat, personId), [cat, personId]);
  const { toast, node: toastNode } = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const [active, setActive] = useState<SecId | null>(null);
  const [anim] = useState(() => !reducedMotion() && typeof IntersectionObserver !== "undefined");

  const has: Record<SecId, boolean> = {
    story: pr.nights > 0,
    taste: pr.returning.length > 0 || pr.onlyTheirs.length > 0 || pr.overlaps.length > 0,
    first: pr.firstBrought.length > 0 || pr.seeds.length > 0,
    sets: pr.yearly.filter((y) => y.nights > 0).length >= 2,
    outliers: pr.outliers.length > 0,
    music: music !== null,
  };
  const secs = (Object.keys(has) as SecId[]).filter((k) => has[k]);
  const secKey = secs.join("|");

  const back = useCallback(() => onOpenPerson(null), [onOpenPerson]);

  // A new person starts at the top.
  useEffect(() => { scrollRootOf(rootRef.current)?.scrollTo({ top: 0, behavior: "instant" }); }, [personId]);

  // Esc returns to the gallery, unless a field has the keyboard.
  useEffect(() => {
    const onKey = (k: KeyboardEvent) => {
      if (k.altKey || k.ctrlKey || k.metaKey || k.shiftKey) return;
      const t = k.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName))) return;
      if (k.key === "Escape") { k.preventDefault(); back(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  // Scroll-spy for the section nav.
  useEffect(() => {
    const root = scrollRootOf(rootRef.current);
    if (!root) return;
    let raf = 0;
    const spy = () => {
      raf = 0;
      const line = root.getBoundingClientRect().top + (navRef.current?.offsetHeight ?? 0) + 24;
      const els = [...root.querySelectorAll<HTMLElement>("[data-sec]")];
      const atBottom = root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4;
      const i = sectionAt(els.map((e) => e.getBoundingClientRect().top), line, atBottom);
      setActive(i >= 0 ? (els[i].dataset.sec as SecId) : null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    root.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [personId, secKey]);

  // Sections fade up as they arrive. Without IntersectionObserver, or with reduced
  // motion, nothing is ever hidden. A timer reveals the rest if the observer stalls.
  useEffect(() => {
    if (!anim) return;
    const root = rootRef.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".pp-sec")];
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { threshold: 0.06, rootMargin: "0px 0px -4% 0px" });
    els.forEach((e) => io.observe(e));
    const t = window.setTimeout(() => els.forEach((e) => e.classList.add("in")), 2500);
    return () => { io.disconnect(); window.clearTimeout(t); };
  }, [anim, personId, secKey]);

  const jump = (id: SecId) => {
    const root = scrollRootOf(rootRef.current);
    const el = root?.querySelector<HTMLElement>(`[data-sec="${id}"]`);
    if (!root || !el) return;
    const top = el.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
    root.scrollTo({ top: top - (navRef.current?.offsetHeight ?? 0) - 12, behavior: reducedMotion() ? "auto" : "smooth" });
    setActive(id);
  };

  const trace = () => onTrace({
    kind: "person", id: pr.id, label: pr.name,
    nights: new Set(pr.strip.filter((s) => s.there).map((s) => s.night.id)),
  });
  const copy = async () => {
    const ok = await copyText(summaryText(cat, personId, enrich));
    toast(ok ? `Copied ${pr.name}'s summary` : "Could not copy");
  };

  const joined = pr.firstNight;
  return (
    <div className={`page pp-page${anim ? " pp-anim" : ""}`} ref={rootRef} style={colourStyle(pr.colourIndex)}>
      <button className="backlink" onClick={back}>{"←"} Everyone</button>

      <header className="pp-head">
        <Orb colourIndex={pr.colourIndex} size="head" />
        <div className="pp-headmain">
          <h1 className="pp-name">{pr.name}</h1>
          <div className="pp-headspan">{pr.span}</div>
          {pr.line && <div className="pp-headline">{pr.line}</div>}
          {joined && (
            <div className="pp-headfacts">
              <span>joined at <button className="pp-link" onClick={() => onOpenNight(joined.id)}>{fmtDate(joined.date)}</button></span>
              <span className="pp-att">
                <span>{pr.possible > 1
                  ? <>at <b>{pr.nights}</b> of the <b>{pr.possible}</b> nights during their span</>
                  : <>at <b>{pr.nights}</b> {pr.nights === 1 ? "night" : "nights"}</>}</span>
                {pr.possible > 1 && (
                  <span className="pp-attbar" role="img" aria-label={`${pr.nights} of ${pr.possible} nights`}>
                    <i style={{ width: `${Math.round(pr.attendedShare * 100)}%` }} />
                  </span>
                )}
              </span>
              <span><b>{fmtCount(pr.songs)}</b> {pr.songs === 1 ? "song" : "songs"} brought</span>
            </div>
          )}
          {pr.nights === 0 && <p className="pp-note">No nights on record yet.</p>}
          {pr.nights === 1 && <p className="pp-note">Only one night on record, so this profile is short.</p>}
        </div>
        <div className="pp-pn">
          <button className="pp-step" disabled={!prev} onClick={() => prev && onOpenPerson(prev.id)} aria-label={prev ? `Previous person: ${prev.name}` : "No previous person"}>{"‹"} {prev?.name}</button>
          <button className="pp-step" disabled={!next} onClick={() => next && onOpenPerson(next.id)} aria-label={next ? `Next person: ${next.name}` : "No next person"}>{next?.name} {"›"}</button>
        </div>
      </header>

      {secs.length > 0 && (
        <nav className="pp-nav" ref={navRef} aria-label="Sections of this profile">
          {secs.map((s) => (
            <button key={s} className={active === s ? "on" : ""} aria-current={active === s ? "true" : undefined} onClick={() => jump(s)}>{SEC_LABEL[s]}</button>
          ))}
          <button className="pp-copy" onClick={copy}><CopyIcon size={14} /> Copy profile summary</button>
        </nav>
      )}

      {has.story && <StorySection pr={pr} onOpenNight={onOpenNight} onTrace={trace} />}
      {has.taste && <TasteSection pr={pr} onOpenArtist={onOpenArtist} />}
      {has.first && <FirstSection cat={cat} enrich={enrich} pr={pr} onOpenSong={onOpenSong} onOpenNight={onOpenNight} />}
      {has.sets && <SetsSection pr={pr} />}
      {has.outliers && (
        <Sec id="outliers" title="Outliers">
          <ul className="pp-list pp-rich">
            {pr.outliers.map((o, i) => {
              const info = o.songId ? songFactsFor(cat, enrich, o.songId) : null;
              return (
                <li key={i} className={info ? undefined : "wide"}>
                  {o.eventId && <button className="pp-link wrap" onClick={() => onOpenNight(o.eventId!)}>{o.text}</button>}
                  {o.songId && info && (
                    <>
                      <span className="pp-sm"><button className="pp-link wrap" onClick={() => onOpenSong(o.songId!)}>{o.text}</button></span>
                      <SongBits info={info} />
                      <SongTail info={info} />
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </Sec>
      )}
      {music && <MusicSection mp={music} />}
      {toastNode}
    </div>
  );
}

function Sec({ id, title, children, hint }: { id: SecId; title: string; children: React.ReactNode; hint?: string }) {
  return (
    <section className="pp-sec glass-pp" data-sec={id} aria-labelledby={`pp-h-${id}`}>
      <h2 id={`pp-h-${id}`} className="pp-h">{title}</h2>
      {hint && <p className="pp-hint">{hint}</p>}
      {children}
    </section>
  );
}

// -------------------------------------------------------------------- story

function StorySection({ pr, onOpenNight, onTrace }: { pr: Profile; onOpenNight: (id: string) => void; onTrace: () => void }) {
  const years = useMemo(() => {
    const by = new Map<number, Profile["strip"]>();
    for (const s of pr.strip) {
      const l = by.get(s.night.year);
      if (l) l.push(s); else by.set(s.night.year, [s]);
    }
    return [...by.entries()];
  }, [pr]);
  return (
    <Sec id="story" title="Their story" hint="Every night there has been. Tall and lit means they were there; short and dim means they were not.">
      <div className="pp-strip">
        {years.map(([y, list]) => (
          <div key={y} className="pp-sy">
            <div className="pp-sticks">
              {list.map((s) => (
                <button key={s.night.id} className={`pp-tick${s.there ? " there" : ""}${s.inSpan ? "" : " out"}`}
                  onClick={() => onOpenNight(s.night.id)}
                  title={`${fmtDate(s.night.date)}${s.there ? "" : ", not there"}`}
                  aria-label={`${fmtDate(s.night.date)}, ${s.there ? "there" : "not there"}`} />
              ))}
            </div>
            <span className="pp-sylabel">{y}</span>
          </div>
        ))}
      </div>
      {pr.awayText.length > 0 && (
        <p className="pp-text">{pr.awayText.map((a) => a[0].toUpperCase() + a.slice(1)).join(". ")}.</p>
      )}
      <button className="pp-ghost" onClick={onTrace}>Show on the timeline</button>
    </Sec>
  );
}

// -------------------------------------------------------------------- taste

function TasteSection({ pr, onOpenArtist }: { pr: Profile; onOpenArtist: (id: string) => void }) {
  const [allOnly, setAllOnly] = useState(false);
  const lo = pr.returning.reduce((m, a) => Math.min(m, a.nights), Infinity);
  const hi = pr.returning.reduce((m, a) => Math.max(m, a.nights), 0);
  const size = (n: number) => (hi === lo ? 16 : 13 + ((n - lo) / (hi - lo)) * 12);
  const only = allOnly ? pr.onlyTheirs : pr.onlyTheirs.slice(0, 24);
  return (
    <Sec id="taste" title="Their taste">
      {pr.returning.length > 0 && (
        <>
          <h3 className="pp-h3">Artists they come back to</h3>
          <p className="pp-hint">Sized by how many different nights, not how many plays. In alphabetical order.</p>
          <div className="pp-cloud">
            {pr.returning.map((a) => (
              <button key={a.id} className="pp-tag" style={{ fontSize: `${size(a.nights)}px` }} onClick={() => onOpenArtist(a.id)}
                aria-label={`${a.name}, on ${a.nights} nights`}>
                {a.name}<span className="pp-tagn">{a.nights}</span>
              </button>
            ))}
          </div>
        </>
      )}
      {pr.onlyTheirs.length > 0 && (
        <>
          <h3 className="pp-h3">Artists only they have brought <span className="pp-dim">({fmtCount(pr.onlyTheirs.length)})</span></h3>
          <p className="pp-hint">As far as the catalogue knows, nobody else has brought these.</p>
          <div className="pp-quiet">
            {only.map((a) => (
              <button key={a.id} className="pp-qtag" onClick={() => onOpenArtist(a.id)}>{a.name}</button>
            ))}
            {pr.onlyTheirs.length > 24 && (
              <button className="pp-linkbtn" onClick={() => setAllOnly((v) => !v)} aria-expanded={allOnly}>
                {allOnly ? "show fewer" : `show all ${fmtCount(pr.onlyTheirs.length)}`}
              </button>
            )}
          </div>
        </>
      )}
      {pr.overlaps.length > 0 && (
        <>
          <h3 className="pp-h3">Where their artists overlap with others</h3>
          <p className="pp-hint">Artists in common. A shape, not a score: it only says how much two people's music touches.</p>
          <div className="pp-overlaps">
            {pr.overlaps.map((o) => <Venn key={o.id} pr={pr} o={o} />)}
          </div>
        </>
      )}
    </Sec>
  );
}

function Venn({ pr, o }: { pr: Profile; o: Profile["overlaps"][number] }) {
  // The picture is a gesture: the circles close in as the overlap grows.
  const t = Math.min(1, Math.sqrt(o.share) / 0.6);
  const gap = 30 - 18 * t;
  const text = `${o.name}: ${plural(o.shared, "artist")} in common, ${pct(o.ofMine)} of ${pr.name}'s artists and ${pct(o.ofTheirs)} of ${o.name}'s`;
  return (
    <div className="pp-venn" role="group" aria-label={text}>
      <svg width="74" height="38" viewBox="0 0 74 38" aria-hidden="true">
        <circle cx={19} cy={19} r={15} fill={personColour(pr.colourIndex)} fillOpacity={0.5} stroke={personColour(pr.colourIndex)} />
        <circle cx={19 + gap} cy={19} r={15} fill={personColour(o.colourIndex)} fillOpacity={0.5} stroke={personColour(o.colourIndex)} />
      </svg>
      <div>
        <div className="pp-vname">{o.name}</div>
        <div className="pp-vtext">{plural(o.shared, "artist")} in common</div>
        <div className="pp-vtext dim">{pct(o.ofMine)} of {pr.name}'s, {pct(o.ofTheirs)} of {o.name}'s</div>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- first

function FirstSection({ cat, enrich, pr, onOpenSong, onOpenNight }: { cat: Catalog; enrich: EnrichMap | null; pr: Profile; onOpenSong: (id: string) => void; onOpenNight: (id: string) => void }) {
  const [all, setAll] = useState(false);
  const shown = all ? pr.firstBrought : pr.firstBrought.slice(0, 20);
  return (
    <Sec id="first" title="First brought">
      {pr.firstBrought.length > 0 && (
        <>
          <p className="pp-text"><b>{fmtCount(pr.firstBrought.length)}</b> {pr.firstBrought.length === 1 ? "song" : "songs"} entered the library in one of their sets, newest first. When several people brought a song on the same night, it counts for each of them.</p>
          <ul className="pp-songs pp-rich dated">
            {shown.map((s) => {
              const info = songFactsFor(cat, enrich, s.songId);
              return (
                <li key={s.songId}>
                  <span className="pp-sm">
                    <button className="pp-link" onClick={() => onOpenSong(s.songId)}>{s.title}</button>
                    <span className="pp-dim"> {s.artist}</span>
                  </span>
                  <SongBits info={info} />
                  <button className="pp-date" onClick={() => onOpenNight(s.eventId)} aria-label={`Open the night of ${fmtDate(s.date)}`}>{fmtDate(s.date)}</button>
                  <SongTail info={info} />
                </li>
              );
            })}
          </ul>
          {pr.firstBrought.length > 20 && (
            <button className="pp-linkbtn" onClick={() => setAll((v) => !v)} aria-expanded={all}>
              {all ? "show fewer" : `show all ${fmtCount(pr.firstBrought.length)}`}
            </button>
          )}
        </>
      )}
      {pr.seeds.length > 0 && (
        <>
          <h3 className="pp-h3">Seeds that grew</h3>
          <p className="pp-hint">Songs they first brought that came back on three or more later nights.</p>
          <ul className="pp-seeds pp-rich">
            {pr.seeds.map((s) => {
              const info = songFactsFor(cat, enrich, s.songId);
              return (
                <li key={s.songId}>
                  <span className="pp-sm">
                    <button className="pp-link" onClick={() => onOpenSong(s.songId)}>{s.title}</button>
                    <span className="pp-dim"> ({s.artist})</span>, first brought {fmtDate(s.firstDate)}, came back on {plural(s.nightsAfter, "more night")}
                    {s.others > 0 ? `, carried on by ${plural(s.others, "other person", "other people")}.` : ", always in their own sets."}
                  </span>
                  <SongBits info={info} />
                  <SongTail info={info} />
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Sec>
  );
}

// --------------------------------------------------------------------- sets

function SetsSection({ pr }: { pr: Profile }) {
  const rows = pr.yearly;
  const metrics: Array<{ key: keyof YearRow["marks"]; title: string; get: (r: YearRow) => number | null; show: (v: number) => string }> = [
    { key: "list", title: "Songs per night", get: (r) => r.songsPerNight, show: (v) => v.toFixed(0) },
    { key: "fresh", title: "Share of new music", get: (r) => r.newShare, show: (v) => pct(v) },
    { key: "len", title: "Average track length", get: (r) => r.avgSec, show: (v) => fmtDur(v) },
  ];
  return (
    <Sec id="sets" title="How their sets have changed" hint="Each year compared only with their own other years. Marked years clearly stand apart from the rest.">
      <div className="pp-multiples">
        {metrics.map((m) => {
          const max = rows.reduce((a, r) => Math.max(a, m.get(r) ?? 0), 0);
          return (
            <figure key={m.key} className="pp-multi">
              <figcaption>{m.title}</figcaption>
              <div className="pp-mbars">
                {rows.map((r) => {
                  const v = m.get(r);
                  const mark = r.marks[m.key];
                  return (
                    <div key={r.year} className="pp-mcol" title={v === null ? `${r.year}: no nights` : `${r.year}: ${m.show(v)} (${plural(r.nights, "night")})`}>
                      <span className="pp-mmark" aria-label={mark ? (mark === "high" ? "stands out as higher" : "stands out as lower") : undefined}>
                        {mark === "high" ? "▲" : mark === "low" ? "▼" : ""}
                      </span>
                      <div className="pp-mtrack">
                        {v === null
                          ? <span className="pp-mnone" />
                          : <span className={`pp-mbar${mark ? " mark" : ""}`} style={{ height: `${max > 0 ? Math.max(4, (v / max) * 100) : 4}%` }} />}
                      </div>
                      <span className="pp-mlabel">{String(r.year).slice(2)}</span>
                    </div>
                  );
                })}
              </div>
            </figure>
          );
        })}
      </div>
      {pr.readings.length > 0
        ? <ul className="pp-list">{pr.readings.map((r) => <li key={r}>{r}.</li>)}</ul>
        : <p className="pp-text pp-dim">No year stands out from their others.</p>}
    </Sec>
  );
}

// -------------------------------------------------------------------- music

function MusicSection({ mp }: { mp: NonNullable<ReturnType<typeof musicProfile>> }) {
  const maxD = mp.decades.reduce((a, d) => Math.max(a, d.songs), 0);
  const maxF = mp.families.reduce((a, d) => Math.max(a, d.songs), 0);
  return (
    <Sec id="music" title="Music by decade and genre">
      <p className="pp-hint">Public music databases know the year for {fmtCount(mp.withYear)} of their {fmtCount(mp.total)} songs and the genre for {fmtCount(mp.withFamily)}. The rest are not in the picture.</p>
      {mp.decades.length > 0 && (
        <div className="pp-decades" role="img" aria-label={"Songs by release decade. " + mp.decades.map((d) => `${d.decade}: ${d.songs}`).join(", ")}>
          {mp.decades.map((d) => (
            <div key={d.decade} className="pp-dcol" title={`${d.decade}: ${plural(d.songs, "song")}`}>
              <span className="pp-dnum">{d.songs}</span>
              <span className="pp-dbar" style={{ height: `${maxD > 0 ? Math.max(6, (d.songs / maxD) * 100) : 6}%` }} />
              <span className="pp-dlabel">{d.decade}</span>
            </div>
          ))}
        </div>
      )}
      {mp.families.length > 0 && (
        <div className="pp-families">
          {mp.families.map((f) => (
            <span key={f.family} className="pp-fam" style={{ opacity: 0.55 + (maxF > 0 ? (f.songs / maxF) * 0.45 : 0) }}>
              {f.family}<span className="pp-tagn">{f.songs}</span>
            </span>
          ))}
        </div>
      )}
    </Sec>
  );
}
