import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Catalog, Track } from "./catalog.ts";
import Starfield from "./Starfield.tsx";
import Logo from "./Logo.tsx";
import Home, { Wash, prefersReducedMotion } from "./Home.tsx";
import TabRail from "./TabRail.tsx";
import "./core.css";
import type { Trace } from "./Timeline.tsx";
import ErrorBoundary from "./ErrorBoundary.tsx";
import KeyHelp from "./KeyHelp.tsx";
import Loader from "./Loader.tsx";
import { lazyPage, whenIdle } from "./lazy.ts";
import { catalogIndex } from "./catalogIndex.ts";
import { isShown, visibleCatalog } from "./config.ts";
import { getBundle, hasSession, prefetch, resume, type Bundle } from "./vault.ts";
import type { WeatherMap } from "./weather.ts";
import type { Range } from "./analytics.ts";
import { HOME, formatRoute, parseRoute, titleFor, type Route } from "./route.ts";
import { createKeyMachine, isTypingTarget } from "./keys.ts";
import { getSearchQuery, requestSearchFocus, setSearchQuery, subscribeSearchQuery } from "./events.ts";

// Home is the only thing in the first download. Every page is its own chunk,
// fetched on demand and warmed up while the browser is idle.
const SongSearch = lazyPage(() => import("./SongSearch.tsx"));
const TimelinePage = lazyPage(() => import("./TimelinePage.tsx"));
const BrowseView = lazyPage(() => import("./BrowseView.tsx"));
const Insights = lazyPage(() => import("./Insights.tsx"));
const Planner = lazyPage(() => import("./Planner.tsx"));
const Resolver = lazyPage(() => import("./Resolver.tsx"));
const TrackDetail = lazyPage(() => import("./TrackDetail.tsx"));

type View = "home" | "search" | "timeline" | "browse" | "insights" | "plan" | "resolve";
type MenuView = "search" | "timeline" | "browse" | "insights";

const MENU: readonly MenuView[] = ["search", "timeline", "browse", "insights"];
const LAST_VIEW = "mdc.view";

/** The view this tab session last used (not a secret: just a tab name). */
function lastView(): MenuView {
  try {
    const v = sessionStorage.getItem(LAST_VIEW);
    if (v && (MENU as readonly string[]).includes(v)) return v as MenuView;
  } catch { /* storage blocked */ }
  return "search";
}

function routeOf(view: View, detail: Track | null, eventId: string | null): Route {
  if (detail) return { name: "song", id: detail.id };
  switch (view) {
    case "home": return HOME;
    case "search": return { name: "search", q: getSearchQuery() };
    case "browse": return eventId ? { name: "night", id: eventId } : { name: "browse" };
    default: return { name: view };
  }
}

/** Does the address bar already say this? Compared as routes, so %20 vs + does not matter. */
const urlIs = (r: Route) => formatRoute(parseRoute(window.location.hash)) === formatRoute(r);

// Each history entry we create carries a counter, so we know whether Back would
// stay inside the app, and which scroll position belongs to which entry.
const histKey = (): number => {
  const k = (window.history.state as { k?: unknown } | null)?.k;
  return typeof k === "number" ? k : 0;
};

