/** The cosmic radio: a small pill at the bottom of every page that, on a click
 *  (or the `r` key), starts random songs from the library as 30-second previews,
 *  and expands into a slim bar. The whole thing is its own lazy chunk; nothing
 *  third-party is contacted until the visitor presses play (the preview lookup
 *  and audio come from Apple's public preview service, the full song from
 *  Spotify's own embed, loaded only on a click). We never host or fetch music.
 *
 *  Pool logic is src/radio.ts, matching is src/previews.ts; this file is the
 *  playback and the furniture. */
import { Component, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Catalog } from "./catalog.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { coverUrlOf, type EnrichMap } from "./enrich.ts";
import { familyColour } from "./families.ts";
import { fmtDur } from "./format.ts";
import { useSessionState } from "./hooks.ts";
import { findPreview, type Preview, type Wanted } from "./previews.ts";
import {
  PLAY_EVENT, artistOf, artistSongIds, cosmicPool, createShuffler, libraryPool, listPool, nightSongIds,
  type Candidate, type PlayDetail, type Shuffler,
} from "./radio.ts";
import { songFactsFor, spotifyHref, youtubeHref, type SongInfo } from "./songcols.ts";
import Cover from "./Cover.tsx";
import { SpotifyIcon, YouTubeIcon } from "./SongLinks.tsx";
import "./player.css";

export interface PlayerProps {
  cat: Catalog;
  enrich: EnrichMap | null;
  /** A play request that arrived before this chunk had loaded. */
  initial: PlayDetail | null;
  /** The pill stays out of the way on Home and during the unlock flood. */
  hideIdle: boolean;
  onOpenSong?: (songId: string) => void;
  onOpenArtist?: (artistId: string) => void;
}

type Kind = "cosmic" | "library" | "night" | "artist" | "list";
interface Sel { kind: Kind; eventId: string | null; artistId: string | null }
interface Cur { songId: string; info: SongInfo; pv: Preview | null; cover: string | null; phase: "loading" | "ready" | "none" }

const DEFAULT_SEL: Sel = { kind: "cosmic", eventId: null, artistId: null };
const MAX_SKIPS = 5;
const VOL_KEY = "mdc.radio.volume";

const wantedOf = (i: SongInfo): Wanted => ({ artist: i.artist, title: i.title, durationSec: i.durationSec });
const spotifyId = (uri: string | null) => /^spotify:track:([A-Za-z0-9]+)$/.exec(uri ?? "")?.[1] ?? null;

function readVolume(): number {
  try {
    const v = parseFloat(localStorage.getItem(VOL_KEY) ?? "");
    if (v >= 0 && v <= 1) return v;
  } catch { /* storage blocked */ }
  return 0.7;
}

// ------------------------------------------------------------------- icons

const Ic = ({ children }: { children: ReactNode }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">{children}</svg>
);
const PlayIc = () => <Ic><path d="M8 5.5v13l11-6.5z" /></Ic>;
const PauseIc = () => <Ic><path d="M7 5.5h3.4v13H7zM13.6 5.5H17v13h-3.4z" /></Ic>;
const NextIc = () => <Ic><path d="M6 6l9 6-9 6zM16.5 6H19v12h-2.5z" /></Ic>;
const CloseIc = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
const VolIc = () => <Ic><path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5zM14.5 9a4 4 0 0 1 0 6l-1.1-1.1a2.5 2.5 0 0 0 0-3.8zM16.7 6.8a7 7 0 0 1 0 10.4l-1.1-1.1a5.5 5.5 0 0 0 0-8.2z" /></Ic>;

// ---------------------------------------------------------- error boundary

/** A broken radio must never take a page with it: it just disappears. */
class Contain extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: Error) { console.error("radio crashed:", e); }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function PlayerRoot(props: PlayerProps) {
  return <Contain><Player {...props} /></Contain>;
}

// ------------------------------------------------------------------ player

