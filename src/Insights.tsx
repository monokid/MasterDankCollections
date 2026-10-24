/** What a decade of playlists turns out to say.
 *
 *  A tabbed page: Overview, Music, People, Trends, Nights & sound, with the
 *  headline figures (KPIs) pinned under the tab strip on every tab. This file is
 *  only the shell: the tab strip (and its address, #/insights/<tab>), the range,
 *  the figures every tab shares, the KPI strip, and the drilldown. The tabs
 *  themselves are src/insights/Tab*.tsx, each its own lazily loaded chunk; the
 *  contract they are written to is src/insights/types.ts.
 *
 *  Every bar is a door: click it and the drilldown opens beside the charts, and
 *  anything in there opens the next level. The whole page can be narrowed to a
 *  span -- drawn on the timeline, or by clicking a year -- and every figure,
 *  the KPIs included, follows. Figures that are facts about history (who first
 *  brought a song, how long it lasted) deliberately do not follow it, and say so.
 *
 *  Counts are of named tracks on dated nights: an anonymised copy is the same
 *  playlist again, and a collection is a shelf, not a night.
 *
 *  Cost: each section computes only once it has scrolled within reach, and a
 *  section folded away computes nothing. Opening a drilldown re-renders no tab.
 */
import {
  Suspense, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type KeyboardEvent,
} from "react";
import type { Catalog } from "./catalog.ts";
import type { Trace } from "./Timeline.tsx";
import type { EnrichMap } from "./enrich.ts";
import { nightsOf, playedOf, type Range } from "./analytics.ts";
import { plural } from "./format.ts";
import { kpiReport } from "./insightstats.ts";
import { scrollRootOf } from "./pagehelpers.ts";
import { lazyPage, whenIdle } from "./lazy.ts";
import { RangeTag } from "./charts.tsx";
import { INSIGHTS_TABS, type InsightsTab } from "./route.ts";
import InsightsDrill, { drillLabel } from "./insights/DrillPanel.tsx";
import KpiStrip from "./insights/KpiStrip.tsx";
import { Skeleton } from "./insights/shared.tsx";
import type { Agg, Drill, SectionCtx, TabProps } from "./insights/types.ts";
import "./pages.css";
import "./insights.css";

const TABS: Array<{ id: InsightsTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "music", label: "Music" },
  { id: "people", label: "People" },
  { id: "trends", label: "Trends" },
  { id: "nights", label: "Nights & sound" },
];

const TAB_PAGE = {
  overview: lazyPage(() => import("./insights/TabOverview.tsx")),
  music: lazyPage(() => import("./insights/TabMusic.tsx")),
  people: lazyPage(() => import("./insights/TabPeople.tsx")),
  trends: lazyPage(() => import("./insights/TabTrends.tsx")),
  nights: lazyPage(() => import("./insights/TabNights.tsx")),
} satisfies Record<InsightsTab, unknown>;

const rangeTag = (r: Range | null) => (r ? `${r.from}_${r.to}` : "");

/** Where each tab was scrolled to, for the life of the browser tab. */
const tabScroll = new Map<InsightsTab, number>();

