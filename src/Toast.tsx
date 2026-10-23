/** A small confirmation that fades by itself: "Copied 14 lines".
 *
 *    const { toast, node } = useToast();
 *    ...  toast("Copied");  ...  return <>{...}{node}</>;
 *
 *  The live region is always in the page so screen readers announce changes. */
import { useCallback, useEffect, useRef, useState } from "react";
import "./pages.css";

export function useToast(ms = 2400) {
  const [msg, setMsg] = useState<{ id: number; text: string } | null>(null);
  const timer = useRef(0);
  const seq = useRef(0);
  const toast = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMsg({ id: ++seq.current, text });
    timer.current = window.setTimeout(() => setMsg(null), ms);
  }, [ms]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const node = (
    <div className="toast-host" role="status" aria-live="polite">
      {msg && <div className="toast" key={msg.id}>{msg.text}</div>}
    </div>
  );
  return { toast, node };
}
