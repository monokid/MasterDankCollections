/** The Music page: every song brought to a dated night, as a wall of tiles you can
 *  browse, filter and wander; and, per artist, the discography across all nights.
 *
 *  The wall is virtualised by rows (fixed tile height per width, so ~3,000 tiles
 *  cost about 40 in the DOM). Cover art is a hotlinked extra: every tile draws its
 *  own generative art first and the image fades in over it, so a slow or blocked
 *  image never changes the layout or breaks the page. Numbers live in musicstats.ts. */
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type ReactNode,
} from "react";
import type { Catalog } from "./catalog.ts";
import type { EnrichMap } from "./enrich.ts";
import SongLinks, { CellText } from "./SongLinks.tsx";
import ColumnsMenu, { useColumnChoice, useViewportWidth } from "./ColumnsMenu.tsx";
import { gridTemplate, songColumns, sortRows, visibleColumns, type Column, type SongInfo } from "./songcols.ts";
import { arrangeColumns, linkable, makeWallInfo, nextSort, tileQuiet, type ColSort } from "./songrows.ts";
import type { Trace } from "./Timeline.tsx";
import {
  artistOrder, buildWall, coverage, discography, facetCounts, factsOf, filterSongs, initialsOf,
  isFiltered, layoutRows, letterCounts, LETTERS, NO_FILTERS, SORT_LABEL, sortSongs, stripPos,
  tileArt, type DiscoOrder, type Facts, type Filters, type SortKey, type Wall, type WallSong,
} from "./musicstats.ts";
import { artistHistory, verdictSentence } from "./songstats.ts";
import { personColour } from "./colours.ts";
import { fmtCount, fmtDate, plural } from "./format.ts";
import { useOnChange, useSessionState } from "./hooks.ts";
import { scrollRootOf } from "./pagehelpers.ts";
import { CloseIcon, SearchIcon } from "./icons.tsx";
import ArtistsWall, { artistsMemory } from "./MusicArtists.tsx";
import AlbumCover from "./Cover.tsx";
import {
  ARTIST_SORT_LABEL, ARTIST_SORTS, buildArtistRows, defaultGrouping, groupByAlbum, NO_ALBUM, sortArtists, type ArtistSort,
} from "./artistalbums.ts";
import { fmtDuration } from "./songcols.ts";
import "./pages.css";
import "./music.css";
import "./songrows.css";
import "./musicartists.css";

export interface MusicPageProps {
  cat: Catalog;
  /** Public-database facts about songs; null when none shipped. Partial by nature. */
  enrich: EnrichMap | null;
  /** The artist whose discography is open, or null for the library wall. */
  artistId: string | null;
  onOpenArtist: (id: string | null) => void;
  /** Opens a song's history (the track detail screen). */
  onOpenSong: (songId: string) => void;
  onOpenNight: (eventId: string) => void;
  onOpenPerson: (personId: string) => void;
  onTrace: (t: Trace) => void;
}

// ------------------------------------------------------------------ bits

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const style = (vars: Record<string, string | number>) => vars as unknown as CSSProperties;

const spanOf = (s: WallSong) => {
  const a = s.years[0], b = s.years[s.years.length - 1];
  return a === b ? String(a) : `${a}–${b}`;
};
const quietLine = (s: WallSong) => `${plural(s.nights, "night")} · ${spanOf(s)}`;
const isStaple = (s: WallSong) => s.nights >= 8 || s.people.length >= 4;
const NO_ARTIST = "Unknown artist";
const artistName = (s: WallSong) => s.artist || NO_ARTIST;

/** Generative art unique to an id: two hues, soft gradients and one organic blob. */
function Art({ id, title }: { id: string; title: string }) {
  const a = tileArt(id);
  return (
    <span className="mu-art" aria-hidden="true" style={style({
      "--h1": a.h1, "--h2": a.h2, "--ang": a.angle, "--x1": a.x1, "--y1": a.y1, "--x2": a.x2, "--y2": a.y2,
      "--blob": a.blob, "--spin": `${a.spin}deg`,
    })}>
      <span className="mu-blob" />
      <span className="mu-init">{initialsOf(title)}</span>
    </span>
  );
}

/** The art, with a cover image fading in over it when there is one. */
function Cover({ id, title, url }: { id: string; title: string; url: string | null }) {
  const [state, setState] = useState<"wait" | "on" | "failed">("wait");
  return (
    <>
      <Art id={id} title={title} />
      {url && state !== "failed" && (
        <img className={`mu-img${state === "on" ? " on" : ""}`} src={url} alt="" loading="lazy" decoding="async"
          referrerPolicy="no-referrer" onLoad={() => setState("on")} onError={() => setState("failed")} />
      )}
    </>
  );
}

/** One dot per year of the library; lit where the song was brought. */
function Journey({ song, y0, y1 }: { song: WallSong; y0: number; y1: number }) {
  const have = new Set(song.years);
  const cells: number[] = [];
  for (let y = y0; y <= y1; y++) cells.push(y);
  return (
    <span className="mu-journey" aria-hidden="true">
      <span className="mu-jlabel">{song.nights > 1 ? `${plural(song.nights, "night")}, ${spanOf(song)}` : `brought ${song.years[0]}`}</span>
      <span className="mu-jdots">
        {cells.map((y) => <i key={y} className={have.has(y) ? "lit" : ""} title={String(y)} />)}
      </span>
      <span className="mu-jaxis"><span>{y0}</span><span>{y1}</span></span>
    </span>
  );
}

interface TileProps {
  song: WallSong; info: SongInfo; cols: Column<WallSong>[];
  index: number; col: number; url: string | null; y0: number; y1: number;
  tab: boolean; onOpen: (s: WallSong) => void; onFocusTile: (i: number) => void;
}

const label = (s: WallSong, quiet: string) =>
  `${s.title}, ${artistName(s)}, ${quiet}${isStaple(s) ? ", a staple" : ""}${s.loose ? ", no song page: opens its first night" : ""}`;
const tileLine = (s: WallSong, i: SongInfo) => tileQuiet(i, plural(s.nights, "night"), spanOf(s));

/** Spotify / YouTube icons for one song. They sit beside the row's button (an anchor
 *  cannot live inside a button) and the wall keeps one tab stop, so only the current
 *  row's links are tabbable. Arrow keys and Enter belong to the button, not these. */
