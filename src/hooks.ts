/** Small hooks the pages share. */
import { useCallback, useEffect, useRef, useState } from "react";

// Browser storage can be blocked (private windows); memory still holds for the
// life of the page, which is all "remembered during the session" needs.
const memory = new Map<string, string>();

function read<T>(key: string, initial: T): T {
  try {
    const raw = sessionStorage.getItem("mdc:" + key) ?? memory.get(key);
    if (raw != null) return JSON.parse(raw) as T;
  } catch { /* fall through to the default */ }
  return initial;
}

function write(key: string, value: unknown) {
  const raw = JSON.stringify(value);
  memory.set(key, raw);
  try { sessionStorage.setItem("mdc:" + key, raw); } catch { /* memory only */ }
}

/** useState that survives the page being unmounted (switching tabs) and a
 *  reload within the same browser tab. Values must be JSON-able. */
export function useSessionState<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, initial));
  const set = useCallback((v: T | ((p: T) => T)) => {
    setValue((prev) => {
      const next = typeof v === "function" ? (v as (p: T) => T)(prev) : v;
      write(key, next);
      return next;
    });
  }, [key]);
  return [value, set];
}

/** Runs `fn` on every change of `key` except the first. Unlike a boolean
 *  "first run" flag it survives StrictMode's double-invoked effects. */
export function useOnChange(key: string, fn: () => void) {
  const prev = useRef<string | null>(null);
  useEffect(() => {
    if (prev.current !== null && prev.current !== key) fn();
    prev.current = key;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
