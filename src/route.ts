/** The URL hash as a mirror of where the app is. Pure functions only, so the
 *  mapping is testable without a browser. Nothing sensitive goes in here:
 *  view names, an event date, a track id, and the text the user searched for.
 *
 *    #/                    Home
 *    #/search?q=floyd      Search (q optional)
 *    #/timeline            Timeline
 *    #/browse              Browse (the list of nights)
 *    #/night/2026-05-01    one night, inside Browse
 *    #/insights            Insights
 *    #/song/t123           one track's detail page (track ids are positional,
 *                          so a link can go stale after the catalogue is rebuilt;
 *                          an unknown id just lands on Search)
 *    #/plan  #/resolve     built but off the menu; reachable only by URL
 */

export type Route =
  | { name: "home" }
  | { name: "search"; q: string }
  | { name: "timeline" }
  | { name: "browse" }
  | { name: "night"; id: string }
  | { name: "insights" }
  | { name: "plan" }
  | { name: "resolve" }
  | { name: "song"; id: string };

export const HOME: Route = { name: "home" };

const SIMPLE = ["timeline", "browse", "insights", "plan", "resolve"] as const;

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
    if ((head === "night" || head === "song") && rest.length === 1 && rest[0]) {
      const id = decodeURIComponent(rest[0]);
      if (id) return { name: head, id };
    }
  } catch { /* malformed %-escape: treat as unknown */ }
  return HOME;
}

export function formatRoute(r: Route): string {
  switch (r.name) {
    case "home": return "#/";
    case "search": return r.q ? `#/search?${new URLSearchParams({ q: r.q })}` : "#/search";
    case "night": case "song": return `#/${r.name}/${encodeURIComponent(r.id)}`;
    default: return `#/${r.name}`;
  }
}

export const sameRoute = (a: Route, b: Route) => formatRoute(a) === formatRoute(b);

const SITE = "Master Dank Collections";
const NAMES: Record<Route["name"], string> = {
  home: "", search: "Search", timeline: "Timeline", browse: "Browse", night: "Night",
  insights: "Insights", plan: "Planner", resolve: "Resolver", song: "Track",
};

/** The document title for a route; `detail` is a more specific name (a night's
 *  date, a track's title) when the caller has one. */
export function titleFor(r: Route, detail?: string | null): string {
  if (r.name === "home") return `${SITE} · a decade of nights, in sound`;
  return `${detail || NAMES[r.name]} · ${SITE}`;
}