function RowLinks({ song, tab, className }: { song: SongInfo; tab: boolean; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll("a").forEach((a) => { a.tabIndex = tab ? 0 : -1; });
  }, [tab]);
  return <span ref={ref} className={className}><SongLinks song={song} /></span>;
}

const Tile = memo(function Tile({ song, info, index, col, url, y0, y1, tab, onOpen, onFocusTile }: TileProps) {
  const quiet = tileLine(song, info);
  return (
    <div className="mu-tw">
      <button type="button" className="mu-tile" data-i={index} tabIndex={tab ? 0 : -1}
        style={style({ "--d": `${Math.min(col, 7) * 45}ms` })}
        aria-label={label(song, quiet)} onClick={() => onOpen(song)} onFocus={() => onFocusTile(index)}>
        <span className="mu-face">
          <Cover id={song.songId} title={song.title} url={url} />
          {isStaple(song) && <span className="mu-ribbon">staple</span>}
          <Journey song={song} y0={y0} y1={y1} />
        </span>
        <span className="mu-t">{song.title}</span>
        <span className={`mu-a${song.artist ? "" : " none"}`}>{artistName(song)}</span>
        <span className="mu-q" title={quiet}>{quiet}</span>
      </button>
      {linkable(info) && <RowLinks song={info} tab={tab} className="mu-tlinks" />}
    </div>
  );
});

/** The standard song columns over wall songs, plus the journey dots; used by the wall's List. */
const listColumns = (get: (s: WallSong) => SongInfo): Column<WallSong>[] => arrangeColumns(songColumns<WallSong>(get), {
  off: ["artist"],
  extra: [{ col: { id: "journey", label: "Years", width: "120px", align: "left", sortKey: null, text: () => null, hideBelow: 900 }, before: "nights" }],
});

const ListRow = memo(function ListRow({ song, info, cols, index, col, url, y0, y1, tab, onOpen, onFocusTile }: TileProps) {
  const have = new Set(song.years);
  const years: number[] = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  const hasArtist = cols.some((c) => c.id === "artist");
  const cell = (c: Column<WallSong>): ReactNode => {
    switch (c.id) {
      case "cover": return <span className="mu-thumb"><Cover id={song.songId} title={song.title} url={url} /></span>;
      case "title": return (
        <span className="mu-lmain">
          <span className="mu-t">{song.title}{isStaple(song) && <em className="mu-staple">staple</em>}</span>
          {!hasArtist && <span className={`mu-a${song.artist ? "" : " none"}`}>{artistName(song)}</span>}
        </span>
      );
      case "journey": return (
        <span className="mu-jdots small" aria-hidden="true">
          {years.map((y) => <i key={y} className={have.has(y) ? "lit" : ""} />)}
        </span>
      );
      case "links": return null;   // drawn beside the button, below
      default: return <CellText value={c.text(song)} title={c.title?.(song)} />;
    }
  };
  return (
    <div className="mu-lwrap">
      <button type="button" className="mu-lrow" data-i={index} tabIndex={tab ? 0 : -1}
        style={style({ "--d": `${Math.min(col, 3) * 45}ms` })}
        aria-label={label(song, tileLine(song, info))} onClick={() => onOpen(song)} onFocus={() => onFocusTile(index)}>
        {cols.map((c) => (
          <span key={c.id} className={`sc-c sc-${c.id}${c.align === "right" ? " r" : ""}`}>{cell(c)}</span>
        ))}
      </button>
      {linkable(info) && cols.some((c) => c.id === "links") && <RowLinks song={info} tab={tab} className="mu-llinks" />}
    </div>
  );
});

/** Header cells shared by the wall's List and the artist page: a button that sorts
 *  (off -> ascending -> descending -> off) when the column can, plain text when not. */
function HeadCells({ cols, colSort, onSort, special }: {
  cols: Column<WallSong>[]; colSort: ColSort | null; onSort: (c: Column<WallSong>) => void;
  special?: Record<string, ReactNode>;
}) {
  return (
    <>
      {cols.map((c) => {
        const on = colSort?.id === c.id ? colSort.dir : null;
        return (
          <div key={c.id} role="columnheader" className={`sc-h${c.align === "right" ? " r" : ""}${special?.[c.id] ? " mu-axish" : ""}`}
            aria-sort={c.sortKey ? (on === "asc" ? "ascending" : on === "desc" ? "descending" : "none") : undefined}>
            {c.sortKey ? (
              <button type="button" className={`sc-hb${on ? " on" : ""}`} onClick={() => onSort(c)}
                title={`Sort by ${c.label.toLowerCase()}`}>
                {c.label}<span className="sc-arrow" aria-hidden="true">{on === "asc" ? "▲" : on === "desc" ? "▼" : ""}</span>
              </button>
            ) : special?.[c.id]
              ? <>{special[c.id]}<span className="sc-sr">{c.label}</span></>
              : c.id === "cover" || c.id === "links" ? <span className="sc-sr">{c.label}</span> : c.label}
          </div>
        );
      })}
    </>
  );
}

// --------------------------------------------------------------- the wall

const GAP = 16, MIN_TILE = 176, TEXT_H = 78, HEAD_H = 56, LIST_H = 56, OVER = 320;
/** The List's column header: fixed so the scroll maths stay exact (see .mu-lhead). */
const LHEAD_H = 30;

/** What survives leaving the wall for a song or artist page and coming back. */
const memory = { scroll: 0 };

function firstEnding(offs: number[], hs: number[], y: number) {
  let lo = 0, hi = offs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (offs[m] + hs[m] > y) hi = m; else lo = m + 1; }
  return lo;
}
function lastStarting(offs: number[], y: number) {
  let lo = 0, hi = offs.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (offs[m] < y) lo = m + 1; else hi = m; }
  return lo - 1;
}

