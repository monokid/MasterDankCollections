/** Search, one row per song.
 *
 *  The same song on eight nights used to be eight identical rows. Here it is one
 *  row that says "8 nights"; click it and each play unfolds beneath, one line
 *  per night. The filters ask the questions this library is actually asked:
 *  whose, when, and what kind of night.
 *
 *  Keyboard: "/" (from anywhere) focuses the box, Down moves into the results,
 *  Up/Down walk them, Enter opens, Esc clears. Filters, the query, the open
 *  song and the scroll position are remembered while you look at a track and
 *  come back. The list grows as you scroll and rows off-screen are skipped by
 *  the browser (content-visibility), so ~3,000 songs cost about 100.
 */
import {
  memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent,
} from "react";
import type { Catalog, Track } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import { buildIndex, search } from "./search.ts";
import { isShown } from "./config.ts";
import { Marked } from "./rows.tsx";
import { fmtCount, fmtDate, fmtDur, plural } from "./format.ts";
import {
  copyText, groupHits, lookups, scrollRootOf, SORT_LABEL, sortGroups, stepIndex,
  type Group, type Lookups, type SortKey,
} from "./pagehelpers.ts";
import { useOnChange, useSessionState } from "./hooks.ts";
import {
  consumeFocusRequest, FOCUS_SEARCH_EVENT, getSearchQuery, setSearchQuery, subscribeSearchQuery,
} from "./events.ts";
import { useToast } from "./Toast.tsx";
import { EnrichPopovers } from "./EnrichChips.tsx";
import { familyLabel } from "./families.ts";
import { coverUrlOf, type EnrichMap } from "./enrich.ts";
import Cover from "./Cover.tsx";
import SongLinks, { CellText } from "./SongLinks.tsx";
import ColumnsMenu, { useColumnChoice, useViewportWidth } from "./ColumnsMenu.tsx";
import {
  gridTemplate, songColumns, songFactsFor, sortRows, visibleColumns,
  type Column, type SongInfo,
} from "./songcols.ts";
import {
  coverage, factOf, NO_SEL, passes, selActive, songFacets, summarise, universe,
  type Sel,
} from "./enrichfilter.ts";
import { activeChips, clearAll, hiddenNote, orderText, removeChip, suggestions, type FilterState } from "./searchbar.ts";
import { CloseIcon, CopyIcon, SearchIcon } from "./icons.tsx";
import "./pages.css";
import "./enrichfilter.css";
import "./songcols.css";
import "./searchbar.css";

const BATCH = 120;   // rows added each time the list grows

/** What survives leaving the page for a track and coming back (not a reload). */
const memo_ = { scroll: 0, open: null as string | null, limit: BATCH };

/** Search's own columns, appended to the standard song ones. */
const PEOPLE_COL: Column<Group> = {
  id: "people", label: "Brought by", width: "110px", align: "left", hideBelow: 720,
  sortKey: (g) => (g.people[0] ? g.people[0].toLocaleLowerCase() : null),
  text: (g) => g.people.length
    ? g.people.slice(0, 2).join(", ") + (g.people.length > 2 ? ` +${g.people.length - 2}` : "") : null,
};
const WHEN_COL: Column<Group> = {
  id: "when", label: "When", width: "92px", align: "right",
  sortKey: (g) => g.latest || null, text: (g) => g.span || null,
};

