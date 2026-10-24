/** The Music page's Artists view: every artist, expandable inline into albums and
 *  their songs. Virtualised: every row has a fixed height by kind (see HEIGHT in
 *  artistalbums.ts), so the offsets are exact sums and an open artist simply inserts
 *  its rows. The grouping lives in artistalbums.ts; this is only drawing. */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Cover from "./Cover.tsx";
import SongLinks from "./SongLinks.tsx";
import {
  albumCoverage, artistLine, flatten, HEIGHT, NO_ALBUM, type AlbumGroup, type ArtistRow, type Item,
} from "./artistalbums.ts";
import { LETTERS, type Facts, type WallSong } from "./musicstats.ts";
import type { SongInfo } from "./songcols.ts";
import { fmtDuration } from "./songcols.ts";
import { linkable } from "./songrows.ts";
import { fmtCount, plural } from "./format.ts";
import { scrollRootOf } from "./pagehelpers.ts";
import "./musicartists.css";

/** Where the Artists view was scrolled to, for coming back from an artist page. */
export const artistsMemory = { scroll: 0 };

const OVER = 320;
const style = (vars: Record<string, string | number>) => vars as unknown as CSSProperties;
const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

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

const heightOf = (it: Item) => HEIGHT[it.kind];

// ------------------------------------------------------------------ rows

/** Up to four distinct covers of the artist's songs; the rest of the 2x2 is drawn art. */
function mosaicOf(row: ArtistRow, facts: Map<string, Facts>) {
  const seen = new Set<string>();
  const out: Array<{ id: string; title: string; url: string | null }> = [];
  for (const s of row.songs) {
    const url = facts.get(s.songId)?.cover;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ id: s.songId, title: s.title, url });
    if (out.length === 4) break;
  }
  for (let i = out.length; i < 4; i++) out.push({ id: `${row.key}#${i}`, title: row.name, url: null });
  return out;
}

const ArtistLine = memo(function ArtistLine({ row, open, facts, y0, y1, onToggle, onOpenArtist }: {
  row: ArtistRow; open: boolean; facts: Map<string, Facts>; y0: number; y1: number;
  onToggle: (key: string) => void; onOpenArtist: (id: string) => void;
}) {
  const mos = useMemo(() => mosaicOf(row, facts), [row, facts]);
  const have = new Set(row.years);
  const dots: number[] = [];
  for (let y = y0; y <= y1; y++) dots.push(y);
  const line = artistLine(row, plural);
  return (
    <div className={`ma-artist${open ? " open" : ""}`}>
      <button type="button" className="ma-chev" aria-expanded={open}
        aria-label={`${open ? "Hide" : "Show"} the albums and songs of ${row.name}`} onClick={() => onToggle(row.key)}>
        <span aria-hidden="true">▸</span>
      </button>
      <span className="ma-mos" aria-hidden="true">
        {mos.map((c, i) => <Cover key={i} songId={c.id} title={c.title} url={c.url} size={31} className="ma-cv" />)}
      </span>
      <span className="ma-main">
        {row.id
          ? <button type="button" className="ma-name" title={`Open ${row.name}`} onClick={() => onOpenArtist(row.id!)}>{row.name}</button>
          : <span className={`ma-name plain${row.unknown ? " none" : ""}`}>{row.name}</span>}
        <span className="ma-line" title={line}>{line}</span>
      </span>
      <span className="mu-jdots small ma-dots" aria-hidden="true">
        {dots.map((y) => <i key={y} className={have.has(y) ? "lit" : ""} title={String(y)} />)}
      </span>
    </div>
  );
});

const spanOfSecs = (a: AlbumGroup<WallSong>) => {
  const t = fmtDuration(a.seconds);
  return t ? (a.withLength < a.songs.length ? `${t}+` : t) : null;
};

const AlbumLine = memo(function AlbumLine({ row, album, count, facts }: {
  row: ArtistRow; album: AlbumGroup<WallSong> | null; count: number; facts: Map<string, Facts>;
}) {
  const songs = album ? album.songs : row.groups.noAlbum;
  const url = songs.map((s) => facts.get(s.songId)?.cover).find(Boolean) ?? null;
  const bits = album
    ? [album.year ? String(album.year) : null, plural(count, "song"), spanOfSecs(album)].filter(Boolean).join(" · ")
    : plural(count, "song");
  return (
    <div className={`ma-album${album ? "" : " none"}`}>
      <Cover songId={`${row.key}|${album?.key ?? "-"}`} title={album?.name ?? row.name} url={url} size={34} className="ma-acv" />
      <span className="ma-aname" title={album?.name ?? NO_ALBUM}>{album?.name ?? NO_ALBUM}</span>
      <span className="ma-ameta">{bits}</span>
    </div>
  );
});

const SongLine = memo(function SongLine({ song, info, onOpen }: {
  song: WallSong; info: SongInfo; onOpen: (s: WallSong) => void;
}) {
  const len = fmtDuration(info.durationSec);
  return (
    <div className="ma-song">
      <button type="button" className="ma-stitle" onClick={() => onOpen(song)}
        aria-label={`${song.title}${song.loose ? ", no song page: opens its first night" : ""}`}>{song.title}</button>
      <span className="ma-sc r">{len ?? <i className="sc-unknown" aria-label="unknown" role="img">—</i>}</span>
      <span className="ma-sc r ma-rel" title={info.releaseDate ? `Released ${info.releaseDate}` : undefined}>
        {info.year ?? <i className="sc-unknown" aria-label="unknown" role="img">—</i>}
      </span>
      <span className="ma-sc r">{plural(song.nights, "night")}</span>
      <span className="ma-sc r ma-slinks">{linkable(info) && <SongLinks song={info} />}</span>
    </div>
  );
});

