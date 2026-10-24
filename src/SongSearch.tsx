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
  type KeyboardEvent,
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
import EnrichChips, { Thumb } from "./EnrichChips.tsx";
import { coverUrlOf, familyOf, yearOf, type EnrichMap } from "./enrich.ts";
import { familyColour, familyLabel } from "./families.ts";
import {
  coverage, factOf, NO_SEL, passes, selActive, songFacets, summarise, summaryText, universe,
  type Sel,
} from "./enrichfilter.ts";
import { CloseIcon, CopyIcon, SearchIcon } from "./icons.tsx";
import "./pages.css";
import "./enrichfilter.css";

const BATCH = 120;   // rows added each time the list grows

/** What survives leaving the page for a track and coming back (not a reload). */
const memo_ = { scroll: 0, open: null as string | null, limit: BATCH };

const GroupRow = memo(function GroupRow({ g, isOpen, q, lk, enrich, onToggle, onOpen, onTrace }: {
  g: Group; isOpen: boolean; q: string; lk: Lookups; enrich: EnrichMap | null;
  onToggle: (g: Group) => void; onOpen: (t: Track) => void; onTrace: (t: Trace) => void;
}) {
  const solo = g.tracks.length === 1;
  const rec = enrich && g.songId ? enrich[g.songId] : undefined;
  const fam = familyOf(rec), yr = yearOf(rec);
  return (
    <div className={`songgroup${isOpen ? " open" : ""}`}>
      <button className="row" aria-expanded={solo ? undefined : isOpen}
        title={solo ? "Open this track" : isOpen ? "Hide the nights" : "Show every night it was played"}
        onClick={() => onToggle(g)}>
        <div className={enrich ? "t ef-t" : "t"}>
          {enrich && <Thumb songId={g.songId ?? g.key} url={coverUrlOf(rec)} />}
          <span className={enrich ? "ef-tt" : undefined}>
            <Marked value={g.title} query={q} />
            {g.variants.slice(0, 2).map((v) => (
              <span key={v} className="chip variant">{v}</span>
            ))}
            {g.nights > 1 && (
              <span className="chip recurs" title={`Played on ${g.nights} nights`}>
                {g.nights} nights
              </span>
            )}
            {g.anon && <span className="chip anon">anon</span>}
          </span>
        </div>
        <div className="a">
          <Marked value={g.artist ?? "—"} query={q} />
          {(fam || yr) && (
            <span className="ef-quiet" title={[fam && familyLabel(fam), yr && `released ${yr}`].filter(Boolean).join(", ")}>
              {fam && <span className="ef-dot" style={{ background: familyColour(fam) }} />}
              {yr}
            </span>
          )}
        </div>
        <div className="p">
          {g.people.length
            ? g.people.slice(0, 2).join(", ") + (g.people.length > 2 ? ` +${g.people.length - 2}` : "")
            : <span className="faint">unknown</span>}
        </div>
        <div className="d">{g.span}</div>
      </button>

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
  const [open, setOpenRaw] = useState<string | null>(memo_.open);
  const [limit, setLimitRaw] = useState(memo_.limit);

  const setOpen = useCallback((k: string | null) => { memo_.open = k; setOpenRaw(k); }, []);
  const setLimit = useCallback((f: (n: number) => number) => {
    setLimitRaw((n) => { const v = f(n); memo_.limit = v; return v; });
  }, []);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
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
  const groups = useMemo(() => sortGroups(raw, sort, !!q), [raw, sort, q]);
  const shown = useMemo(() => groups.slice(0, limit), [groups, limit]);
  const filtered = !!(personId || year || type);

  // A new question starts at the top with nothing unfolded.
  useOnChange([dq, includeAnon, personId, year, type, sort, fams.join(","), decs.join(",")].join("|"), () => {
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

  const sortOptions: SortKey[] = ["match", "nights", "az", "newest"];

  return (
    <div className="page">
      <h1>Search the collection</h1>
      <p className="sub">
        {fmtCount(cat.stats.songs)} songs · {fmtCount(cat.stats.artists)} artists ·
        {" "}{fmtCount(nightCount)} nights{range && <> spanning {range}</>}
      </p>

      <div className="sstick">
        <div className="searchwrap">
          <span className="searchicon" aria-hidden="true"><SearchIcon size={19} /></span>
          <input
            ref={inputRef}
            className="searchbox"
            type="text"
            aria-label="Search songs, artists, albums, people or events"
            aria-keyshortcuts="/"
            placeholder="Song, artist, album, person or event…   ( / to focus )"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            spellCheck={false}
            autoComplete="off"
          />
          {query && (
            <button className="searchclear" aria-label="Clear search" title="Clear (Esc)"
              onClick={() => { setQuery(""); inputRef.current?.focus(); }}>
              <CloseIcon size={15} />
            </button>
          )}
        </div>

        <div className="filters">
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
            onChange={(e) => setSortPref(e.target.value as SortKey)}>
            {sortOptions.map((s) => (
              <option key={s} value={s} disabled={s === "match" && !q}>{SORT_LABEL[s]}</option>
            ))}
          </select>
          {filtered && (
            <button className="tl-clear nomargin" onClick={clearFilters}>clear filters</button>
          )}
          <label>
            <input type="checkbox" checked={includeAnon}
              onChange={(e) => setIncludeAnon(e.target.checked)} />
            Include anonymised ({fmtCount(cat.stats.anonTracks)})
          </label>
          <span className="rcount" aria-live="polite">
            {enrichOn ? summaryText(sum, sel) : plural(groups.filter((g) => g.songId).length, "song")}
            {!enrichOn && groups.some((g) => !g.songId) && ` + ${fmtCount(groups.filter((g) => !g.songId).length)} without an artist`}
            {" · "}{plural(plays, "play")}
            {!q && !filtered && !enrichOn && ` ·${SORT_LABEL[sort].toLowerCase()} first`}
            {q && (
              <button className="linkbtn" onClick={() => void copyLink()} title="Copy a link to this search">
                <CopyIcon size={13} /> copy link
              </button>
            )}
          </span>
        </div>
      </div>

      {enrich && (uni.families.length > 0 || uni.decades.length > 0) && (
        <EnrichChips universe={uni} counts={facets} sel={sel} onChange={setSel}
          hint={`${fmtCount(libCov.either)} of ${fmtCount(libCov.total)} songs have a genre or year on file; the rest are hidden while a chip is on.`} />
      )}

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
        <div className={`rows resultlist${stale ? " stale" : ""}${enrich ? " ef-rich" : ""}`} ref={listRef} onKeyDown={onListKey}>
          {shown.map((g) => (
            <GroupRow key={g.key} g={g} isOpen={open === g.key} q={q} lk={lk} enrich={enrich}
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