const GroupRow = memo(function GroupRow({ g, info, cols, isOpen, q, lk, enrich, onToggle, onOpen, onTrace }: {
  g: Group; info: SongInfo; cols: Column<Group>[]; isOpen: boolean; q: string; lk: Lookups; enrich: EnrichMap | null;
  onToggle: (g: Group) => void; onOpen: (t: Track) => void; onTrace: (t: Trace) => void;
}) {
  const solo = g.tracks.length === 1;
  const rec = enrich && g.songId ? enrich[g.songId] : undefined;
  const hasNights = cols.some((c) => c.id === "nights");
  const cell = (c: Column<Group>) => {
    const text = c.text(g);
    switch (c.id) {
      case "cover":
        return <Cover songId={g.songId ?? g.key} title={g.title} artist={g.artist ?? undefined} url={coverUrlOf(rec)} size={36} />;
      case "links":
        return null;   // the real links sit beside the row (they cannot live inside its button)
      case "title":
        return (
          <>
            <Marked value={g.title} query={q} />
            {g.variants.slice(0, 2).map((v) => (
              <span key={v} className="chip variant">{v}</span>
            ))}
            {!hasNights && g.nights > 1 && (
              <span className="chip recurs" title={`Played on ${g.nights} nights`}>
                {g.nights} nights
              </span>
            )}
            {g.anon && <span className="chip anon">anon</span>}
          </>
        );
      case "artist":
        return text ? <Marked value={text} query={q} /> : <CellText value={null} />;
      default:
        return <CellText value={text} title={c.title?.(g)} />;
    }
  };
  return (
    <div className={`songgroup${isOpen ? " open" : ""}`}>
      <div className="sc-rowwrap">
        <button className="row" aria-expanded={solo ? undefined : isOpen}
          title={solo ? "Open this track" : isOpen ? "Hide the nights" : "Show every night it was played"}
          onClick={() => onToggle(g)}>
          {cols.map((c) => (
            <div key={c.id} className={`sc-c sc-${c.id}${c.align === "right" ? " r" : ""}`}>{cell(c)}</div>
          ))}
        </button>
        {cols.some((c) => c.id === "links") && <SongLinks song={info} className="sc-links" />}
      </div>

      {isOpen && (
        <div className="plays">
          {g.tracks.map((t) => {
            const ev = lk.events.get(t.eventId);
            const person = t.personId ? lk.peopleName.get(t.personId) : null;
            return (
              <button key={t.id} className="play" onClick={() => onOpen(t)}>
                <span className="when">{ev?.kind === "collection" ? "collection" : fmtDate(ev?.date)}</span>
                <span className="what">{ev?.title || ev?.types.join(" + ") || ev?.folder}</span>
                <span className="who">{person ?? "unknown"}</span>
                <span className="len">{fmtDur(t.durationSec)}</span>
              </button>
            );
          })}
          {g.songId && g.nights > 1 && (
            <button className="play trace" onClick={() => {
              const s = lk.songs.get(g.songId!);
              if (s) onTrace({
                kind: "song", id: s.id, label: `${s.artist} — ${s.title}`,
                nights: new Set(s.nights),
              });
            }}>
              show these nights on the timeline →
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export default function SongSearch({ cat, enrich = null, onOpen, onTrace, initialQuery, onQueryChange }: {
  cat: Catalog;
  /** Release year / genre family / cover per song; null until (or unless) it exists. */
  enrich?: EnrichMap | null;
  onOpen: (t: Track) => void;
  onTrace: (t: Trace) => void;
  /** Optional extra way in for a query from the URL (#/search?q=..). The shared
   *  store in events.ts does the same job; Search works with neither. */
  initialQuery?: string;
  /** Optional: called with the new text whenever the box changes. */
  onQueryChange?: (q: string) => void;
}) {
  const [query, setQueryRaw] = useSessionState("search.q", "");
  const [includeAnon, setIncludeAnon] = useSessionState("search.anon", false);
  const [personId, setPersonId] = useSessionState("search.person", "");
  const [year, setYear] = useSessionState("search.year", "");
  const [type, setType] = useSessionState("search.type", "");
  const [fams, setFams] = useSessionState<string[]>("search.fam", []);
  const [decs, setDecs] = useSessionState<string[]>("search.dec", []);
  const [sortPref, setSortPref] = useSessionState<SortKey | "auto">("search.sort", "auto");
  const [colSort, setColSort] = useSessionState<{ id: string; dir: "asc" | "desc" } | null>("search.colsort", null);
  const [choice, toggleCol, resetCols] = useColumnChoice("search");
  const width = useViewportWidth();
  const [open, setOpenRaw] = useState<string | null>(memo_.open);
  const [limit, setLimitRaw] = useState(memo_.limit);

  const setOpen = useCallback((k: string | null) => { memo_.open = k; setOpenRaw(k); }, []);
  const setLimit = useCallback((f: (n: number) => number) => {
    setLimitRaw((n) => { const v = f(n); memo_.limit = v; return v; });
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef<HTMLDivElement>(null);
  const [stickH, setStickH] = useState(160);
  const moreRef = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const { toast, node: toastNode } = useToast();

  const setQuery = useCallback((v: string) => {
    setQueryRaw(v);
    emitted.current = v;
    setSearchQuery(v);          // the shell mirrors this into the URL
    onQueryChange?.(v);
  }, [setQueryRaw, onQueryChange]);

  // The URL is the other way in: adopt a query that did not come from this box
  // (a pasted link, browser back). An empty one on arrival must not wipe the
  // query being remembered; the remembered one is handed to the shell instead.
  const seen = useRef("");
  seen.current = query;
  useEffect(() => {
    const arriving = initialQuery ?? getSearchQuery();
    if (arriving && arriving !== seen.current) { setQueryRaw(arriving); setOpen(null); }
    else if (!arriving && seen.current) setSearchQuery(seen.current);
    return subscribeSearchQuery((q) => {
      if (q === emitted.current || q === seen.current) return;
      setQueryRaw(q); setOpen(null);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (initialQuery !== undefined && initialQuery !== emitted.current && initialQuery !== seen.current) {
      setQueryRaw(initialQuery); setOpen(null);
    }
  }, [initialQuery, setQueryRaw, setOpen]);

  // "/" anywhere focuses the box.
  useEffect(() => {
    const focus = () => {
      consumeFocusRequest();
      inputRef.current?.focus(); inputRef.current?.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, []);

  // Coming back from a track: land where we were. Otherwise focus the box
  // (without scrolling, which would undo the restore).
  useLayoutEffect(() => {
    const root = scrollRootOf(inputRef.current);
    if (consumeFocusRequest()) { inputRef.current?.focus(); inputRef.current?.select(); }
    else if (root && memo_.scroll > 0) root.scrollTop = memo_.scroll;
    else inputRef.current?.focus({ preventScroll: true });
    if (!root) return;
    const onScroll = () => { memo_.scroll = root.scrollTop; };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, []);

  // The column header sticks just under the search box and filters, whatever height they wrap to.
  useLayoutEffect(() => {
    const el = stickRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setStickH(Math.round(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // One facts object per group (songFactsFor memoises per catalogue and enrichment).
  const infoOf = useMemo(() => {
    const m = new WeakMap<Group, SongInfo>();
    return (g: Group) => {
      let i = m.get(g);
      if (!i) m.set(g, i = songFactsFor(cat, enrich, g.songId ?? g.tracks[0]));
      return i;
    };
  }, [cat, enrich]);
  const allCols = useMemo<Column<Group>[]>(() => {
    // "Nights" here counts the nights that survived the filters, like the old chip did.
    // Search gives the title the flexible share (page-specific; the shared defaults stay).
    const std = songColumns<Group>(infoOf).map((c) => c.id === "nights"
      ? { ...c, sortKey: (g: Group) => g.nights, text: (g: Group) => String(g.nights) }
      : c.id === "title" ? { ...c, width: "minmax(0,3fr)" }
      : c.id === "artist" ? { ...c, width: "minmax(0,1.5fr)" } : c);
    const links = std.pop()!;
    return [...std, PEOPLE_COL, WHEN_COL, links];
  }, [infoOf]);
  const cols = useMemo(() => visibleColumns(allCols, choice, width), [allCols, choice, width]);

  const index = useMemo(() => buildIndex(cat), [cat]);
  const lk = useMemo(() => lookups(cat), [cat]);

  const years = useMemo(() => [...new Set(
    cat.events.filter((e) => isShown(e) && e.date)
      .map((e) => e.date!.slice(0, 4)))].sort(), [cat]);
  const types = useMemo(() => [...new Set(
    cat.events.filter(isShown).flatMap((e) => e.types))].sort(), [cat]);
  const range = useMemo(() => {
    const ys = years;
    return ys.length ? `${ys[0]}–${ys[ys.length - 1]}` : "";
  }, [years]);
  const nightCount = useMemo(() => cat.events.filter(isShown).length, [cat]);

  // Typing stays instant; the 3,000-song regroup happens at lower priority.
  const dq = useDeferredValue(query);
  const q = dq.trim();
  const stale = dq !== query;

  // Genre / decade chips. Without enrichment they do not exist, whatever was remembered.
  const sel = useMemo<Sel>(() => (enrich ? { families: fams, decades: decs } : NO_SEL), [enrich, fams, decs]);
  const enrichOn = selActive(sel);
  const libFacts = useMemo(() => cat.songs.map((s) => factOf(enrich, s.id)), [cat, enrich]);
  const uni = useMemo(() => universe(libFacts), [libFacts]);
  const libCov = useMemo(() => coverage(libFacts), [libFacts]);

  const { groups: raw0, plays: plays0 } = useMemo(() => {
    // Searching ranks tracks; an empty query takes everything, so the landing
    // page can lead with what the library plays most.
    const hits = search(index, dq, {
      includeAnon, personId: personId || null, limit: q && !enrichOn ? 3000 : 20000,
    });
    return groupHits(hits, lk, { year, type });
  }, [index, dq, q, includeAnon, personId, year, type, lk, enrichOn]);

  // Chips narrow what the text and the other filters found; counts are faceted on it.
  const facts0 = useMemo(
    () => (enrich ? raw0.map((g) => factOf(enrich, g.songId)) : []), [raw0, enrich]);
  const facets = useMemo(() => songFacets(facts0, sel), [facts0, sel]);
  const sum = useMemo(() => summarise(facts0, sel), [facts0, sel]);
  const { groups: raw, plays } = useMemo(() => {
    if (!enrichOn) return { groups: raw0, plays: plays0 };
    const kept = raw0.filter((_, i) => passes(facts0[i], sel));
    return { groups: kept, plays: kept.reduce((n, g) => n + g.tracks.length, 0) };
  }, [raw0, plays0, facts0, sel, enrichOn]);

  // With no text, filters alone list songs A to Z (nothing else is a sensible order).
  const sort: SortKey = sortPref === "auto" || (sortPref === "match" && !q)
    ? (q ? "match" : enrichOn ? "az" : "nights") : sortPref;
  const sortCol = colSort ? cols.find((c) => c.id === colSort.id && c.sortKey) : undefined;
  const groups = useMemo(() => {
    const base = sortGroups(raw, sort, !!q);
    // A header click sorts by that column; ties keep the order above, unknowns go last.
    return sortCol && colSort ? sortRows(base, sortCol.sortKey!, colSort.dir) : base;
  }, [raw, sort, q, sortCol, colSort]);
  const shown = useMemo(() => groups.slice(0, limit), [groups, limit]);
  const filtered = !!(personId || year || type);

  // A new question starts at the top with nothing unfolded.
  useOnChange([dq, includeAnon, personId, year, type, sort, sortCol?.id, colSort?.dir, fams.join(","), decs.join(",")].join("|"), () => {
    setOpen(null);
    setLimit(() => BATCH);
    scrollRootOf(inputRef.current)?.scrollTo({ top: 0, behavior: "instant" });
  });

  // Grow the list when its end comes near.
  useEffect(() => {
    const el = moreRef.current;
    if (!el || shown.length >= groups.length || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) setLimit((n) => n + BATCH);
    }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [shown.length, groups.length, setLimit]);

  const toggle = useCallback((g: Group) => {
    if (g.tracks.length === 1) onOpen(g.tracks[0]);
    else setOpen(memo_.open === g.key ? null : g.key);
  }, [onOpen, setOpen]);

  const clearFilters = () => { setPersonId(""); setYear(""); setType(""); };
  const setSel = (s: Sel) => { setFams(s.families); setDecs(s.decades); };

  // Every filter that is on, as removable chips under the bar (never the query).
  const fstate: FilterState = { personId, year, type, families: sel.families, decades: sel.decades };
  const applyFilters = (f: FilterState) => {
    setPersonId(f.personId); setYear(f.year); setType(f.type); setFams(f.families); setDecs(f.decades);
  };
  const chips = useMemo(() => activeChips(
    { personId, year, type, families: sel.families, decades: sel.decades },
    { person: (id) => lk.peopleName.get(id) ?? id, family: familyLabel },
  ), [personId, year, type, sel, lk]);
  const idle = !q && !filtered && !enrichOn;
  const ideas = useMemo(
    () => suggestions(cat.songs, enrich ? uni.decades.map(([d]) => d) : []), [cat, enrich, uni]);

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      const first = listRef.current?.querySelector<HTMLElement>("button.row");
      if (first) { e.preventDefault(); first.focus(); }
    } else if (e.key === "Enter") {
      if (shown[0]) { e.preventDefault(); toggle(shown[0]); }
    } else if (e.key === "Escape") {
      if (query) { e.preventDefault(); setQuery(""); }
      else inputRef.current?.blur();
    }
  };

  // Up/Down walk the rows (and any unfolded nights) with real focus, so Enter
  // and screen readers work without a second, invisible cursor.
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") { e.preventDefault(); inputRef.current?.focus(); return; }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>("button.row, button.play") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const to = stepIndex(at, e.key === "ArrowDown" ? 1 : -1, items.length);
    if (to < 0) inputRef.current?.focus();
    else {
      items[to].focus();
      if (to === items.length - 1 && shown.length < groups.length) setLimit((n) => n + BATCH);
    }
  };

  const copyLink = async () => {
    toast((await copyText(window.location.href)) ? "Link to this search copied" : "Could not copy the link");
  };

  const clickHeader = (c: Column<Group>) => {
    if (!c.sortKey) return;
    if (colSort?.id !== c.id) setColSort({ id: c.id, dir: "asc" });
    else if (colSort.dir === "asc") setColSort({ id: c.id, dir: "desc" });
    else setColSort(null);
  };

  const sortOptions: SortKey[] = ["match", "nights", "az", "newest"];

  return (
    <div className="page wide search">
      <h1>Search the collection</h1>
      <p className="sub">
        {fmtCount(cat.stats.songs)} songs · {fmtCount(cat.stats.artists)} artists ·
        {" "}{fmtCount(nightCount)} nights{range && <> spanning {range}</>}
      </p>

      <div className="sstick" ref={stickRef}>
        <div className="sb">
          <div className="searchwrap">
            <span className="searchicon" aria-hidden="true"><SearchIcon size={19} /></span>
            <input
              ref={inputRef}
              className="searchbox"
              type="text"
              aria-label="Search songs, artists, albums, people or nights"
              aria-keyshortcuts="/"
              title="Press / anywhere to jump to this box"
              placeholder="Search songs, artists, albums, people or nights"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onInputKey}
              spellCheck={false}
              autoComplete="off"
            />
            {query ? (
              <button className="searchclear" aria-label="Clear search" title="Clear (Esc)"
                onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
                <CloseIcon size={15} />
              </button>
            ) : (
              <kbd className="sb-key" aria-hidden="true" title="Press / anywhere to jump to the search box">/</kbd>
            )}
          </div>

          <div className="sb-bar">
            <select aria-label="Brought by" value={personId}
              onChange={(e) => setPersonId(e.target.value)}>
              <option value="">Anyone</option>
              {cat.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">Any year</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <select aria-label="Kind of night" value={type} onChange={(e) => setType(e.target.value)}>
              <option value="">Any kind of night</option>
              {types.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select aria-label="Sort by" value={sort}
              onChange={(e) => { setSortPref(e.target.value as SortKey); setColSort(null); }}>
              {sortOptions.map((s) => (
                <option key={s} value={s} disabled={s === "match" && !q}>{SORT_LABEL[s]}</option>
              ))}
            </select>
            {enrich && (uni.families.length > 0 || uni.decades.length > 0) && (
              <EnrichPopovers universe={uni} counts={facets} sel={sel} onChange={setSel}
                hint={hiddenNote(sum, sel, libCov)} />
            )}
            <label className="sb-switch" title={`Include the ${fmtCount(cat.stats.anonTracks)} anonymised tracks`}>
              <input type="checkbox" role="switch" checked={includeAnon}
                aria-label={`Include anonymised tracks (${fmtCount(cat.stats.anonTracks)})`}
                onChange={(e) => setIncludeAnon(e.target.checked)} />
              <span className="sb-track" aria-hidden="true" />
              Anonymised
            </label>
            <span className="sb-end">
              <ColumnsMenu columns={allCols} choice={choice} onToggle={toggleCol} onReset={resetCols} />
            </span>
          </div>
        </div>

        {chips.length > 0 && (
          <div className="sb-active" role="group" aria-label="Active filters">
            {chips.map((c) => (
              <button key={c.kind + c.value} type="button" className="sb-chip"
                aria-label={`Remove filter ${c.label}`} title="Remove this filter"
                onClick={() => applyFilters(removeChip(fstate, c))}>
                {c.label}<span aria-hidden="true">✕</span>
              </button>
            ))}
            <button type="button" className="linkbtn" onClick={() => applyFilters(clearAll(fstate))}>Clear all</button>
          </div>
        )}
      </div>

      {idle && (ideas.artists.length > 0 || ideas.songs.length > 0 || ideas.decades.length > 0) && (
        <div className="sb-ideas">
          {ideas.artists.length > 0 && (
            <div className="sb-idearow"><span className="sb-idealabel">Most nights</span>
              {ideas.artists.map((a) => (
                <button key={a.name} type="button" className="fchip" onClick={() => setQuery(a.name)}>
                  {a.name} <i>{fmtCount(a.nights)}</i>
                </button>
              ))}
            </div>
          )}
          {ideas.songs.length > 0 && (
            <div className="sb-idearow"><span className="sb-idealabel">Brought most often</span>
              {ideas.songs.map((x) => (
                <button key={x.title + x.artist} type="button" className="fchip" onClick={() => setQuery(x.title)}
                  title={x.artist ?? undefined}>
                  {x.title} <i>{fmtCount(x.nights)}</i>
                </button>
              ))}
            </div>
          )}
          {ideas.decades.length > 0 && (
            <div className="sb-idearow"><span className="sb-idealabel">Try a decade</span>
              {ideas.decades.map((d) => (
                <button key={d} type="button" className="fchip" onClick={() => setDecs([d])}>{d}</button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="sb-count" aria-live="polite">
        <span>
          {enrichOn
            ? `${fmtCount(sum.shown)} of ${fmtCount(sum.total)} songs`
            : plural(groups.filter((g) => g.songId).length, "song")}
          {!enrichOn && groups.some((g) => !g.songId) && ` + ${fmtCount(groups.filter((g) => !g.songId).length)} without an artist`}
          {" · "}{plural(plays, "play")}
          {!sortCol && ` · ${orderText(sort)}`}
        </span>
        {q && (
          <button className="linkbtn" onClick={() => void copyLink()} title="Copy a link to this search">
            <CopyIcon size={13} /> copy link
          </button>
        )}
      </div>

      {groups.length === 0 ? (
        <div className="empty">
          <div className="big" aria-hidden="true">◌</div>
          <div>
            {q && enrichOn
              ? <>No song matches “{q}” with those genre and decade chips.</>
              : q
              ? <>No song or artist matches “{q}”. Try fewer words, or a different spelling.</>
              : "Nothing matches those filters."}
          </div>
          <div className="emptyacts">
            {q && <button className="dr-btn ghost" onClick={() => setQuery("")}>Clear search</button>}
            {filtered && <button className="dr-btn ghost" onClick={clearFilters}>Clear filters</button>}
            {enrichOn && <button className="dr-btn ghost" onClick={() => setSel(NO_SEL)}>Clear genre and decade</button>}
            {!includeAnon && cat.stats.anonTracks > 0 && (
              <button className="dr-btn ghost" onClick={() => setIncludeAnon(true)}>
                Include {fmtCount(cat.stats.anonTracks)} anonymised tracks
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className={`rows resultlist sc-list${stale ? " stale" : ""}`} ref={listRef} onKeyDown={onListKey}
          style={{ "--cols": gridTemplate(cols), "--sc-top": `${stickH}px` } as CSSProperties}>
          <div className="sc-head" role="row">
            {cols.map((c) => {
              const on = colSort?.id === c.id ? colSort.dir : null;
              return (
                <div key={c.id} role="columnheader" className={`sc-h${c.align === "right" ? " r" : ""}`}
                  aria-sort={c.sortKey ? (on === "asc" ? "ascending" : on === "desc" ? "descending" : "none") : undefined}>
                  {c.sortKey ? (
                    <button type="button" className={`sc-hb${on ? " on" : ""}`} onClick={() => clickHeader(c)}
                      title={`Sort by ${c.label.toLowerCase()}`}>
                      {c.label}<span className="sc-arrow" aria-hidden="true">{on === "asc" ? "▲" : on === "desc" ? "▼" : ""}</span>
                    </button>
                  ) : c.id === "cover" || c.id === "links" ? <span className="sc-sr">{c.label}</span> : c.label}
                </div>
              );
            })}
          </div>
          {shown.map((g) => (
            <GroupRow key={g.key} g={g} info={infoOf(g)} cols={cols} isOpen={open === g.key} q={q} lk={lk} enrich={enrich}
              onToggle={toggle} onOpen={onOpen} onTrace={onTrace} />
          ))}
          {shown.length < groups.length && (
            <div className="more" ref={moreRef}>
              <button className="dr-btn ghost" onClick={() => setLimit((n) => n + BATCH)}>
                Show more · {fmtCount(groups.length - shown.length)} left
              </button>
            </div>
          )}
        </div>
      )}
      {toastNode}
    </div>
  );
}
