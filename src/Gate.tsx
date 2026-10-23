/** The password prompt: a glass panel over the living amoeba. It never keeps the
 *  password past the call: the value lives in one input, is cleared on a wrong
 *  answer, and is unmounted on success. Nothing is logged or stored. */
import { useEffect, useId, useRef, useState, type MutableRefObject } from "react";

/** Imperative handle, for tests on localhost (Home exposes it in dev builds only). */
export interface GateControl { submit(pw: string): Promise<boolean> }

type Status = "idle" | "pending" | "breath" | "wrong" | "error";

const MESSAGES: Record<Status, string> = {
  idle: "",
  pending: "listening...",
  breath: "catching our breath...",
  wrong: "not quite",
  error: "the vault is out of reach. try again",
};

export default function Gate({ attempt, onSuccess, onClose, closing, control, returnFocus }: {
  /** Resolves true when the word opened the vault; the caller reacts to a wrong one. */
  attempt: (pw: string) => Promise<boolean>;
  onSuccess: () => void;
  onClose: () => void;
  /** The panel is fading out (success). */
  closing: boolean;
  control?: MutableRefObject<GateControl | null>;
  /** Where focus goes when the gate closes without a way in, if it was opened with no focused element (Enter on the page). */
  returnFocus?: () => HTMLElement | null;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [shake, setShake] = useState(0);
  const panel = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const busy = useRef(false);
  const opener = useRef<Element | null>(document.activeElement);
  const cb = useRef({ attempt, onSuccess, onClose });
  cb.current = { attempt, onSuccess, onClose };
  const back = useRef(returnFocus);
  back.current = returnFocus;
  const id = useId();

  useEffect(() => {
    alive.current = true;
    input.current?.focus();
    const from = opener.current as HTMLElement | null;
    return () => {
      alive.current = false;
      // Give focus back to whatever opened the gate; if that was the page itself, to the amoeba.
      const target = from && from !== document.body && from.isConnected ? from : back.current?.() ?? null;
      if (target && target.isConnected && typeof target.focus === "function") target.focus();
    };
  }, []);

  const submit = async (pw: string): Promise<boolean> => {
    if (busy.current || !pw) return false;
    busy.current = true;
    setStatus("pending");
    const slow = window.setTimeout(() => { if (alive.current) setStatus((s) => (s === "pending" ? "breath" : s)); }, 2400);
    let ok = false, failed = false;
    try { ok = await cb.current.attempt(pw); } catch { failed = true; }
    window.clearTimeout(slow);
    busy.current = false;
    if (!alive.current) return ok;
    if (ok) { setStatus("idle"); cb.current.onSuccess(); return true; }
    setValue("");
    setStatus(failed ? "error" : "wrong");
    setShake((n) => n + 1);
    input.current?.focus();
    return false;
  };

  // Esc closes from anywhere, even if focus has wandered off the panel
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cb.current.onClose(); } };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  useEffect(() => {
    if (control) control.current = { submit };
    return () => { if (control) control.current = null; };
  });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !panel.current) return;
    // focus trap: Tab and Shift+Tab cycle inside the panel
    const items = Array.from(panel.current.querySelectorAll<HTMLElement>("input, button")).filter((x) => !x.hasAttribute("disabled"));
    if (!items.length) return;
    const first = items[0], lastEl = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus(); }
    else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus(); }
    else if (!panel.current.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  };

  const pending = status === "pending" || status === "breath";
  const msgId = `${id}-msg`, inId = `${id}-pw`;

  return (
    <div className={`gate${closing ? " closing" : ""}`} onKeyDown={onKeyDown}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form ref={panel} key={shake} className={`gate-panel${shake ? " shake" : ""}${pending ? " listening" : ""}`}
        role="dialog" aria-modal="true" aria-labelledby={`${id}-label`} aria-describedby={msgId}
        onSubmit={(e) => { e.preventDefault(); void submit(value); }} autoComplete="off">
        <button type="button" className="gate-close" aria-label="Close" onClick={onClose}>&times;</button>
        <label className="gate-label" id={`${id}-label`} htmlFor={inId}>the word</label>
        <div className="gate-field">
          <input ref={input} id={inId} className="gate-input" name="gate-word"
            type={show ? "text" : "password"} value={value} readOnly={pending}
            placeholder="whisper it..." autoFocus autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            aria-invalid={status === "wrong" || status === "error"}
            onChange={(e) => { setValue(e.target.value); if (status === "wrong" || status === "error") setStatus("idle"); }} />
          <button type="button" className="gate-eye" aria-pressed={show}
            aria-label={show ? "Hide the word" : "Show the word"} onClick={() => setShow((s) => !s)}>
            {show ? "hide" : "show"}
          </button>
        </div>
        <p className={`gate-msg ${status}`} id={msgId} role="status" aria-live="polite">
          {MESSAGES[status]}
          {pending && <span className="gate-dots" aria-hidden="true"><i /><i /><i /></span>}
        </p>
        <button type="submit" className="gate-go" aria-disabled={pending || !value}>Open</button>
      </form>
    </div>
  );
}