export default function App() {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [view, setView] = useState<View>("home");
  // The click-through from Home: where the colour flood started, until it has dissolved.
  const [wash, setWash] = useState<{ x: number; y: number } | null>(null);
  // Search just surfaced from the wash: animate it in once.
  const [emerge, setEmerge] = useState(false);
  const [detail, setDetail] = useState<Track | null>(null);
  const [trace, setTrace] = useState<Trace | null>(null);
  // The span Insights is narrowed to -- drawn on the timeline, or picked by
  // clicking a year. One piece of state, shared, so the two stay in step.
  const [range, setRange] = useState<Range | null>(null);
  const [selectedNight, setSelectedNight] = useState<string | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [weather, setWeather] = useState<WeatherMap>({});
  const [help, setHelp] = useState(false);

  // Latest values for listeners that are registered once.
  const catRef = useRef<Catalog | null>(null);
  const live = useRef({ view, detail, wash });
  live.current = { view, detail, wash };
  const scrollRef = useRef<HTMLElement>(null);

  // A deep link opened while locked: remembered, and followed once the vault opens.
  const pending = useRef<Route | null>(null);
  const read = useRef(false);
  if (!read.current) {
    read.current = true;
    const r = parseRoute(window.location.hash);
    if (r.name !== "home") pending.current = r;
  }

  // ------------------------------------------------------------ unlock

  // The decrypted bundle becomes a visible catalogue once per bundle, however
  // often Home hands us back (clicking the logo and entering again).
  const loaded = useRef<{ bundle: Bundle; cat: Catalog } | null>(null);
  const load = useCallback((): Catalog | null => {
    const b = getBundle();
    if (!b) return null;
    if (loaded.current?.bundle !== b) {
      loaded.current = { bundle: b, cat: visibleCatalog(b.catalog) };
      setWeather(b.weather as WeatherMap);
    }
    return loaded.current.cat;
  }, []);

  const adopt = useCallback((c: Catalog) => { catRef.current = c; setCat(c); }, []);

  /** Make the app show `r`, adjusting it to what exists (an unknown night is just Browse). */
  const applyRoute = useCallback((r: Route, c: Catalog) => {
    const ix = catalogIndex(c);
    let applied: Route = r;
    setEmerge(false);
    switch (r.name) {
      case "home":
        setView("home"); setDetail(null); break;
      case "search":
        setSearchQuery(r.q); setView("search"); setDetail(null); break;
      case "night": {
        const e = ix.event.get(r.id);
        if (e && isShown(e)) setEventId(r.id);
        else { applied = { name: "browse" }; setEventId(null); }
        setView("browse"); setDetail(null);
        break;
      }
      case "browse":
        setEventId(null); setView("browse"); setDetail(null); break;
      case "song": {
        const t = ix.track.get(r.id);
        if (t) { setDetail(t); setView((v) => (v === "home" ? "search" : v)); }
        else { applied = { name: "search", q: getSearchQuery() }; setView("search"); setDetail(null); }
        break;
      }
      default:
        setView(r.name); setDetail(null);
    }
    // The address bar must never claim a page we did not show.
    if (formatRoute(applied) !== formatRoute(r)) {
      window.history.replaceState({ k: histKey() }, "", formatRoute(applied));
    }
  }, []);

  // Nothing is fetched in the clear: the catalogue arrives only through the
  // vault, after Home has unlocked it. A reload in the same tab session still
  // holds the key, so open the vault quietly -- and if the address is a deep
  // link, go straight to it rather than make the visitor click through again.
  useEffect(() => {
    let alive = true;
    if (!hasSession()) { prefetch(); return; }
    resume().then((ok) => {
      if (!alive || !ok || catRef.current) return;
      const p = pending.current;
      if (!p) return;                                   // Home's own click-through takes it from here
      const c = load();
      if (!c) return;
      pending.current = null;
      adopt(c);
      applyRoute(p, c);
    }).catch(() => {});
    return () => { alive = false; };
  }, [load, adopt, applyRoute]);

  const enter = useCallback((x: number, y: number) => {
    const c = load();
    if (!c) return;                       // Home only calls this after a successful unlock
    adopt(c);
    setWash((w) => w ?? { x, y });
  }, [load, adopt]);

  // Warm the pages up so entering feels instant: search first (it is where
  // everyone lands), then the rest once the catalogue is open.
  useEffect(() => whenIdle(() => { SongSearch.preload(); TrackDetail.preload(); }), []);
  useEffect(() => {
    if (!cat) return;
    return whenIdle(() => {
      for (const p of [SongSearch, TimelinePage, BrowseView, Insights, TrackDetail]) p.preload();
      void import("./NightPage.tsx");
    }, 4000);
  }, [cat]);

  // ------------------------------------------------------- history & scroll

  const keyNow = useRef(0);       // the history entry we are on
  const keyTop = useRef(0);       // the newest entry we have made
  const keyStart = useRef(0);     // the entry the page loaded on: Back from here leaves the app
  const scrolls = useRef(new Map<number, number>());
  const leavingTop = useRef(0);
  const restoreToken = useRef(0);
  const navDuringWash = useRef(false);

  useEffect(() => {
    window.history.scrollRestoration = "manual";     // the scroller is <main>, not the window
    keyNow.current = keyTop.current = keyStart.current = histKey();
    if ((window.history.state as { k?: unknown } | null)?.k === undefined) {
      window.history.replaceState({ k: keyNow.current }, "");
    }
  }, []);

  const snap = useCallback(() => { leavingTop.current = scrollRef.current?.scrollTop ?? 0; }, []);
  /** Every in-app navigation goes through here: remember where we were scrolled, then change state. */
  const nav = useCallback((fn: () => void) => {
    snap();
    if (live.current.wash) navDuringWash.current = true;
    fn();
  }, [snap]);

  const restoreScroll = useCallback((top: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const token = ++restoreToken.current;
    let tries = 0;
    // The page may still be arriving (a lazy chunk, a list laying out): keep
    // trying for a moment, and give up the instant the visitor scrolls.
    const step = () => {
      if (token !== restoreToken.current) return;
      el.scrollTo({ top, behavior: "instant" });
      if (Math.abs(el.scrollTop - top) < 2 || ++tries > 45) return;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const stop = () => { restoreToken.current++; };
    const opts = { passive: true } as const;
    el.addEventListener("wheel", stop, opts);
    el.addEventListener("touchstart", stop, opts);
    el.addEventListener("keydown", stop);
    return () => {
      el.removeEventListener("wheel", stop);
      el.removeEventListener("touchstart", stop);
      el.removeEventListener("keydown", stop);
    };
  }, []);

  // Back / forward (and a hand-edited hash).
  useEffect(() => {
    const onPop = () => {
      scrolls.current.set(keyNow.current, scrollRef.current?.scrollTop ?? 0);
      keyNow.current = histKey();
      const r = parseRoute(window.location.hash);
      const c = catRef.current;
      if (!c) { pending.current = r.name === "home" ? null : r; return; }   // still locked: remember it
      if (live.current.wash) navDuringWash.current = true;
      applyRoute(r, c);
      restoreScroll(scrolls.current.get(keyNow.current) ?? 0);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [applyRoute, restoreScroll]);

  // State -> URL. The URL mirrors the app, it does not drive it: this only
  // writes when the address differs, and never while the vault is still shut
  // (the visitor's deep link must survive until it can be followed).
  useLayoutEffect(() => {
    if (!cat || wash) return;
    const route = routeOf(view, detail, eventId);
    if (urlIs(route)) return;
    scrolls.current.set(keyNow.current, leavingTop.current);
    keyNow.current = ++keyTop.current;
    window.history.pushState({ k: keyNow.current }, "", formatRoute(route));
    restoreToken.current++;
    scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [cat, wash, view, detail, eventId]);

  // The search box reports every keystroke; mirror it quietly (replace, not
  // push, so Back does not step through letters).
  useEffect(() => {
    let timer = 0;
    const off = subscribeSearchQuery((q) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const l = live.current;
        if (!catRef.current || l.wash || l.view !== "search" || l.detail) return;
        const r: Route = { name: "search", q };
        if (!urlIs(r)) window.history.replaceState(window.history.state, "", formatRoute(r));
      }, 250);
    });
    return () => { off(); window.clearTimeout(timer); };
  }, []);

  /** Close a track: step back if we came here from inside the app, else just close it. */
  const closeDetail = useCallback(() => {
    if (keyNow.current > keyStart.current) window.history.back();
    else nav(() => setDetail(null));
  }, [nav]);

  // ------------------------------------------------------ title & announce

  const route = useMemo(() => routeOf(view, detail, eventId), [view, detail, eventId]);
  const unlocked = cat !== null;
  const night = route.name === "night" ? route.id : null;
  useEffect(() => {
    document.title = titleFor(unlocked ? route : HOME, night);   // a date is already in the URL; never a song name
  }, [unlocked, route, night]);
  const announce = unlocked && route.name !== "home" ? titleFor(route, night).split(" · ")[0] : "";

  // Remember the last used view for this tab session.
  useEffect(() => {
    if (!cat || !(MENU as readonly string[]).includes(view)) return;
    try { sessionStorage.setItem(LAST_VIEW, view); } catch { /* storage blocked */ }
  }, [cat, view]);

  // -------------------------------------------------------------- keyboard

  const keys = useRef(createKeyMachine());
  const goView = useCallback((v: MenuView) => {
    nav(() => { setView(v); setDetail(null); setEmerge(false); });
  }, [nav]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = keys.current.feed({
        key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey,
        typing: isTypingTarget(e.target),
      });
      if (!a || help || e.defaultPrevented) return;
      const l = live.current;
      const open = catRef.current !== null && !l.wash;
      switch (a.type) {
        case "help": e.preventDefault(); setHelp(true); break;
        case "escape": if (l.detail) { e.preventDefault(); closeDetail(); } break;
        case "focus-search":
          if (!open) break;
          e.preventDefault();
          if (l.view !== "search" || l.detail) goView("search");
          requestSearchFocus();
          break;
        case "goto": if (open) goView(a.to); break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [help, closeDetail, goView]);

  // ------------------------------------------------------------ callbacks

  const open = useCallback((t: Track) => { nav(() => setDetail(t)); }, [nav]);
  // Picking a song, artist or person from anywhere jumps to the timeline with
  // its nights lit. That is the point of having a timeline at all.
  const onTrace = useCallback((t: Trace) => {
    nav(() => { setTrace(t); setDetail(null); setView("timeline"); });
  }, [nav]);
  const openNight = useCallback((id: string) => {
    nav(() => { setEventId(id); setView("browse"); setDetail(null); });
  }, [nav]);
  const setNight = useCallback((id: string | null) => nav(() => setEventId(id)), [nav]);
  const onInsights = useCallback(() => nav(() => setView("insights")), [nav]);

  // Plan and Resolve stay built but are off the menu (#/plan and #/resolve still open them).
  const leftTabs: [View, string][] = [["search", "Search"], ["timeline", "Timeline"]];
  const rightTabs: [View, string][] = [["browse", "Browse"], ["insights", "Insights"]];
  const pick = (v: View) => {
    nav(() => {
      // Clicking Browse while already on a night goes back to the list.
      if (v === "browse" && view === "browse" && !detail) setEventId(null);
      setView(v); setDetail(null); setEmerge(false);
    });
  };
  const goHome = () => { nav(() => { setView("home"); setDetail(null); setEmerge(false); }); };

  const onPeak = () => {
    if (navDuringWash.current) { navDuringWash.current = false; return; }   // they already went somewhere
    const p = pending.current, c = catRef.current;
    pending.current = null;
    if (p && c) applyRoute(p, c);
    else { setView(lastView()); setDetail(null); }
    setEmerge(true);
  };

  // ---------------------------------------------------------------- pages

  let page;
  if (!cat || (view === "home" && !detail)) {
    page = <Home leaving={wash !== null} onEnter={enter} />;
  } else if (detail) {
    page = <TrackDetail track={detail} cat={cat} onClose={closeDetail} onTrace={onTrace} />;
  } else if (view === "search") {
    page = <SongSearch cat={cat} onOpen={open} onTrace={onTrace} />;
  } else if (view === "timeline") {
    page = (
      <TimelinePage cat={cat} trace={trace} setTrace={setTrace}
        selected={selectedNight} setSelected={setSelectedNight}
        range={range} setRange={setRange} onInsights={onInsights}
        onOpen={open} onOpenNight={openNight} onTrace={onTrace} />
    );
  } else if (view === "browse") {
    page = <BrowseView cat={cat} weather={weather} onOpen={open} eventId={eventId} setEventId={setNight} />;
  } else if (view === "insights") {
    page = <Insights cat={cat} range={range} onRange={setRange} onTrace={onTrace} onOpenNight={openNight} />;
  } else if (view === "plan") {
    page = <Planner cat={cat} range={range} onRange={setRange} onTrace={onTrace} onOpenNight={openNight} />;
  } else {
    page = <Resolver cat={cat} />;
  }

  return (
    <>
      <a className="skip-link" href="#main"
        onClick={(e) => { e.preventDefault(); scrollRef.current?.focus({ preventScroll: true }); }}>
        Skip to content
      </a>
      <Starfield />
      <div className="vignette" />
      <div className="shell">
        <header className={`topbar${view === "home" ? " is-home" : ""}`}>
          {cat ? <TabRail items={leftTabs} view={view} dimmed={!!detail} side="left" onPick={pick} /> : <span />}
          <Logo onHome={goHome} />
          {cat ? <TabRail items={rightTabs} view={view} dimmed={!!detail} side="right" onPick={pick} /> : <span />}
        </header>

        <main id="main" tabIndex={-1} ref={scrollRef} className={`scroll${view === "home" ? " is-home" : ""}`}>
          <div className={emerge ? "emerge" : undefined}>
            <ErrorBoundary resetKey={route.name + ("id" in route ? route.id : "")}>
              <Suspense fallback={<Loader />}>{page}</Suspense>
            </ErrorBoundary>
          </div>
        </main>
      </div>
      {wash && (
        <Wash x={wash.x} y={wash.y} reduced={prefersReducedMotion()}
          onPeak={onPeak} onDone={() => setWash(null)} />
      )}
      {help && <KeyHelp onClose={() => setHelp(false)} />}
      <div className="mdc-sr" role="status" aria-live="polite">{announce}</div>
    </>
  );
}
