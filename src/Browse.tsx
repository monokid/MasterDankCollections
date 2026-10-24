/** The events page: every night as a card, grouped under sticky year headings,
 *  with a year rail, filter chips by kind of night and a sort toggle. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Event } from "./catalog.ts";
import { TYPE_COLOUR, personColour } from "./colours.ts";
import { SHOW_COLLECTIONS } from "./config.ts";
import Sky from "./Sky.tsx";
import type { WeatherMap } from "./weather.ts";
import { fmtCount, fmtHours, plural } from "./format.ts";
import { useSessionState } from "./hooks.ts";
import type { EnrichMap } from "./enrich.ts";
import { familyLabel } from "./families.ts";
import EnrichChips from "./EnrichChips.tsx";
import {
  factOf, filterNights, NIGHT_MIN_SHARE, NIGHT_MIN_SONGS, nightFacets, nightSound, NO_SEL,
  selActive, unknownWhat, universe, type Fact, type Sel,
} from "./enrichfilter.ts";
import "./pages.css";
import "./enrichfilter.css";

const dateParts = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(iso + "T00:00:00");
  return {
    day: String(d.getDate()),
    month: d.toLocaleDateString(undefined, { month: "long" }),
    weekday: d.toLocaleDateString(undefined, { weekday: "long" }),
  };
};

/** "Roll" over "roll" is the same word twice; the joke name shows only when it adds something. */
const jokeTitle = (e: Event) =>
  e.title && !e.types.includes(e.title.toLowerCase()) ? e.title : "";

const scrollRoot = (el: Element | null) => el?.closest(".scroll") as HTMLElement | null;

function NightCard({ ev, cat, weather, flash, sound, onOpen }: {
  ev: Event; cat: Catalog; weather?: WeatherMap; flash: boolean;
  /** "mostly rock, 1990s–2000s", when enough of the night is known. */
  sound?: { text: string; known: number; total: number } | null;
  onOpen: () => void;
}) {
  const d = dateParts(ev.date);
  const title = jokeTitle(ev);
  const kinds = ev.types.length ? ev.types : [ev.type ?? "night"];
  return (
    <article id={`night-${ev.id}`} className={`ncard${flash ? " flash" : ""}`}
      tabIndex={0} role="link"
      aria-label={`${d ? `${d.weekday} ${d.day} ${d.month} ${ev.date!.slice(0, 4)}` : ev.folder}, ${plural(ev.playedCount, "track")}. Open the night`}
      onClick={onOpen}
      onKeyDown={(k) => {
        if (k.key === "Enter" || k.key === " ") { k.preventDefault(); onOpen(); }
      }}>
      <div className="nc-top">
        <div className="nc-date">
          <span className="day">{d?.day ?? "?"}</span>
          <span className="rest">
            <span className="month">{d?.month ?? "undated"}</span>
            <span className="weekday">{d?.weekday ?? ""}</span>
          </span>
        </div>
        <div className="nc-kinds">
          {kinds.map((t) => (
            <span key={t} className="ktype" style={{ color: TYPE_COLOUR[t] ?? "var(--accent)" }}>{t}</span>
          ))}
        </div>
      </div>
      {title && <div className="nc-title">{title}</div>}
      {sound && (
        <div className="nc-sound"
          title={`From the ${sound.known} of this night's ${sound.total} songs with a genre or year on file`}>
          {sound.text}
        </div>
      )}

      <div className="nc-stats">
        <span><b>{fmtCount(ev.playedCount)}</b> tracks</span>
        <span><b>{fmtHours(ev.durationSec)}</b> hours</span>
        <span><b>{ev.people.length}</b> people</span>
        <span title="Songs heard here for the first time in the library's history">
          <b>{ev.debuts}</b> new
        </span>
      </div>

      <div className="nc-people">
        {ev.people.map((pid) => {
          const i = cat.people.findIndex((p) => p.id === pid);
          return (
            <span key={pid} className="pchip" style={{ ["--pc" as string]: personColour(i) }}>
              {cat.people[i]?.name ?? pid}
            </span>
          );
        })}
      </div>

      {ev.date && <Sky date={ev.date} weather={weather?.[ev.date]} />}
    </article>
  );
}

