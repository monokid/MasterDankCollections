/** The URL hash as a mirror of where the app is. Pure functions only, so the
 *  mapping is testable without a browser. Nothing sensitive goes in here:
 *  view names, an event date, a track id, and the text the user searched for.
 *
 *    #/                    Home
 *    #/search?q=floyd      Search (q optional)
 *    #/timeline            Timeline
 *    #/browse              Browse (the list of nights)
 *    #/night/2026-05-01    one night, inside Browse
 *    #/insights            Insights, Overview tab;  #/insights/<tab>  another tab
 *                          (overview | music | people | trends | nights; an unknown
 *                          tab is Overview and the address is rewritten to say so)
 *    #/song/t123           one track's detail page (track ids are positional,
 *                          so a link can go stale after the catalogue is rebuilt;
 *                          an unknown id just lands on Search)
 *    #/people              the people gallery;  #/people/<personId>  one profile
 *    #/music               the library wall;    #/music/artist/<artistId>  one discography
 *                          (unknown ids fall back to the gallery / wall)
 *    #/plan  #/resolve    built but off the menu; reachable only by URL
 */

export const INSIGHTS_TABS = ["overview", "music", "people", "trends", "nights"] as const;
export type InsightsTab = (typeof INSIGHTS_TABS)[number];
export const isInsightsTab = (s: string | undefined): s is InsightsTab =>
  !!s && (INSIGHTS_TABS as readonly string[]).includes(s);

export type Route =
  | { name: "home" }
  | { name: "search"; q: string }
  | { name: "timeline" }
  | { name: "browse" }
  | { name: "night"; id: string }
  | { name: "insights"; tab: InsightsTab }
  | { name: "plan" }
  | { name: "resolve" }
  | { name: "song"; id: string }
  | { name: "people"; id: string | null }
  | { name: "music"; id: string | null };

export const HOME: Route = { name: "home" };

const SIMPLE = ["timeline", "browse", "plan", "resolve"] as const;

export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  const qi = raw.indexOf("?");
  const path = (qi < 0 ? raw : raw.slice(0, qi)).replace(/^\/+|\/+$/g, "");
  const params = new URLSearchParams(qi < 0 ? "" : raw.slice(qi + 1));
  const [head, ...rest] = path.split("/");
  try {
    if (!head) return HOME;
    if (head === "search") return { name: "search", q: params.get("q") ?? "" };
    if ((SIMPLE as readonly string[]).includes(head) && rest.length === 0) {
      return { name: head as (typeof SIMPLE)[number] };
    }
    if (head === "insights") {
      return { name: "insights", tab: rest.length === 1 && isInsightsTab(rest[0]) ? rest[0] : "overview" };
    }
    if ((head === "night" || head === "song") && rest.length === 1 && rest[0]) {
      const id = decodeURIComponent(rest[0]);
      if (id) return { name: head, id };
    }
    if (head === "people") {
      if (rest.length === 0) return { name: "people", id: null };
      if (rest.length === 1 && rest[0]) { const id = decodeURIComponent(rest[0]); if (id) return { name: "people", id }; }
    }
    if (head === "music") {
      if (rest.length === 0) return { name: "music", id: null };
      if (rest.length === 2 && rest[0] === "artist" && rest[1]) {
        const id = decodeURIComponent(rest[1]);
        if (id) return { name: "music", id };
      }
    }
  } catch { /* malformed %-escape: treat as unknown */ }
  return HOME;
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case "home": return "#/";
    case "search": return r.q ? `#/search?${new URLSearchParams({ q: r.q })}` : "#/search";
    case "night": case "song": return `#/${r.name}/${encodeURIComponent(r.id)}`;
    case "insights": return r.tab === "overview" ? "#/insights" : `#/insights/${r.tab}`;
    case "people": return r.id ? `#/people/${encodeURIComponent(r.id)}` : "#/people";
    case "music": return r.id ? `#/music/artist/${encodeURIComponent(r.id)}` : "#/music";
    default: return `#/${r.name}`;
  }
}

export const sameRoute = (a: Route, b: Route) => formatRoute(a) === formatRoute(b);

const SITE = "Master Dank Collections";
const NAMES: Record<Route["name"], string> = {
  home: "", search: "Search", timeline: "Timeline", browse: "Browse", night: "Night",
  insights: "Insights",   // never the tab: the title stays generic
  plan: "Planner", resolve: "Resolver", song: "Track",
  people: "People", music: "Music",   // never a person's or artist's name: titles stay generic
};

/** The document title for a route; `detail` is a more specific name (a night's
 *  date, a track's title) when the caller has one. */
export function titleFor(r: Route, detail?: string | null): string {
  if (r.name === "home") return `${SITE} · a decade of nights, in sound`;
  return `${detail || NAMES[r.name]} · ${SITE}`;
}