function Player(props: PlayerProps) {
  const P = useRef(props);
  P.current = props;

  const [sel, setSel] = useSessionState<Sel>("radio.sel", DEFAULT_SEL);
  const [list, setListS] = useState<{ label: string; ids: string[] } | null>(null);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState<Cur | null>(null);
  const [playing, setPlaying] = useState(false);
  const [full, setFull] = useState<"embed" | "links" | null>(null);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(30);
  const [volume, setVolume] = useState(readVolume);
  const [menu, setMenu] = useState(false);
  const [poolSize, setPoolSize] = useState(0);
  const [empty, setEmpty] = useState(false);
  const [said, setSaid] = useState("");

  const audio = useRef<HTMLAudioElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const playBtn = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusPlay = useRef(false);

  // Everything the async playback logic needs to read the moment it runs.
  const S = useRef({
    sel, list: null as { label: string; ids: string[] } | null,
    shuffler: null as Shuffler | null, queued: null as Candidate | null,
    token: 0, errs: 0, open: false, full: null as "embed" | "links" | null,
    cur: null as Cur | null, infos: null as { cat: Catalog; enrich: EnrichMap | null; list: SongInfo[] } | null,
    pools: new Map<string, Candidate[]>(),
  });
  S.current.sel = sel; S.current.open = open; S.current.full = full; S.current.cur = cur;

  // ----------------------------------------------------------- the pools

  const allInfos = (): SongInfo[] => {
    const { cat, enrich } = P.current;
    const c = S.current.infos;
    if (c && c.cat === cat && c.enrich === enrich) return c.list;
    S.current.pools.clear();
    const list = cat.songs.map((s) => songFactsFor(cat, enrich, s.id));
    S.current.infos = { cat, enrich, list };
    return list;
  };
  const usable = (ids: string[]): string[] => {
    const { cat, enrich } = P.current;
    return ids.filter((id) => { const i = songFactsFor(cat, enrich, id); return !!i.artist && !!i.title; });
  };
  /** A selection that still makes sense for this catalogue (a night that is gone is just Cosmic). */
  const valid = (s: Sel): Sel => {
    const ix = catalogIndex(P.current.cat);
    if (s.kind === "night" && !(s.eventId && ix.event.has(s.eventId))) return DEFAULT_SEL;
    if (s.kind === "artist" && !(s.artistId && ix.artist.has(s.artistId))) return DEFAULT_SEL;
    if (s.kind === "list" && !S.current.list) return DEFAULT_SEL;
    return s;
  };
  const poolFor = (s: Sel): Candidate[] => {
    const memo = s.kind === "cosmic" || s.kind === "library" ? s.kind : null;
    if (memo) { const hit = S.current.pools.get(memo); if (hit) return hit; }
    let out: Candidate[];
    switch (s.kind) {
      case "cosmic": out = cosmicPool(allInfos()); break;
      case "library": out = libraryPool(allInfos()); break;
      case "night": out = listPool(usable(nightSongIds(P.current.cat, s.eventId!))); break;
      case "artist": out = listPool(usable(artistSongIds(P.current.cat, s.artistId!))); break;
      default: out = listPool(usable(S.current.list?.ids ?? []));
    }
    if (memo) S.current.pools.set(memo, out);
    return out;
  };

  /** Choose what to shuffle. Rebuilds the shuffle, so the next song comes from the new pool. */
  const choose = (next: Sel, withList?: { label: string; ids: string[] }) => {
    if (withList) { S.current.list = withList; setListS(withList); }
    const s = valid(next);
    const cands = poolFor(s);
    S.current.sel = s;
    S.current.shuffler = createShuffler(cands);
    S.current.queued = null;
    setSel(s);
    setPoolSize(cands.length);
    setEmpty(false);
  };
  const ensureShuffler = () => {
    if (!S.current.shuffler) choose(S.current.sel);
    return S.current.shuffler!;
  };
  const take = (): string | null => {
    const q = S.current.queued;
    if (q) { S.current.queued = null; return q.songId; }
    return ensureShuffler().next()?.songId ?? null;
  };
  const prefetch = () => {
    const sh = ensureShuffler();
    const n = S.current.queued ?? (S.current.queued = sh.next());
    if (n) void findPreview(wantedOf(songFactsFor(P.current.cat, P.current.enrich, n.songId)));
  };

  // ------------------------------------------------------------ playback

  const beginAudio = async (pv: Preview): Promise<boolean> => {
    const a = audio.current;
    if (!a) return false;
    a.volume = volume;
    a.src = pv.previewUrl;
    try { await a.play(); return true; }
    catch (e) {
      const name = (e as DOMException).name;
      return name === "NotAllowedError" || name === "AbortError";    // blocked: leave it paused, ready to press play
    }
  };

  /** Start `first` (a song the visitor asked for) or the next song from the shuffle,
   *  quietly skipping songs with no preview (a few times, then say so). */
  const startNext = async (first?: string) => {
    const s = S.current;
    const token = ++s.token;
    setOpen(true);
    focusPlay.current = !s.open;
    let id = first ?? take();
    if (!id) { setCur(null); setEmpty(true); return; }
    const max = first ? 1 : MAX_SKIPS;
    let tries = 0;
    while (id) {
      const { cat, enrich } = P.current;
      const info = songFactsFor(cat, enrich, id);
      const cover = coverUrlOf(enrich?.[id]);
      setCur({ songId: id, info, pv: null, cover, phase: "loading" });
      setFull(null); setPos(0);
      const pv = await findPreview(wantedOf(info));
      if (token !== s.token) return;
      if (pv && (await beginAudio(pv))) {
        if (token !== s.token) return;
        s.errs = 0;
        setCur({ songId: id, info, pv, cover: cover ?? pv.artworkUrl, phase: "ready" });
        prefetch();
        return;
      }
      if (++tries >= max) { setCur({ songId: id, info, pv: null, cover, phase: "none" }); audio.current?.pause(); return; }
      id = take();
    }
    setCur(null); setEmpty(true);
  };

  const stop = () => {
    S.current.token++;
    const a = audio.current;
    if (a) { a.pause(); a.removeAttribute("src"); a.load(); }
    setOpen(false); setCur(null); setFull(null); setPlaying(false); setMenu(false); setPos(0);
  };

  const toggle = () => {
    const a = audio.current;
    if (!a || S.current.cur?.phase !== "ready" || S.current.full === "embed") return;
    if (a.paused) void a.play().catch(() => {}); else a.pause();
  };

  const goFull = () => {
    const c = S.current.cur;
    if (!c || c.phase === "loading") return;
    if (spotifyId(c.info.spotifyUri)) { audio.current?.pause(); setFull("embed"); }
    else setFull("links");
  };
  const backToPreview = () => {
    setFull(null);
    void audio.current?.play().catch(() => {});
  };

  /** One handler for every way of asking for music. */
  const handle = (d: PlayDetail) => {
    const s = S.current.sel;
    switch (d.mode) {
      case "radio":
        // The pill and the `r` key: begin in the remembered pool; pressed again, move on.
        if (!S.current.shuffler || valid(s) !== s) choose(s);
        void startNext();
        break;
      case "song":
        if (d.songId) { if (!S.current.shuffler) choose(s); void startNext(d.songId); }
        break;
      case "night":
        if (d.eventId) { choose({ kind: "night", eventId: d.eventId, artistId: s.artistId }); void startNext(); }
        break;
      case "artist":
        if (d.artistId) { choose({ kind: "artist", eventId: s.eventId, artistId: d.artistId }); void startNext(); }
        break;
      case "library":
        if (d.songIds) choose({ ...s, kind: "list" }, { label: "These songs", ids: d.songIds });
        else choose({ ...s, kind: "library" });
        void startNext();
        break;
    }
  };
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const nextRef = useRef(startNext);
  nextRef.current = startNext;
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  const pickKind = (k: Kind) => {
    setMenu(false);
    const c = S.current.cur, was = S.current.sel;
    if (k === "artist") {
      const a = c ? artistOf(c.songId) : was.artistId;       // the artist of what is playing now
      if (a) choose({ ...was, kind: "artist", artistId: a });
    } else choose({ ...was, kind: k });                       // a night or artist chosen before is remembered
    void startNext();
  };

  // ------------------------------------------------------------ listeners

  // Requests from the buttons around the app, and one that arrived before we loaded.
  const consumed = useRef(false);
  useEffect(() => {
    const on = (e: Event) => handleRef.current((e as CustomEvent<PlayDetail>).detail);
    window.addEventListener(PLAY_EVENT, on);
    if (P.current.initial && !consumed.current) { consumed.current = true; handleRef.current(P.current.initial); }
    return () => window.removeEventListener(PLAY_EVENT, on);
  }, []);

  // Space toggles when nothing else wants it: focus on the page itself (the body), or on a
  // non-button part of the bar. A Timeline canvas, a button, an input keeps its own space.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " || e.repeat || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (!S.current.open) return;
      const el = document.activeElement;
      const inBar = !!el && !!bar.current?.contains(el) && !(el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || el instanceof HTMLSelectElement);
      if (el !== document.body && !inBar) return;
      e.preventDefault();
      toggleRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The audio element's own events.
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onPlaying = () => { S.current.errs = 0; setPlaying(true); };
    const onTime = () => setPos(a.currentTime);
    const onMeta = () => { if (Number.isFinite(a.duration) && a.duration > 0) setDur(a.duration); };
    const onEnded = () => { setPlaying(false); if (S.current.open && S.current.full !== "embed") void nextRef.current(); };
    const onError = () => {
      if (!a.getAttribute("src") || !S.current.open) return;
      // A preview that will not load: move on, but give up after a few in a row (offline).
      if (++S.current.errs >= 3) {
        const c = S.current.cur;
        if (c) setCur({ ...c, phase: "none" });
        return;
      }
      void nextRef.current();
    };
    a.addEventListener("play", onPlay); a.addEventListener("pause", onPause); a.addEventListener("playing", onPlaying);
    a.addEventListener("timeupdate", onTime); a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("ended", onEnded); a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("play", onPlay); a.removeEventListener("pause", onPause); a.removeEventListener("playing", onPlaying);
      a.removeEventListener("timeupdate", onTime); a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("ended", onEnded); a.removeEventListener("error", onError);
    };
  }, []);

  useEffect(() => { if (audio.current) audio.current.volume = volume; }, [volume]);
  const setVol = (v: number) => {
    setVolume(v);
    try { localStorage.setItem(VOL_KEY, String(v)); } catch { /* storage blocked: kept for this page only */ }
  };

  // Leaving (unmount): stop the sound and give the page its space back.
  useEffect(() => () => {
    const a = audio.current;
    if (a) { a.pause(); a.removeAttribute("src"); }
    document.documentElement.style.removeProperty("--player-h");
  }, []);

  // The bar must never cover content: tell the scroll area how tall it is.
  useEffect(() => {
    const root = document.documentElement.style;
    const el = bar.current;
    if (!open || !el) { root.removeProperty("--player-h"); return; }
    const set = () => root.setProperty("--player-h", `${Math.ceil(el.offsetHeight) + 34}px`);
    set();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(set) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.removeProperty("--player-h"); };
  }, [open]);

  // Opened by a click or key: put focus on play, so the keyboard is already in the bar.
  useEffect(() => { if (open && focusPlay.current) { focusPlay.current = false; playBtn.current?.focus({ preventScroll: true }); } }, [open, cur?.songId]);

  // The pool menu closes on an outside click or Esc (and only the menu: Esc never stops the music).
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setMenu(false); } };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("pointerdown", down, true); document.removeEventListener("keydown", key, true); };
  }, [menu]);

  // Lock screen / headphone keys.
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : undefined;
    if (!ms) return;
    if (!open || !cur || cur.phase !== "ready") { ms.metadata = null; return; }
    try {
      ms.metadata = new MediaMetadata({
        title: cur.info.title, artist: cur.info.artist ?? "", album: cur.info.album ?? "Cosmic radio",
        artwork: cur.cover ? [{ src: cur.cover }] : [],
      });
    } catch { /* an odd artwork value: the title still shows */ }
    const set = (a: MediaSessionAction, fn: MediaSessionActionHandler | null) => { try { ms.setActionHandler(a, fn); } catch { /* unsupported action */ } };
    set("play", () => toggleRef.current());
    set("pause", () => toggleRef.current());
    set("nexttrack", () => void nextRef.current());
    return () => { set("play", null); set("pause", null); set("nexttrack", null); };
  }, [open, cur]);
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.mediaSession) navigator.mediaSession.playbackState = open ? (playing ? "playing" : "paused") : "none";
  }, [open, playing]);

  // Announce a new song politely, and only once the skipping has settled.
  useEffect(() => {
    if (!cur || cur.phase !== "ready") return;
    const t = window.setTimeout(() => setSaid(`Now playing ${cur.info.title}${cur.info.artist ? ` by ${cur.info.artist}` : ""}`), 1200);
    return () => window.clearTimeout(t);
  }, [cur]);

  // ---------------------------------------------------------------- view

  // The audio element sits first and never moves, so opening the bar does not rebuild it (and drop its listeners).
  if (!open) {
    return (
      <>
        <audio ref={audio} preload="none" />
        {!props.hideIdle && (
          <button type="button" className="rd-pill" onClick={() => handle({ mode: "radio" })}
            title="Random songs from the library, 30 seconds each (r)" aria-label="Start cosmic radio (shortcut r)">
            <span className="rd-star" aria-hidden="true">✦</span> cosmic radio
          </button>
        )}
      </>
    );
  }

  const ix = catalogIndex(props.cat);
  const s = valid(sel);
  const night = s.eventId ? ix.event.get(s.eventId) : undefined;
  const artistName = s.artistId ? ix.artist.get(s.artistId)?.name : undefined;
  const poolLabel =
    s.kind === "cosmic" ? "Cosmic radio"
    : s.kind === "library" ? "Whole library"
    : s.kind === "night" ? `This night${night ? ` · ${night.date ?? night.title}` : ""}`
    : s.kind === "artist" ? `This artist${artistName ? ` · ${artistName}` : ""}`
    : list?.label ?? "Selection";
  const count = `${poolSize.toLocaleString("en-US")} ${poolSize === 1 ? "song" : "songs"}`;

  const info = cur?.info;
  const colour = info?.family ? familyColour(info.family) : "var(--accent)";
  const artistKnown = !!info?.songId && ix.artist.has(artistOf(info.songId));
  const sp = info ? spotifyHref(info) : null;
  const yt = info ? youtubeHref(info) : null;
  const ready = cur?.phase === "ready";
  const embedId = full === "embed" && info ? spotifyId(info.spotifyUri) : null;
  const pct = dur > 0 ? Math.min(100, (pos / dur) * 100) : 0;
  const label = embedId ? "full song (Spotify)" : "preview 30 s";

  const kinds: Array<{ k: Kind; name: string; hint: string; off?: boolean }> = [
    { k: "cosmic", name: "Cosmic", hint: "psychedelic, spacey, organic" },
    { k: "library", name: "Whole library", hint: "anything, evenly" },
    { k: "night", name: "This night", hint: night ? `${night.date ?? night.title}` : "open a night, then press its shuffle", off: !night },
    { k: "artist", name: "This artist", hint: info?.artist ?? artistName ?? "play a song first", off: !info?.artist && !artistName },
  ];

  return (
    <>
    <audio ref={audio} preload="none" />
    <div ref={bar} className={`rd-bar${full === "embed" ? " is-full" : ""}`} role="region" aria-label="Cosmic radio"
      style={{ "--fc": colour } as CSSProperties}>
      <span className="mdc-sr" aria-live="polite">{said}</span>

      {ready && !embedId && (
        <input type="range" className="rd-seek" min={0} max={dur} step={0.1} value={Math.min(pos, dur)}
          style={{ "--p": `${pct}%` } as CSSProperties}
          aria-label="Seek in the preview" aria-valuetext={`${fmtDur(pos) || "0:00"} of ${fmtDur(dur)}`}
          title={info?.familyLabel ?? undefined}
          onChange={(e) => { const a = audio.current; if (a) a.currentTime = +e.target.value; setPos(+e.target.value); }} />
      )}

      <div className="rd-cover">
        {info?.songId && <Cover songId={info.songId} title={info.title} url={cur?.cover ?? null} size={38} />}
      </div>

      <div className="rd-text">
        <div className="rd-line1">
          {info ? (
            <>
              {props.onOpenSong && info.songId
                ? <button type="button" className="rd-link rd-title" onClick={() => props.onOpenSong!(info.songId!)}>{info.title}</button>
                : <span className="rd-title">{info.title}</span>}
              {info.artist && <span className="rd-dot" aria-hidden="true"> · </span>}
              {info.artist && (props.onOpenArtist && artistKnown
                ? <button type="button" className="rd-link rd-artist" onClick={() => props.onOpenArtist!(artistOf(info.songId!))}>{info.artist}</button>
                : <span className="rd-artist">{info.artist}</span>)}
            </>
          ) : <span className="rd-title">{empty ? "Nothing to play in this pool" : "Tuning in…"}</span>}
        </div>

        <div className="rd-line2">
          <div className="rd-poolwrap" ref={menuRef}>
            <button type="button" className="rd-pool" aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((m) => !m)}
              title="Choose what the radio plays">
              {poolLabel} · {count} <span aria-hidden="true">▾</span>
            </button>
            {menu && (
              <div className="rd-menu" role="group" aria-label="What to play">
                {kinds.map((o) => (
                  <button key={o.k} type="button" className="rd-opt" disabled={o.off} aria-pressed={s.kind === o.k}
                    onClick={() => pickKind(o.k)}>
                    <b>{s.kind === o.k ? "✓ " : ""}{o.name}</b><span>{o.hint}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {cur?.phase === "loading" && <span className="rd-state">finding a preview…</span>}
          {ready && <span className="rd-state rd-label">{label}</span>}
          {cur?.phase === "none" && (
            <span className="rd-state rd-none">
              no preview found: try{" "}
              <a href={yt!.href} target="_blank" rel="noopener noreferrer">Search on YouTube</a>{" · "}
              <a href={sp!.href} target="_blank" rel="noopener noreferrer">{sp!.exact ? "Open in Spotify" : "Search on Spotify"}</a>
            </span>
          )}
          {empty && poolSize === 0 && <span className="rd-state">try Whole library</span>}
        </div>
        {full === "links" && sp && yt && (
          <div className="rd-fulllinks">
            No exact Spotify match for the whole song:{" "}
            <a href={sp.href} target="_blank" rel="noopener noreferrer"><SpotifyIcon size={14} /> Search on Spotify</a>{" "}
            <a href={yt.href} target="_blank" rel="noopener noreferrer"><YouTubeIcon size={14} /> Search on YouTube</a>
          </div>
        )}
      </div>

      {embedId ? (
        <div className="rd-embed">
          <iframe title="Spotify player" src={`https://open.spotify.com/embed/track/${embedId}?theme=0`}
            width="100%" height="80" allow="encrypted-media" loading="lazy" />
          <p>Plays the whole song if you are logged in to Spotify, otherwise a 30 s clip. <button type="button" className="rd-link" onClick={backToPreview}>Back to the preview</button></p>
        </div>
      ) : null}

      <div className="rd-ctl">
        {!embedId && (
          <button type="button" className="rd-btn rd-play" ref={playBtn} onClick={toggle} aria-disabled={!ready}
            aria-label={playing ? "Pause" : "Play"} title={playing ? "Pause (space)" : "Play (space)"}>
            {playing ? <PauseIc /> : <PlayIc />}
          </button>
        )}
        <button type="button" className="rd-btn" onClick={() => void startNext()} aria-label="Next song" title="Next song">
          <NextIc />
        </button>
        {!embedId && cur && cur.phase !== "loading" && (
          <button type="button" className="rd-btn rd-fullbtn" onClick={goFull} aria-pressed={full === "links"}
            title="Listen to the whole song on Spotify">
            Full song
          </button>
        )}
        <label className="rd-vol" title="Volume">
          <VolIc />
          <input type="range" min={0} max={1} step={0.02} value={volume} aria-label="Volume"
            onChange={(e) => setVol(+e.target.value)} />
        </label>
        <button type="button" className="rd-btn rd-close" onClick={stop} aria-label="Close the radio" title="Stop and close">
          <CloseIc />
        </button>
      </div>
    </div>
    </>
  );
}