export default function EventsList({ cat, weather, enrich = null, focusId, onOpenNight }: {
  cat: Catalog; weather: WeatherMap; enrich?: EnrichMap | null;
  focusId: string | null; onOpenNight: (id: string) => void;
}) {
  // The sort and the kind filter outlive a visit to a night (and the tab).
  const [newestFirst, setNewestFirst] = useSessionState("browse.newest", true);
  const [kind, setKind] = useSessionState<string | null>("browse.kind", null);
  // A card to scroll to once it is on screen -- it may need the filter cleared first.
  const [pending, setPending] = useState<{ id: string; smooth: boolean } | null>(null);
  const [activeYear, setActiveYear] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const nights = useMemo(
    () => cat.events.filter((e) => e.kind !== "collection")
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "")), [cat]);
  const shelves = cat.events.filter((e) => e.kind === "collection");

  const kinds = useMemo(() => {
    const n = new Map<string, number>();
    for (const e of nights) for (const t of e.types) n.set(t, (n.get(t) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [nights]);

  // Genre / decade chips, remembered for the tab. Without enrichment: no chips, no filter.
  const [fams, setFams] = useSessionState<string[]>("browse.fam", []);
  const [decs, setDecs] = useSessionState<string[]>("browse.dec", []);
  const sel = useMemo<Sel>(() => (enrich ? { families: fams, decades: decs } : NO_SEL), [enrich, fams, decs]);
  const enrichOn = selActive(sel);
  const setSel = useCallback((s: Sel) => { setFams(s.families); setDecs(s.decades); }, [setFams, setDecs]);

  // Each night's songs, once each (a song is one id however many copies, twins or
  // Spotify duplicates it has), as what enrichment knows about them.
  const nightFacts = useMemo(() => {
    const by = new Map<string, Fact[]>();
    if (!enrich) return by;
    for (const s of cat.songs) {
      const f = factOf(enrich, s.id);
      for (const id of s.nights) {
        let list = by.get(id);
        if (!list) by.set(id, list = []);
        list.push(f);
      }
    }
    return by;
  }, [cat, enrich]);
  const sounds = useMemo(() => {
    const m = new Map<string, ReturnType<typeof nightSound>>();
    for (const [id, facts] of nightFacts) m.set(id, nightSound(facts, familyLabel));
    return m;
  }, [nightFacts]);
  const uni = useMemo(
    () => universe(enrich ? cat.songs.map((s) => factOf(enrich, s.id)) : []), [cat, enrich]);

  const kindNights = useMemo(() => nights.filter((e) => !kind || e.types.includes(kind)), [nights, kind]);
  const judged = useMemo(
    () => filterNights(kindNights.map((e) => ({ key: e.id, facts: nightFacts.get(e.id) ?? [] })), sel),
    [kindNights, nightFacts, sel]);
  const facets = useMemo(
    () => nightFacets(kindNights.map((e) => nightFacts.get(e.id) ?? []), sel,
      { families: uni.families.map(([f]) => f), decades: uni.decades.map(([d]) => d) }),
    [kindNights, nightFacts, sel, uni]);

  const years = useMemo(() => {
    const shown = kindNights.filter((e) => !enrichOn || judged.keep.has(e.id));
    const by = new Map<string, Event[]>();
    for (const e of shown) {
      const y = e.date?.slice(0, 4) ?? "????";
      if (!by.has(y)) by.set(y, []);
      by.get(y)!.push(e);
    }
    const list = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // The toggle orders the years only; inside a year the cards always read
    // January to December, left to right (`nights` is already date-sorted).
    if (newestFirst) list.reverse();
    return list.map(([year, evs]) => ({ year, evs }));
  }, [kindNights, enrichOn, judged, newestFirst]);
  const allYears = useMemo(
    () => [...new Set(nights.map((e) => e.date?.slice(0, 4) ?? "????"))].sort(), [nights]);
  const shownYears = new Set(years.map((y) => y.year));
  const railYears = newestFirst ? [...allYears].reverse() : allYears;

  // Rail buttons have a fixed pitch in CSS, so the orb and the filled line
  // only need the active index -- no measuring.
  const activeIdx = activeYear ? railYears.indexOf(activeYear) : -1;

  const latest = nights.filter((e) => e.date).slice(-1)[0];

  // Scroll-spy: the year whose heading was passed last is the one in view.
  useEffect(() => {
    const root = scrollRoot(rootRef.current);
    if (!root) return;
    let raf = 0;
    const spy = () => {
      raf = 0;
      const top = root.getBoundingClientRect().top + 60;
      let cur: string | null = null;
      for (const s of root.querySelectorAll<HTMLElement>("[data-year]")) {
        if (s.getBoundingClientRect().top <= top) cur = s.dataset.year!;
        else break;
      }
      setActiveYear(cur ?? years[0]?.year ?? null);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy); };
    root.addEventListener("scroll", onScroll, { passive: true });
    spy();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [years]);

  const jumpToYear = (y: string) => {
    const root = scrollRoot(rootRef.current);
    const sec = root?.querySelector<HTMLElement>(`[data-year="${y}"]`);
    if (root && sec) {
      const top = sec.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop;
      root.scrollTo({ top: top - 1, behavior: "smooth" });
    }
  };

  const flash = useCallback((id: string, smooth: boolean) => {
    const el = document.getElementById(`night-${id}`);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: smooth ? "smooth" : "instant" });
    setFlashId(id);
    window.setTimeout(() => setFlashId((cur) => (cur === id ? null : cur)), 1800);
    el.focus({ preventScroll: true });
    return true;
  }, []);

  // Coming back from a night, land on the card that was open.
  useEffect(() => { if (focusId) setPending({ id: focusId, smooth: false }); }, [focusId]);

  // Runs after every render until the card exists: if the kind filter hides it,
  // clear the filter and let the next render show it.
  useEffect(() => {
    if (!pending) return;
    if (flash(pending.id, pending.smooth)) { setPending(null); return; }
    if (kind) setKind(null);
    else if (enrichOn) setSel(NO_SEL);
    else setPending(null);
  }, [pending, years, kind, enrichOn, flash, setKind, setSel]);

  const jumpLatest = () => { if (latest) setPending({ id: latest.id, smooth: true }); };

  return (
    <div className="page wide browse" ref={rootRef}>
      <h1>Events</h1>
      <p className="sub">
        {plural(nights.length, "night")}, {newestFirst ? "newest" : "oldest"} first.
      </p>

      <div className="bbar">
        <div className="bchips" role="group" aria-label="Kind of night">
          <button className="fchip" aria-pressed={kind === null} onClick={() => setKind(null)}>
            All <i>{nights.length}</i>
          </button>
          {kinds.map(([t, n]) => (
            <button key={t} className="fchip" aria-pressed={kind === t}
              style={{ ["--fc" as string]: TYPE_COLOUR[t] ?? "var(--accent)" }}
              onClick={() => setKind(kind === t ? null : t)}>
              {t} <i>{n}</i>
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="fchip" onClick={jumpLatest} disabled={!latest}
          title="Scroll to the most recent night">Jump to latest night</button>
        <div className="segtoggle" role="group" aria-label="Sort">
          <button aria-pressed={newestFirst} onClick={() => setNewestFirst(true)}>Newest first</button>
          <button aria-pressed={!newestFirst} onClick={() => setNewestFirst(false)}>Oldest first</button>
        </div>
      </div>

      {enrich && (uni.families.length > 0 || uni.decades.length > 0) && (
        <EnrichChips universe={uni} counts={facets} sel={sel} onChange={setSel}
          hint={(enrichOn
            ? `${judged.keep.size} of ${kindNights.length} nights${judged.unjudged
              ? ` (${judged.unjudged} ${judged.unjudged === 1 ? "has" : "have"} no songs with a ${unknownWhat(sel)} on file and ${judged.unjudged === 1 ? "is" : "are"} hidden)`
              : ""}. `
            : "") +
            `A night matches when at least ${NIGHT_MIN_SONGS} of its songs, or ${Math.round(NIGHT_MIN_SHARE * 100)}% of those with data, fit.`} />
      )}

      <div className="bgrid">
        <div className="bmain">
          {years.length === 0 && (
            <div className="empty">
              <div className="big" aria-hidden="true">◌</div>
              <div>No nights to show{kind ? <> for “{kind}”</> : ""}{enrichOn ? " with those genre and decade chips" : ""}.</div>
              {(kind || enrichOn) && (
                <div className="emptyacts">
                  {kind && <button className="dr-btn ghost" onClick={() => setKind(null)}>Show all nights</button>}
                  {enrichOn && <button className="dr-btn ghost" onClick={() => setSel(NO_SEL)}>Clear genre and decade</button>}
                </div>
              )}
            </div>
          )}
          {years.map(({ year, evs }) => (
            <section key={year} className="yeargroup" data-year={year}>
              <h2 className="yearhead">
                <span className="yh-year">{year}</span>
                <span className="yh-count">{plural(evs.length, "night")}</span>
              </h2>
              <div className="ngrid">
                {evs.map((e) => (
                  <NightCard key={e.id} ev={e} cat={cat} weather={weather}
                    flash={flashId === e.id} sound={sounds.get(e.id)} onOpen={() => onOpenNight(e.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
        <nav className="yrail" aria-label="Jump to year"
          style={{ ["--n" as string]: railYears.length, ["--i" as string]: Math.max(activeIdx, 0) }}>
          <span className="yr-track" aria-hidden="true" />
          <span className="yr-fill" aria-hidden="true" />
          <span className="yr-orb" aria-hidden="true" data-on={activeIdx >= 0} />
          {railYears.map((y) => (
            <button key={y} aria-current={activeYear === y} disabled={!shownYears.has(y)}
              onClick={() => jumpToYear(y)}>{y}</button>
          ))}
        </nav>
      </div>

      {SHOW_COLLECTIONS && shelves.length > 0 && (
        <>
          <h2 style={{ marginTop: 34 }}>Collections</h2>
          <p className="sub">Standing piles rather than nights, so they sit outside the timeline.</p>
          <div className="grid events">
            {shelves.map((e) => (
              <button key={e.id} className="card" onClick={() => onOpenNight(e.id)}>
                <div className="k">{e.folder}</div>
                <div className="n">{plural(e.playedCount, "track")}</div>
              </button>
            ))}
          </div>
        </>
      )}

      <h2 style={{ marginTop: 34 }}>People</h2>
      <div className="grid people">
        {cat.people.map((p, i) => (
          <div key={p.id} className={`card ${p.isYou ? "you" : ""}`}>
            <div className="k">
              <span className="dot" style={{ background: personColour(i) }} />
              {p.name}
            </div>
            <div className="n">
              {plural(p.trackCount, "track")} · {plural(p.eventCount, "night")}
              {p.aliases.length ? ` · aka ${p.aliases.join(", ")}` : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
