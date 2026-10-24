/** Global keyboard shortcuts, as a small pure state machine so the rules
 *  (never while typing, never with a modifier, "g" then a letter) are testable.
 *
 *    /        focus search          ?   keyboard help         Esc  close / back out
 *    r        start the cosmic radio (or skip to the next song)
 *    g s|m|t|b|p|i   go to Search / Music / Timeline / Browse / People / Insights  (like Gmail)  */

export type GotoView = "search" | "music" | "timeline" | "browse" | "people" | "insights";

export type KeyAction =
  | { type: "focus-search" }
  | { type: "help" }
  | { type: "escape" }
  | { type: "radio" }
  | { type: "goto"; to: GotoView };

export interface KeyInfo {
  key: string;
  ctrlKey: boolean; metaKey: boolean; altKey: boolean;
  /** The event came from somewhere text is typed. */
  typing: boolean;
}

/** True for inputs, textareas, selects and contenteditable regions. */
export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

export const CHORD_MS = 1500;
const GOTO: Record<string, GotoView> = {
  s: "search", m: "music", t: "timeline", b: "browse", p: "people", i: "insights",
};

export function createKeyMachine(now: () => number = () => Date.now()) {
  let gAt = -Infinity;
  return {
    feed(e: KeyInfo): KeyAction | null {
      if (e.typing || e.ctrlKey || e.metaKey || e.altKey) { gAt = -Infinity; return null; }
      const armed = now() - gAt <= CHORD_MS;
      gAt = -Infinity;
      if (armed && GOTO[e.key]) return { type: "goto", to: GOTO[e.key] };
      switch (e.key) {
        case "g": gAt = now(); return null;
        case "/": return { type: "focus-search" };
        case "?": return { type: "help" };
        case "Escape": return { type: "escape" };
        case "r": return { type: "radio" };
        default: return null;
      }
    },
  };
}