export default function Insights({
  cat, enrich, range, onRange, onTrace, onOpenNight, onOpenSong, onOpenArtist, onOpenPerson, tab, onTab,
}: {
  cat: Catalog;
  enrich: EnrichMap | null;
  range: Range | null;
  onRange: (r: Range | null) => void;
  onTrace: (t: Trace) => void;
  onOpenNight: (id: string) => void;
  onOpenSong: (songId: string) => void;
  onOpenArtist: (id: string | null) => void;
  onOpenPerson: (id: string | null) => void;
  tab: InsightsTab;
  onTab: (t: InsightsTab) => void;
}) {
  const [stack, setStack] = useState<Drill[]>([]);
  const drill = stack[stack.length - 1] ?? null;
  const open = useCallback((d: Drill) => setStack((s) => [...s, d]), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const close = useCallback(() => setStack([]), []);

  // A range change recomputes the sections at lower priority; they dim until done.
  const dRange = useDeferredValue(range);
  const updating = dRange !== range;

  const people = useMemo(() => new Map(cat.people.map((p) => [p.id, p])), [cat]);
  const nights = useMemo(() => nightsOf(cat, dRange), [cat, dRange]);
  const T = useMemo(() => playedOf(cat, dRange), [cat, dRange]);
  const report = useMemo(() => kpiReport(cat, dRange), [cat, dRange]);

  // What each song and artist did *within the range*.
  const agg = useMemo<Agg>(() => {
    const song = new Map<string, { nights: Set<string>; plays: number }>();
    const artist = new Map<string, { nights: Set<string>; plays: number }>();
    for (const t of T) {
      if (!t.songId) continue;
      const s = song.get(t.songId) ?? { nights: new Set<string>(), plays: 0 };
      s.nights.add(t.eventId); s.plays++; song.set(t.songId, s);
      const aid = t.songId.split("|")[0];
      const a = artist.get(aid) ?? { nights: new Set<string>(), plays: 0 };
      a.nights.add(t.eventId); a.plays++; artist.set(aid, a);
    }
    return { song, artist };
  }, [T]);

  const ctx = useMemo<SectionCtx>(
    () => ({ nights, T, agg, people, report, onOpenNight, onOpenSong, onOpenArtist, onOpenPerson, onTrace }),
    [nights, T, agg, people, report, onOpenNight, onOpenSong, onOpenArtist, onOpenPerson, onTrace]);
  const tabProps = useMemo<TabProps>(
    () => ({ cat, range: dRange, enrich, ctx, open }),
    [cat, dRange, enrich, ctx, open]);

  // Warm the other tabs up once the page is on screen.
  useEffect(() => whenIdle(() => { for (const p of Object.values(TAB_PAGE)) p.preload(); }, 3000), []);

  // ----------------------------------------------------------- pinned head

  const mainRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const [slim, setSlim] = useState(false);
  const headH = useRef(0);

  // The KPI tiles shrink to a slim row once the page is scrolled well past them,
  // and come back near the top. The two thresholds differ so it cannot flicker.
  useEffect(() => {
    const root = scrollRootOf(headRef.current);
    if (!root) return;
    let raf = 0;
    const on = () => {
      raf = 0;
      const y = root.scrollTop;
      setSlim((s) => (s ? y >= 100 : y > 240));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(on); };
    root.addEventListener("scroll", onScroll, { passive: true });
    on();
    return () => { root.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }, []);

  // Shrinking the head moves everything under it; move the scroll by the same
  // amount so what the reader is looking at stays where it is.
  useLayoutEffect(() => {
    const head = headRef.current, root = scrollRootOf(head);
    if (!head || !root) return;
    const h = head.offsetHeight, d = h - headH.current;
    if (headH.current && d !== 0 && root.scrollTop > 0) root.scrollTop += d;
    headH.current = h;
  }, [slim]);

  // Sections below stick under the head; tell the CSS how tall it is.
  useLayoutEffect(() => {
    const head = headRef.current, main = mainRef.current;
    if (!head || !main || typeof ResizeObserver === "undefined") return;
    const set = () => {
      headH.current = head.offsetHeight;
      main.style.setProperty("--ins-head", `${head.offsetHeight}px`);
    };
    set();
    const ro = new ResizeObserver(set);
    ro.observe(head);
    return () => ro.disconnect();
  }, []);

  // ------------------------------------------------------------------ tabs

  // A tab picked with the mouse or keyboard remembers where the one it leaves was
  // scrolled to and brings back its own. Back / forward is left to the app, which
  // restores the scroll of the history entry it returns to.
  const restoring = useRef<InsightsTab | null>(null);
  const pick = (t: InsightsTab) => {
    if (t === tab) return;
    const root = scrollRootOf(headRef.current);
    if (root) tabScroll.set(tab, root.scrollTop);
    restoring.current = t;
    onTab(t);
  };
  useEffect(() => {
    if (restoring.current !== tab) return;
    restoring.current = null;
    const root = scrollRootOf(headRef.current);
    if (!root) return;
    const want = tabScroll.get(tab) ?? 0;
    let tries = 0, raf = 0;
    const step = () => {
      root.scrollTo({ top: want, behavior: "instant" });
      if (Math.abs(root.scrollTop - want) < 2 || ++tries > 40) return;
      raf = requestAnimationFrame(step);     // the tab may still be arriving
    };
    const stop = () => cancelAnimationFrame(raf);
    root.addEventListener("wheel", stop, { passive: true, once: true });
    raf = requestAnimationFrame(step);
    return () => { stop(); root.removeEventListener("wheel", stop); };
  }, [tab]);

  // Arrow keys move focus between the tabs; Enter or Space picks the focused one.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const n = INSIGHTS_TABS.length;
    const here = (document.activeElement as HTMLElement | null)?.dataset.tab as InsightsTab | undefined;
    const from = Math.max(0, INSIGHTS_TABS.indexOf(here ?? tab));
    const next = e.key === "Home" ? 0 : e.key === "End" ? n - 1 : (from + (e.key === "ArrowRight" ? 1 : -1) + n) % n;
    e.currentTarget.querySelector<HTMLElement>(`[data-tab="${INSIGHTS_TABS[next]}"]`)?.focus();
  };

  const Page = TAB_PAGE[tab];
  const backTo = stack.length > 1 ? drillLabel(cat, stack[stack.length - 2]) : undefined;

  return (
    <RangeTag.Provider value={rangeTag(dRange)}>
      <div className={`page wide insights${drill ? " has-drill" : ""}`}>
        <div className={`ins-main${updating ? " is-updating" : ""}`} ref={mainRef}>
          <h1>Insights</h1>
          <p className="sub">
            Named tracks on dated nights only. <b>Click any bar or figure</b> to open what is under it;
            click a year to narrow the whole page to it.
          </p>

          <div className={`ins-head${slim ? " is-slim" : ""}`} ref={headRef}>
            <div className="ins-tabrow">
              <div className="ins-tabs" role="tablist" aria-label="Insights" onKeyDown={onTabKey}>
                {TABS.map((t) => (
                  <button key={t.id} role="tab" id={`ins-tab-${t.id}`} data-tab={t.id}
                    aria-selected={tab === t.id} aria-controls="ins-panel" tabIndex={tab === t.id ? 0 : -1}
                    className="ins-tab" onClick={() => pick(t.id)}>{t.label}</button>
                ))}
              </div>
              {range && (
                <div className="toc-range" role="status">
                  <span><b>{range.from}</b> → <b>{range.to}</b> · {plural(nights.length, "night")}</span>
                  <button className="resetrange" onClick={() => onRange(null)}
                    title="Show the whole decade again">Reset range</button>
                </div>
              )}
            </div>
            <KpiStrip report={report} slim={slim} onOpen={open} />
          </div>

          <div role="tabpanel" id="ins-panel" aria-labelledby={`ins-tab-${tab}`} className="ins-panel">
            <Suspense fallback={<Skeleton />}>
              <Page {...tabProps} />
            </Suspense>
          </div>
        </div>

        {drill && (
          <InsightsDrill cat={cat} drill={drill} range={range} enrich={enrich} canBack={stack.length > 1}
            backLabel={backTo} onBack={back} onClose={close} onDrill={open}
            onTrace={onTrace} onRange={(r) => { onRange(r); close(); }}
            onOpenNight={onOpenNight} />
        )}
      </div>
    </RangeTag.Provider>
  );
}