// ------------------------------------------------------------------ view

export default function ArtistsWall({ rows, grouped, facts, infoOf, y0, y1, barH, onOpen, onOpenArtist }: {
  rows: ArtistRow[]; grouped: boolean; facts: Map<string, Facts>; infoOf: (s: WallSong) => SongInfo;
  y0: number; y1: number; barH: number; onOpen: (s: WallSong) => void; onOpenArtist: (id: string) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ a: 0, b: 30 });
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [ready, setReady] = useState(false);
  const restored = useRef(false);

  const toggle = useCallback((key: string) => setOpen((p) => {
    const n = new Set(p);
    if (!n.delete(key)) n.add(key);
    return n;
  }), []);

  // Artists that no longer exist (a filter changed) cannot stay open.
  const shownKeys = useMemo(() => new Set(rows.map((r) => r.key)), [rows]);
  const openNow = useMemo(() => new Set([...open].filter((k) => shownKeys.has(k))), [open, shownKeys]);

  const items = useMemo(() => flatten(rows, openNow, grouped), [rows, openNow, grouped]);
  const layout = useMemo(() => {
    const offs: number[] = [], hs: number[] = [];
    const heads: Array<{ row: number; letter: string }> = [];
    let y = 0;
    items.forEach((it, i) => {
      const h = heightOf(it);
      offs.push(y); hs.push(h); y += h;
      if (it.kind === "head") heads.push({ row: i, letter: it.letter });
    });
    return { offs, hs, heads, total: y };
  }, [items]);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const barRef = useRef(barH); barRef.current = barH;

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
      let cur = L.heads[0].letter;
      for (const h of L.heads) { if (L.offs[h.row] <= line) cur = h.letter; else break; }
      setActive((p) => (p === cur ? p : cur));
    }
  }, [wallTop]);

  useLayoutEffect(() => { setReady(true); update(); }, [layout, update]);

  useEffect(() => {
    const root = scrollRootOf(hostRef.current);
    if (!root) return;
    let raf = 0;
    const onScroll = () => {
      artistsMemory.scroll = root.scrollTop;
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); });
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [update]);

  useLayoutEffect(() => {
    if (restored.current || !layout.total) return;
    restored.current = true;
    const root = scrollRootOf(hostRef.current);
    if (root && artistsMemory.scroll > 0) { root.scrollTop = artistsMemory.scroll; update(); }
  }, [layout.total, update]);

  const jump = (letter: string) => {
    const h = layout.heads.find((x) => x.letter === letter);
    const wt = wallTop();
    if (!h || !wt) return;
    setActive(letter);
    wt.root.scrollTo({ top: wt.top + layout.offs[h.row] - barH - 6, behavior: reducedMotion() ? "instant" : "smooth" });
  };

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.bucket, (m.get(r.bucket) ?? 0) + 1);
    return m;
  }, [rows]);
  const cov = useMemo(() => albumCoverage(rows), [rows]);
  const mounted = range.b >= range.a ? items.slice(range.a, range.b + 1) : [];

  return (
    <div className="mu-body">
      <div className="mu-main">
        <p className="mu-note ma-note">
          <span>
            Album known for {fmtCount(cov.withAlbum)} of {fmtCount(cov.songs)} songs; the rest sit under no album.
            {" "}It fills in as more albums are looked up.
          </span>
          {openNow.size > 0 && (
            <button type="button" className="linkbtn" onClick={() => setOpen(new Set())}>Collapse all</button>
          )}
        </p>
        <div ref={hostRef} className="ma-wall" role="group" aria-label="Artists" style={{ height: layout.total }}>
          {ready && mounted.map((it, k) => {
            const i = range.a + k;
            const pos = { top: layout.offs[i], height: layout.hs[i] };
            switch (it.kind) {
              case "head":
                return (
                  <h2 key={`h${it.letter}`} className="mu-head ma-pos" style={pos}>
                    <span className="mu-hl">{it.label}</span>
                    <span className="mu-hc">{plural(it.count, "artist")}</span>
                  </h2>
                );
              case "artist":
                return (
                  <div key={`a${it.row.key}`} className="ma-pos ma-slot" style={pos}>
                    <ArtistLine row={it.row} open={it.open} facts={facts} y0={y0} y1={y1} onToggle={toggle} onOpenArtist={onOpenArtist} />
                  </div>
                );
              case "album":
                return (
                  <div key={`b${it.row.key}|${it.album?.key ?? "-"}`} className="ma-pos ma-child" style={pos}>
                    <AlbumLine row={it.row} album={it.album} count={it.count} facts={facts} />
                  </div>
                );
              default:
                return (
                  <div key={`s${it.row.key}|${it.song.songId}`} className="ma-pos ma-child" style={pos}>
                    <SongLine song={it.song} info={infoOf(it.song)} onOpen={onOpen} />
                  </div>
                );
            }
          })}
        </div>
      </div>

      {grouped && (
        <nav className="mu-rail" aria-label="Jump to a letter" style={style({ "--mu-bar": `${barH}px` })}>
          {LETTERS.map((l) => {
            const n = counts.get(l) ?? 0;
            return (
              <button key={l} type="button" disabled={!n} aria-current={active === l ? "true" : undefined}
                aria-label={l === "#" ? "Numbers and symbols" : l === "…" ? "Other scripts" : `Artists starting with ${l}`}
                title={n ? `${l}: ${plural(n, "artist")}` : undefined} onClick={() => jump(l)}>{l}</button>
            );
          })}
        </nav>
      )}
    </div>
  );
}
