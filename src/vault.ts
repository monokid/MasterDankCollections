/** The only way the app reaches the library: everything ships encrypted
 *  (public/data/vault.bin, built by tools/seal.ts), and a password opens it.
 *  The decrypted bundle lives in memory only; the raw data key (not the
 *  password) is kept in sessionStorage so a reload in the same tab skips the
 *  prompt. */
import type { Catalog } from "./catalog.ts";
import { exportDataKey, importDataKey, openBundleWithKey, openWithDataKey } from "./vaultcrypto.ts";

export interface Bundle {
  catalog: Catalog;
  /** ISO date -> weather for that night; empty when none was fetched. */
  weather: Record<string, unknown>;
}

const KEY = "mdc.vk";
let bundle: Bundle | null = null;
let sealed: Promise<Uint8Array> | null = null;
let failures = 0;

function fetchSealed(): Promise<Uint8Array> {
  const p = (async () => {
    let r: Response;
    try { r = await fetch(`${import.meta.env.BASE_URL}data/vault.bin`); }
    catch { throw new Error("Could not reach the vault (network error)"); }
    if (!r.ok) throw new Error(`Could not load the vault (HTTP ${r.status})`);
    return new Uint8Array(await r.arrayBuffer());
  })();
  sealed ??= p;
  p.catch(() => { if (sealed === p) sealed = null; });
  return sealed;
}

function parse(payload: Uint8Array): Bundle {
  let p: { catalog?: Catalog; weather?: Record<string, unknown> };
  try { p = JSON.parse(new TextDecoder().decode(payload)); }
  catch { throw new Error("The vault contents are not readable"); }
  if (!p.catalog) throw new Error("The vault has no catalogue in it");
  return { catalog: p.catalog, weather: p.weather ?? {} };
}

function store(): Storage | null {
  try { return sessionStorage; } catch { return null; }
}

/** True when a key from an earlier unlock in this tab session is still held. */
export function hasSession(): boolean {
  if (bundle) return true;
  try { return !!store()?.getItem(KEY); } catch { return false; }
}

/** Try a password. Resolves true and holds the decrypted bundle on success;
 *  resolves false for a wrong password (never throws for that). */
export async function unlock(password: string): Promise<boolean> {
  if (failures >= 3) {
    const wait = Math.min(30_000, 1000 * 2 ** (failures - 3));
    await new Promise((r) => setTimeout(r, wait));
  }
  const bytes = await fetchSealed();
  const opened = await openBundleWithKey(bytes, password);
  if (!opened) { failures++; return false; }
  failures = 0;
  bundle = parse(opened.payload);
  try { store()?.setItem(KEY, exportDataKey(opened.key)); } catch { /* storage blocked: just prompt next time */ }
  return true;
}

/** Re-open the vault from a key held by an earlier unlock in this tab session. */
export async function resume(): Promise<boolean> {
  if (bundle) return true;
  let saved: string | null = null;
  try { saved = store()?.getItem(KEY) ?? null; } catch { /* ignore */ }
  if (!saved) return false;
  try {
    bundle = parse(await openWithDataKey(await fetchSealed(), importDataKey(saved)));
    return true;
  } catch {
    // Stale key (vault re-sealed) or no network: forget it and ask again.
    try { store()?.removeItem(KEY); } catch { /* ignore */ }
    return false;
  }
}

/** The decrypted bundle, or null until unlocked. Held in memory only. */
export function getBundle(): Bundle | null { return bundle; }