function WallView({ songs, grouped, compact, facts, infoOf, cols, colSort, onSort, y0, y1, barH: barBase, onOpen }: {
  songs: WallSong[]; grouped: boolean; compact: boolean; facts: Map<string, Facts>;
  infoOf: (s: WallSong) => SongInfo; cols: Column<WallSong>[]; colSort: ColSort | null; onSort: (c: Column<WallSong>) => void;
  y0: number; y1: number; barH: number; onOpen: (s: WallSong) => void;
}) {
  // What sticks above the rows: the filter bar, and in the List the column header too.
  const barH = barBase + (compact ? LHEAD_H : 0);
  const hostRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [range, setRange] = useState({ a: 0, b: 30 });
  const [active, setActive] = useState<string | null>(null);
  const [cur, setCur] = useState(0);
  const pending = useRef<number | null>(null);
  const restored = useRef(false);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setW(Math.floor(el.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (compact) {
      // one row per song: the columns need the whole width
      return { cols: 1, tw: w, h: LIST_H, gapY: 6 };
    }
    const cols = Math.max(1, Math.floor((w + GAP) / (MIN_TILE + GAP)));
    const tw = (w - GAP * (cols - 1)) / cols;
    return { cols, tw, h: Math.round(tw) + TEXT_H, gapY: GAP };
  }, [w, compact]);

  const rows = useMemo(() => layoutRows(songs, geo.cols, grouped), [songs, geo.cols, grouped]);
  const layout = useMemo(() => {
    const offs: number[] = [], hs: number[] = [];
    const heads: Array<{ row: number; letter: string }> = [];
    let y = 0;
    rows.forEach((r, i) => {
      const h = r.kind === "head" ? HEAD_H : geo.h;
      offs.push(y); hs.push(h);
      y += h + (r.kind === "head" ? 0 : geo.gapY);
      if (r.kind === "head") heads.push({ row: i, letter: r.letter });
    });
    return { offs, hs, heads, total: Math.max(0, y - (rows.length ? geo.gapY : 0)) };
  }, [rows, geo]);

  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const barRef = useRef(barH);
  barRef.current = barH;

  /** Where the wall's top edge sits in the scroll root's own coordinates. */
  const wallTop = useCallback(() => {
    const host = hostRef.current, root = scrollRootOf(host);
    if (!host || !root) return null;
    return { root, top: host.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop };
  }, []);

  const update = useCallback(() => {
    const L = layoutRef.current;
    if (!L.offs.length) { setRange({ a: 0, b: -1 }); return; }
    const wt = wallTop();
    const top = wt ? wt.root.scrollTop - wt.top : 0;
    const vh = wt ? wt.root.clientHeight : 900;
    const a = Math.max(0, firstEnding(L.offs, L.hs, top - OVER));
    const b = Math.min(L.offs.length - 1, lastStarting(L.offs, top + vh + OVER));
    setRange((r) => (r.a === a && r.b === b ? r : { a, b }));
    if (L.heads.length) {
      const line = top + barRef.current + 14;
      let cur_ = L.heads[0].letter;
      for (const h of L.heads) { if (L.offs[h.row] <= line) cur_ = h.letter; else break; }
      setActive((p) => (p === cur_ ? p : cur_));
    }
  }, [wallTop]);

  useLayoutEffect(() => { if (w > 0) update(); }, [layout, w, update]);

  useEffect(() => {
    const root = scrollRootOf(hostRef.current);
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      memory.scroll = root.scrollTop;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [update]);

  // Coming back from a song: land where we were, once the wall has its height.
  useLayoutEffect(() => {
    if (restored.current || w === 0 || !layout.total) return;
    restored.current = true;
    const root = scrollRootOf(hostRef.current);
    if (root && memory.scroll > 0) { root.scrollTop = memory.scroll; update(); }
  }, [w, layout.total, update]);

  // Arrow keys moved focus to a tile that may not exist yet: focus it once it does.
  useEffect(() => {
    if (pending.current === null) return;
    const el = hostRef.current?.querySelector<HTMLElement>(`[data-i="${pending.current}"]`);
    if (el) { pending.current = null; el.focus(); }
  });
  useEffect(() => { pending.current = null; }, [songs]);

  const rowOfSong = useCallback(
    (i: number) => Math.max(0, rows.findIndex((r) => r.kind === "tiles" && i >= r.from && i < r.to)), [rows]);

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = (document.activeElement as HTMLElement | null)?.dataset.i;
    if (at === undefined) return;
    const i = +at;
    const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1
      : e.key === "ArrowDown" ? geo.cols : e.key === "ArrowUp" ? -geo.cols : 0;
    if (!d) return;
    e.preventDefault();
    const t = Math.max(0, Math.min(songs.length - 1, i + d));
    if (t === i) return;
    setCur(t);
    pending.current = t;
    const row = rowOfSong(t);
    if (row < range.a + 1 || row > range.b - 1) {
      const wt = wallTop();
      wt?.root.scrollTo({ top: wt.top + layout.offs[row] - barH - 24, behavior: "instant" });
      update();
    }
    // the effect above focuses it as soon as it is on screen
    setRange((r) => ({ ...r }));
  };

  const jump = (letter: string) => {
    const h = layout.heads.find((x) => x.letter === letter);
    const wt = wallTop();
    if (!h || !wt) return;
    setActive(letter);
    wt.root.scrollTo({ top: wt.top + layout.offs[h.row] - barH - 6, behavior: reducedMotion() ? "instant" : "smooth" });
  };

  const counts = useMemo(() => letterCounts(songs), [songs]);
  const mounted = range.b >= range.a ? rows.slice(range.a, range.b + 1) : [];
  // One tab stop for the whole wall: the last focused tile, or the first on screen.
  let firstOn = -1, curOn = false;
  for (const r of mounted) if (r.kind === "tiles") {
    if (firstOn < 0) firstOn = r.from;
    if (cur >= r.from && cur < r.to) curOn = true;
  }
  const tabAt = curOn ? cur : firstOn;
  const Item = compact ? ListRow : Tile;

  return (
    <div className="mu-body">
      <div className="mu-main">
      {compact && (
        <div className="sc-head mu-lhead" role="row" style={style({ "--cols": gridTemplate(cols), "--sc-top": `${barBase}px` })}>
          <HeadCells cols={cols} colSort={colSort} onSort={onSort} />
        </div>
      )}
      <div ref={hostRef} className={`mu-wall${compact ? " list" : ""}`} role="group"
        aria-label="Songs brought to a night" onKeyDown={move}
        style={style({ height: layout.total, "--tw": `${geo.tw}px`, "--gap": `${GAP}px`, "--cols": gridTemplate(cols) })}>
        {w > 0 && mounted.map((r, k) => {
          const i = range.a + k;
          if (r.kind === "head") {
            return (
              <h2 key={`h${r.letter}`} className="mu-head" style={{ top: layout.offs[i], height: HEAD_H }}>
                <span className="mu-hl">{r.letter}</span>
                <span className="mu-hc">{plural(r.count, "song")}</span>
              </h2>
            );
          }
          return (
            <div key={`r${r.from}`} className="mu-rowline"
              style={{ top: layout.offs[i], height: layout.hs[i], gridTemplateColumns: `repeat(${geo.cols}, minmax(0, 1fr))` }}>
              {songs.slice(r.from, r.to).map((s, c) => (
                <Item key={s.songId} song={s} info={infoOf(s)} cols={cols} index={r.from + c} col={c} url={facts.get(s.songId)?.cover ?? null}
                  y0={y0} y1={y1} tab={r.from + c === tabAt} onOpen={onOpen}
                  onFocusTile={setCur} />
              ))}
            </div>
          );
        })}
      </div>
      </div>

      {grouped && (
        <nav className="mu-rail" aria-label="Jump to a letter" style={style({ "--mu-bar": `${barH}px` })}>
          {LETTERS.map((l) => {
            const n = counts.get(l) ?? 0;
            return (
              <button key={l} type="button" disabled={!n} aria-current={active === l ? "true" : undefined}
                aria-label={l === "#" ? "Numbers and symbols" : l === "…" ? "Other scripts" : `Songs starting with ${l}`}
                title={n ? `${l}: ${plural(n, "song")}` : undefined} onClick={() => jump(l)}>{l}</button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the page

const SORTS: SortKey[] = ["az", "nights", "first", "last", "year"];

export default function MusicPage(p: MusicPageProps) {
  const { cat, enrich, artistId, onOpenArtist, onOpenSong, onOpenNight } = p;
  const wall = useMemo(() => buildWall(cat), [cat]);
  const facts = useMemo(() => factsOf(wall, enrich), [wall, enrich]);
  const cov = useMemo(() => coverage(wall.songs, facts), [wall, facts]);

  const [q, setQ] = useSessionState("music.q", "");
  const [family, setFamily] = useSessionState<string | null>("music.family", null);
  const [decade, setDecade] = useSessionState<string | null>("music.decade", null);
  const [type, setType] = useSessionState<string | null>("music.type", null);
  const [personId, setPersonId] = useSessionState<string | null>("music.person", null);
  const [since, setSince] = useSessionState<number | null>("music.since", null);
  const [until, setUntil] = useSessionState<number | null>("music.until", null);
  const [coverOnly, setCoverOnly] = useSessionState("music.cover", false);
  const [noArtist, setNoArtist] = useSessionState("music.noartist", false);
  const [sortPref, setSortPref] = useSessionState<SortKey>("music.sort", "az");
  const [compact, setCompact] = useSessionState("music.compact", false);
  const [view, setView] = useSessionState<"songs" | "artists">("music.view", "songs");
  const [artistSort, setArtistSort] = useSessionState<ArtistSort>("music.artistsort", "az");

  // Without enrichment there is nothing to filter by cover, genre or decade, and a
  // remembered filter from a richer visit must not hide songs silently.
  const filters: Filters = useMemo(() => ({
    q, type, personId, since, until, noArtist,
    family: cov.family ? family : null, decade: cov.year ? decade : null, coverOnly: cov.cover ? coverOnly : false,
  }), [q, type, personId, since, until, noArtist, family, decade, coverOnly, cov]);
  const sort: SortKey = sortPref === "year" && !cov.year ? "az" : sortPref;

  const filtered = useMemo(() => filterSongs(wall.songs, filters, facts), [wall, filters, facts]);
  const songs = useMemo(() => sortSongs(filtered, sort, facts), [filtered, sort, facts]);

  const clearFilters = () => {
    setQ(""); setFamily(null); setDecade(null); setType(null); setPersonId(null);
    setSince(null); setUntil(null); setCoverOnly(false); setNoArtist(false);
  };

  // A loose song has no history page; its first night is the nearest honest place.
  const open = useCallback((s: WallSong) => {
    if (s.loose) onOpenNight(s.nightIds[0]); else onOpenSong(s.songId);
  }, [onOpenNight, onOpenSong]);

  if (artistId && wall.artists.has(artistId)) {
    return <ArtistView {...p} wall={wall} facts={facts} artistId={artistId}
      order={artistOrder(filtered.length ? songs : wall.songs, filtered.length ? sort : "az", wall)}
      fallbackOrder={() => artistOrder(wall.songs, "az", wall)}
      onOpen={open} onOpenArtist={onOpenArtist} />;
  }

  return (
    <LibraryWall wall={wall} facts={facts} cov={cov} cat={cat} enrich={enrich} filters={filters} sort={sort} compact={compact}
      songs={songs} filtered={filtered} view={view} artistSort={artistSort}
      onOpen={open} onOpenSong={onOpenSong} onOpenArtist={onOpenArtist}
      set={{ setQ, setFamily, setDecade, setType, setPersonId, setSince, setUntil, setCoverOnly, setNoArtist, setSortPref, setCompact, setView, setArtistSort, clearFilters }} />
  );
}

interface Setters {
  setQ: (v: string) => void; setFamily: (v: string | null) => void; setDecade: (v: string | null) => void;
  setType: (v: string | null) => void; setPersonId: (v: string | null) => void;
  setSince: (v: number | null) => void; setUntil: (v: number | null) => void;
  setCoverOnly: (v: boolean) => void; setNoArtist: (v: boolean) => void;
  setSortPref: (v: SortKey) => void; setCompact: (v: boolean) => void;
  setView: (v: "songs" | "artists") => void; setArtistSort: (v: ArtistSort) => void; clearFilters: () => void;
}

function LibraryWall({ wall, facts, cov, cat, enrich, filters, sort, compact, songs: sorted, filtered: matching, view, artistSort, onOpen, onOpenSong, onOpenArtist, set }: {
  wall: Wall; facts: Map<string, Facts>; cov: ReturnType<typeof coverage>; cat: Catalog; enrich: EnrichMap | null;
  filters: Filters; sort: SortKey; compact: boolean; songs: WallSong[];
  /** The songs that pass the filters, A-Z: what the Artists view groups. */
  filtered: WallSong[]; view: "songs" | "artists"; artistSort: ArtistSort;
  onOpen: (s: WallSong) => void; onOpenSong: (id: string) => void; onOpenArtist: (id: string) => void; set: Setters;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(96);
  const [rolling, setRolling] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  // The List's columns: shared song facts, a Columns menu, and click-to-sort headers.
  const infoOf = useMemo(() => makeWallInfo(cat, enrich), [cat, enrich]);
  const allCols = useMemo(() => listColumns(infoOf), [infoOf]);
  const [choice, toggleCol, resetCols] = useColumnChoice("music-list");
  const [colSort, setColSort] = useSessionState<ColSort | null>("music.list.colsort", null);
  const width = useViewportWidth();
  const cols = useMemo(() => visibleColumns(allCols, choice, width), [allCols, choice, width]);
  // A header sort only exists in the List, and only while its column is showing.
  const sortCol = compact && colSort ? cols.find((c) => c.id === colSort.id && c.sortKey) : undefined;
  const songs = useMemo(
    () => (sortCol && colSort ? sortRows(sorted, sortCol.sortKey!, colSort.dir) : sorted),
    [sorted, sortCol, colSort]);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarH(el.offsetHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => timers.current.forEach((t) => { clearTimeout(t); clearInterval(t); }), []);

  // The Artists view: the filtered songs grouped by artist. Filters narrow songs, never artists.
  const artists = view === "artists";
  const knownArtist = useCallback((id: string) => wall.artists.has(id), [wall]);
  const nameOfArtist = useCallback((id: string) => wall.artists.get(id)?.name, [wall]);
  const everyArtist = useMemo(
    () => (artists ? buildArtistRows(wall.songs, infoOf, knownArtist, nameOfArtist).length : 0),
    [artists, wall, infoOf, knownArtist, nameOfArtist]);
  const artistBase = useMemo(
    () => (artists ? buildArtistRows(matching, infoOf, knownArtist, nameOfArtist) : []),
    [artists, matching, infoOf, knownArtist, nameOfArtist]);
  const artistRows = useMemo(() => sortArtists(artistBase, artistSort), [artistBase, artistSort]);

  const key = JSON.stringify([filters, sort, compact, sortCol?.id, colSort?.dir, view, artistSort]);
  useOnChange(key, () => {
    const root = scrollRootOf(topRef.current);
    memory.scroll = 0;
    artistsMemory.scroll = 0;
    root?.scrollTo({ top: 0, behavior: "instant" });
  });

  const families = useMemo(() => facetCounts(wall.songs, filters, facts, "family"), [wall, filters, facts]);
  const decades = useMemo(() => facetCounts(wall.songs, filters, facts, "decade"), [wall, filters, facts]);
  const types = useMemo(() => facetCounts(wall.songs, filters, facts, "type"), [wall, filters, facts]);
  const peopleIn = useMemo(() => {
    const seen = new Set(wall.songs.flatMap((s) => s.people));
    return cat.people.filter((x) => seen.has(x.id));
  }, [wall, cat]);
  const noArtistCount = useMemo(() => wall.songs.filter((s) => !s.artist).length, [wall]);
  const yearsList = useMemo(() => {
    const out: number[] = [];
    if (wall.minYear !== null && wall.maxYear !== null) for (let y = wall.minYear; y <= wall.maxYear; y++) out.push(y);
    return out;
  }, [wall]);

  const filtered = isFiltered(filters);
  const pool = songs.filter((s) => !s.loose);

  const surprise = () => {
    if (!pool.length || rolling !== null) return;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (reducedMotion()) { onOpenSong(pick.songId); return; }
    let n = 0;
    setRolling(pool[Math.floor(Math.random() * pool.length)].title);
    const iv = window.setInterval(() => {
      if (++n < 9) { setRolling(pool[Math.floor(Math.random() * pool.length)].title); return; }
      clearInterval(iv);
      setRolling(pick.title);
      timers.current.push(window.setTimeout(() => { setRolling(null); onOpenSong(pick.songId); }, 380));
    }, 70);
    timers.current.push(iv);
  };

  const known = facts.size;
  const range = wall.minYear !== null ? `${wall.minYear}–${wall.maxYear}` : "";
  const nights = useMemo(() => new Set(wall.songs.flatMap((s) => s.nightIds)).size, [wall]);

  return (
    <div className="page wide mu" ref={topRef}>
      <h1>Music</h1>
      <p className="sub">
        {plural(wall.songs.length, "song")} brought across {plural(nights, "night")}{range && <>, {range}</>}.
        {" "}Each song appears once, however many people or nights.
        {noArtistCount > 0 && <> {plural(noArtistCount, "song")} had no artist and sit under “{NO_ARTIST}”.</>}
      </p>

      <div className="mu-bar" ref={barRef}>
        <div className="mu-bar1">
          <div className="searchwrap mu-search">
            <span className="searchicon" aria-hidden="true"><SearchIcon size={17} /></span>
            <input className="searchbox" type="text" value={filters.q} spellCheck={false} autoComplete="off"
              aria-label="Filter songs by title or artist" placeholder="Filter by title or artist…"
              onChange={(e) => set.setQ(e.target.value)} />
            {filters.q && (
              <button className="searchclear" type="button" aria-label="Clear the text filter" onClick={() => set.setQ("")}>
                <CloseIcon size={14} />
              </button>
            )}
          </div>
          <div className="segtoggle" role="group" aria-label="View">
            <button type="button" aria-pressed={!artists} onClick={() => set.setView("songs")}>Songs</button>
            <button type="button" aria-pressed={artists} onClick={() => set.setView("artists")}>Artists</button>
          </div>
          <label className="mu-sel">Sort
            {artists ? (
              <select aria-label="Sort artists by" value={artistSort} onChange={(e) => set.setArtistSort(e.target.value as ArtistSort)}>
                {ARTIST_SORTS.map((s) => <option key={s} value={s}>{ARTIST_SORT_LABEL[s]}</option>)}
              </select>
            ) : (
              <select aria-label="Sort by" value={sort} onChange={(e) => { set.setSortPref(e.target.value as SortKey); setColSort(null); }}>
                {SORTS.map((s) => <option key={s} value={s} disabled={s === "year" && !cov.year}>{SORT_LABEL[s]}</option>)}
              </select>
            )}
          </label>
          {!artists && (
            <div className="segtoggle" role="group" aria-label="Density">
              <button type="button" aria-pressed={!compact} onClick={() => set.setCompact(false)}>Tiles</button>
              <button type="button" aria-pressed={compact} onClick={() => set.setCompact(true)}>List</button>
            </div>
          )}
          {!artists && compact && <ColumnsMenu columns={allCols} choice={choice} onToggle={toggleCol} onReset={resetCols} />}
          <div className="mu-surprise">
            <button type="button" className={`fchip mu-dice${rolling !== null ? " rolling" : ""}`}
              disabled={!pool.length} onClick={surprise}>
              <span aria-hidden="true">✦</span> Surprise me
            </button>
            {rolling !== null && <span className="mu-roll" aria-hidden="true">{rolling}</span>}
          </div>
          <span className="rcount mu-count" aria-live="polite">
            {artists
              ? <>{artistRows.length === everyArtist ? plural(everyArtist, "artist") : <>{fmtCount(artistRows.length)} of {fmtCount(everyArtist)} artists</>}
                {" · "}{songs.length === wall.songs.length ? plural(songs.length, "song") : `${fmtCount(songs.length)} of ${fmtCount(wall.songs.length)} songs`}</>
              : filtered || songs.length !== wall.songs.length
                ? <>{fmtCount(songs.length)} of {fmtCount(wall.songs.length)} songs</>
                : <>{plural(songs.length, "song")}</>}
          </span>
        </div>
        <div className="mu-bar2">
          <label className="mu-sel">Brought by
            <select value={filters.personId ?? ""} onChange={(e) => set.setPersonId(e.target.value || null)}>
              <option value="">anyone</option>
              {peopleIn.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="mu-sel">Since
            <select value={filters.since ?? ""} onChange={(e) => set.setSince(e.target.value ? +e.target.value : null)}>
              <option value="">any year</option>
              {yearsList.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <label className="mu-sel">Until
            <select value={filters.until ?? ""} onChange={(e) => set.setUntil(e.target.value ? +e.target.value : null)}>
              <option value="">any year</option>
              {yearsList.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          {filtered && <button type="button" className="tl-clear nomargin" onClick={set.clearFilters}>clear filters</button>}
        </div>
      </div>

      <div className="mu-facets">
        {types.length > 0 && (
          <div className="mu-chiprow" role="group" aria-label="Kind of night">
            <span className="mu-chiplabel">Night</span>
            {types.map(([t, n]) => (
              <button key={t} type="button" className="fchip" aria-pressed={filters.type === t}
                onClick={() => set.setType(filters.type === t ? null : t)}>{t} <i>{fmtCount(n)}</i></button>
            ))}
            {noArtistCount > 0 && (
              <button type="button" className="fchip" aria-pressed={filters.noArtist}
                onClick={() => set.setNoArtist(!filters.noArtist)}>{NO_ARTIST} <i>{fmtCount(noArtistCount)}</i></button>
            )}
          </div>
        )}
        {cov.family > 0 && (
          <div className="mu-chiprow" role="group" aria-label="Genre family">
            <span className="mu-chiplabel">Genre</span>
            {families.map(([f, n]) => (
              <button key={f} type="button" className="fchip" aria-pressed={filters.family === f}
                onClick={() => set.setFamily(filters.family === f ? null : f)}>{f} <i>{fmtCount(n)}</i></button>
            ))}
          </div>
        )}
        {cov.year > 0 && (
          <div className="mu-chiprow" role="group" aria-label="Decade of release">
            <span className="mu-chiplabel">Released</span>
            {decades.map(([d, n]) => (
              <button key={d} type="button" className="fchip" aria-pressed={filters.decade === d}
                onClick={() => set.setDecade(filters.decade === d ? null : d)}>{d} <i>{fmtCount(n)}</i></button>
            ))}
          </div>
        )}
        {known > 0 && (
          <p className="mu-note">
            Cover, year and genre known for {fmtCount(known)} of {fmtCount(wall.songs.length)} songs
            (cover {fmtCount(cov.cover)}, year {fmtCount(cov.year)}, genre {fmtCount(cov.family)}); the rest are drawn.
            {sort === "year" && " Songs without a known release year come last."}
            {cov.cover > 0 && (
              <label className="mu-check">
                <input type="checkbox" checked={filters.coverOnly} onChange={(e) => set.setCoverOnly(e.target.checked)} />
                with cover art
              </label>
            )}
          </p>
        )}
      </div>

      {songs.length === 0 ? (
        <div className="empty">
          <div className="big" aria-hidden="true">◌</div>
          <div>No songs match those filters.</div>
          <div className="emptyacts"><button type="button" className="dr-btn ghost" onClick={set.clearFilters}>Clear filters</button></div>
        </div>
      ) : artists ? (
        <ArtistsWall rows={artistRows} grouped={artistSort === "az"} facts={facts} infoOf={infoOf}
          y0={wall.minYear ?? 0} y1={wall.maxYear ?? 0} barH={barH} onOpen={onOpen} onOpenArtist={onOpenArtist} />
      ) : (
        <WallView songs={songs} grouped={sort === "az" && !sortCol} compact={compact} facts={facts}
          infoOf={infoOf} cols={cols} colSort={sortCol ? colSort : null} onSort={(c) => setColSort(nextSort(colSort, c.id))}
          y0={wall.minYear ?? 0} y1={wall.maxYear ?? 0} barH={barH} onOpen={onOpen} />
      )}
    </div>
  );
}

// --------------------------------------------------------------- an artist

const ORDERS: Array<[DiscoOrder, string]> = [["first", "First brought"], ["nights", "Most nights"], ["az", "A to Z"]];

/** Page-only columns of the discography, beside the shared song ones. */
const STRIP_COL: Column<WallSong> = {
  id: "strip", label: "Timeline", width: "minmax(100px,1.6fr)", align: "left", sortKey: null, text: () => null, hideBelow: 900,
};
const WHO_COL: Column<WallSong> = {
  id: "who", label: "Brought by", width: "130px", align: "left", sortKey: null, text: () => null, hideBelow: 900,
};
const artistColumns = (get: (s: WallSong) => SongInfo): Column<WallSong>[] => arrangeColumns(songColumns<WallSong>(get), {
  drop: ["artist"],
  patch: {
    title: { width: "minmax(150px,1.6fr)" },
    nights: { width: "150px", align: "left" },
  },
  extra: [{ col: STRIP_COL, before: "nights" }, { col: WHO_COL, before: "links" }],
});

function ArtistView({ cat, enrich, wall, facts, artistId, order, fallbackOrder, onOpen, onOpenArtist, onOpenNight, onOpenPerson, onTrace }: MusicPageProps & {
  wall: Wall; facts: Map<string, Facts>; artistId: string; order: string[];
  fallbackOrder: () => string[]; onOpen: (s: WallSong) => void;
}) {
  const agg = wall.artists.get(artistId)!;
  const [disco, setDisco] = useSessionState<DiscoOrder>("music.disco", "first");
  const [colSort, setColSort] = useSessionState<ColSort | null>("music.artist.colsort", null);
  const [choice, toggleCol, resetCols] = useColumnChoice("music-artist");
  const width = useViewportWidth();
  const infoOf = useMemo(() => makeWallInfo(cat, enrich), [cat, enrich]);
  const allCols = useMemo(() => artistColumns(infoOf), [infoOf]);
  const cols = useMemo(() => visibleColumns(allCols, choice, width), [allCols, choice, width]);
  const [year, setYear] = useState<string | null>(null);
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRootOf(topRef.current)?.scrollTo({ top: 0, behavior: "instant" });
    setYear(null);
  }, [artistId]);

  const h = useMemo(() => artistHistory(cat, artistId), [cat, artistId]);
  const sortCol = colSort ? cols.find((c) => c.id === colSort.id && c.sortKey) : undefined;
  const list = useMemo(() => {
    // The First brought / Most nights / A to Z choice is the default order; a header sort sits on top of it.
    const base = discography(wall, artistId, disco);
    return sortCol && colSort ? sortRows(base, sortCol.sortKey!, colSort.dir) : base;
  }, [wall, artistId, disco, sortCol, colSort]);
  // Albums: By album when there is something to group (see defaultGrouping), else Flat; a choice sticks.
  const [groupChoice, setGroupChoice] = useSessionState<"album" | "flat" | null>("music.disco.group", null);
  const grouped = useMemo(() => groupByAlbum(list, infoOf), [list, infoOf]);
  const byAlbum = grouped.albums.length > 0 && (groupChoice ?? defaultGrouping(grouped)) === "album";
  const y0 = +agg.first.slice(0, 4), y1 = +agg.last.slice(0, 4);
  const peopleList = useMemo(
    () => agg.people.map((id) => ({ id, i: cat.people.findIndex((x) => x.id === id), name: cat.people.find((x) => x.id === id)?.name ?? id })),
    [agg, cat]);

  const covers = useMemo(() => {
    const out: Array<{ s: WallSong; url: string }> = [];
    for (const s of wall.byArtist.get(artistId) ?? []) {
      const url = facts.get(s.songId)?.cover;
      if (url) out.push({ s, url });
      if (out.length === 4) break;
    }
    return out;
  }, [wall, artistId, facts]);

  const ids = order.includes(artistId) ? order : fallbackOrder();
  const at = ids.indexOf(artistId);
  const prev = at > 0 ? wall.artists.get(ids[at - 1]) : undefined;
  const next = at >= 0 && at < ids.length - 1 ? wall.artists.get(ids[at + 1]) : undefined;

  const yearBars = h.years;
  const maxNights = Math.max(1, ...yearBars.map((y) => y.nights));
  const yearNights = year ? h.nightList.filter((n) => n.date.startsWith(year)) : [];
  const ticks: number[] = [];
  for (let y = y0; y <= y1; y++) ticks.push(y);

  return (
    <div className="page wide mu mu-artist" ref={topRef}>
      <div className="mu-nav">
        <button type="button" className="linkbtn" onClick={() => onOpenArtist(null)}>← Library</button>
        <span className="spacer" />
        <button type="button" className="fchip" disabled={!prev} onClick={() => prev && onOpenArtist(prev.id)}
          title={prev?.name}>‹ {prev ? prev.name : "previous"}</button>
        <button type="button" className="fchip" disabled={!next} onClick={() => next && onOpenArtist(next.id)}
          title={next?.name}>{next ? next.name : "next"} ›</button>
      </div>

      <header className="mu-hero">
        {covers.length > 0 ? (
          <div className="mu-mosaic" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => {
              const c = covers[i];
              return (
                <span key={i} className="mu-mcell">
                  <Cover id={c ? c.s.songId : `${artistId}#${i}`} title={c ? c.s.title : agg.name} url={c ? c.url : null} />
                </span>
              );
            })}
          </div>
        ) : (
          <div className="mu-banner" aria-hidden="true"><Cover id={artistId} title={agg.name} url={null} /></div>
        )}
        <div className="mu-heroText">
          <h1>{agg.name}</h1>
          <p className="mu-verdict">{verdictSentence(h)}</p>
          <p className="mu-facts">
            {plural(agg.songs, "song")} · {plural(agg.nights, "night")} · {fmtDate(agg.first)} to {fmtDate(agg.last)}
          </p>
          <div className="mu-who" aria-label="Brought by">
            {peopleList.map((x) => (
              <button key={x.id} type="button" className="pchip jump" style={style({ "--pc": personColour(x.i) })}
                onClick={() => onOpenPerson(x.id)}>{x.name}</button>
            ))}
          </div>
          <div className="mu-acts">
            <button type="button" className="dr-btn ghost"
              onClick={() => onTrace({ kind: "artist", id: artistId, label: agg.name, nights: new Set(h.nightList.map((n) => n.eventId)) })}>
              Show on the timeline
            </button>
          </div>
        </div>
      </header>

      <section aria-labelledby="mu-years">
        <h2 id="mu-years">When this artist was brought</h2>
        <div className="mu-years" role="group" aria-label="Nights per year">
          {yearBars.map((y) => (
            <button key={y.year} type="button" className="mu-ybar" disabled={!y.nights}
              aria-pressed={year === y.year} aria-label={`${y.year}: ${plural(y.nights, "night")}`}
              title={`${y.year}: ${plural(y.nights, "night")}`} onClick={() => setYear(year === y.year ? null : y.year)}>
              <span className="mu-yfill" style={{ height: y.nights ? `${Math.max(8, (y.nights / maxNights) * 100)}%` : "2px" }}>
                {y.nights > 0 && <b>{y.nights}</b>}
              </span>
              <span className="mu-ylabel">{y.year}</span>
            </button>
          ))}
        </div>
        {year && (
          <div className="mu-nightchips" aria-label={`Nights in ${year}`}>
            {yearNights.map((n) => (
              <button key={n.eventId} type="button" className="fchip" onClick={() => onOpenNight(n.eventId)}>{fmtDate(n.date)}</button>
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="mu-disco">
        <div className="mu-dhead">
          <h2 id="mu-disco">Discography <span className="mu-dn">{plural(list.length, "song")}</span></h2>
          <div className="mu-dtools">
            <ColumnsMenu columns={allCols} choice={choice} onToggle={toggleCol} onReset={resetCols} />
            {grouped.albums.length > 0 && (
              <div className="segtoggle" role="group" aria-label="Group songs">
                <button type="button" aria-pressed={byAlbum} onClick={() => setGroupChoice("album")}>By album</button>
                <button type="button" aria-pressed={!byAlbum} onClick={() => setGroupChoice("flat")}>Flat list</button>
              </div>
            )}
            <div className="segtoggle" role="group" aria-label="Order">
              {ORDERS.map(([k, l]) => (
                <button key={k} type="button" aria-pressed={disco === k} onClick={() => { setDisco(k); setColSort(null); }}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="sc-head mu-ahead" role="row" style={style({ "--cols": gridTemplate(cols), "--sc-top": "0px" })}>
          <HeadCells cols={cols} colSort={sortCol ? colSort : null} onSort={(c) => setColSort(nextSort(colSort, c.id))}
            special={{
              strip: (
                <span className="mu-axisbar" aria-hidden="true">
                  {ticks.filter((_, i) => ticks.length <= 12 || i % 2 === 0).map((y) => (
                    <i key={y} style={{ left: `${stripPos(`${y}-01-01`, y0, y1) * 100}%` }}>{y}</i>
                  ))}
                </span>
              ),
            }} />
        </div>
        {(() => {
          const rowOf = (s: WallSong) => {
            const info = infoOf(s);
            const cell = (c: Column<WallSong>): ReactNode => {
              switch (c.id) {
                case "cover":
                  return <span key={c.id} className="sc-c sc-cover"><span className="mu-thumb"><Cover id={s.songId} title={s.title} url={facts.get(s.songId)?.cover ?? null} /></span></span>;
                case "title":
                  return (
                    <span key={c.id} className="sc-c sc-title mu-dmain">
                      <button type="button" className="mu-dopen" onClick={() => onOpen(s)}
                        aria-label={`${s.title}, ${quietLine(s)}${s.loose ? ", no song page: opens its first night" : ""}`}>{s.title}</button>
                      {s.variants.map((v) => <span key={v} className="chip variant">{v}</span>)}
                      {isStaple(s) && <em className="mu-staple">staple</em>}
                    </span>
                  );
                case "strip":
                  return (
                    <span key={c.id} className="mu-strip" aria-hidden="true">
                      {s.dates.map((d, i) => (
                        <i key={s.nightIds[i]} title={fmtDate(d)} style={{ left: `${stripPos(d, y0, y1) * 100}%` }} />
                      ))}
                    </span>
                  );
                case "nights":
                  return (
                    <span key={c.id} className="mu-dwhen">
                      <span>{plural(s.nights, "night")}</span>
                      <span className="mu-dq">{s.nights > 1 ? `${fmtDate(s.firstDate)} to ${fmtDate(s.lastDate)}` : fmtDate(s.firstDate)}</span>
                    </span>
                  );
                case "who":
                  return (
                    <span key={c.id} className="mu-dwho">
                      {s.people.slice(0, 7).map((id) => {
                        const i = cat.people.findIndex((x) => x.id === id);
                        const name = cat.people[i]?.name ?? id;
                        return (
                          <button key={id} type="button" className="mu-pdot" style={style({ "--pc": personColour(i) })}
                            aria-label={`Brought by ${name}`} title={name} onClick={() => onOpenPerson(id)}>
                            <span className="mu-pname">{name}</span>
                          </button>
                        );
                      })}
                      {s.people.length > 7 && <span className="mu-more">+{s.people.length - 7}</span>}
                    </span>
                  );
                case "links":
                  return <span key={c.id} className="sc-c sc-links r">{linkable(info) && <SongLinks song={info} />}</span>;
                default:
                  return <span key={c.id} className={`sc-c sc-${c.id}${c.align === "right" ? " r" : ""}`}><CellText value={c.text(s)} title={c.title?.(s)} /></span>;
              }
            };
            return <li key={s.songId} className="mu-drow">{cols.map(cell)}</li>;
          };
          const listOf = (songs: WallSong[]) => (
            <ul className="mu-disco" style={style({ "--cols": gridTemplate(cols) })}>{songs.map(rowOf)}</ul>
          );
          if (!byAlbum) return listOf(list);
          return (
            <>
              {grouped.albums.map((a) => {
                const url = a.songs.map((s) => facts.get(s.songId)?.cover).find(Boolean) ?? null;
                const len = fmtDuration(a.seconds);
                return (
                  <div key={a.key} className="ma-group">
                    <div className="ma-ghead">
                      <AlbumCover songId={`${artistId}|${a.key}`} title={a.name} url={url} size={40} />
                      <h3 className="ma-gname">{a.name}</h3>
                      <span className="ma-gmeta" title={len && a.withLength < a.songs.length ? "Length of the songs where it is known" : undefined}>
                        {[a.year ? String(a.year) : null, plural(a.songs.length, "song"), len ? (a.withLength < a.songs.length ? `${len}+` : len) : null]
                          .filter(Boolean).join(" · ")}
                      </span>
                    </div>
                    {listOf(a.songs)}
                  </div>
                );
              })}
              {grouped.noAlbum.length > 0 && (
                <div className="ma-group none">
                  <div className="ma-ghead">
                    <h3 className="ma-gname">{NO_ALBUM}</h3>
                    <span className="ma-gmeta">{plural(grouped.noAlbum.length, "song")}</span>
                  </div>
                  {listOf(grouped.noAlbum)}
                </div>
              )}
            </>
          );
        })()}
      </section>
    </div>
  );
}
