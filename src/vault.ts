/** The only way the app reaches the library: everything ships encrypted
 *  (public/data/vault.bin, built by tools/seal.ts), and a password opens it.
 *  The decrypted bundle lives in memory only; the raw data key (not the
 *  password) is kept in sessionStorage so a reload in the same tab skips the
 *  prompt.
 *
 *  Failures are typed (`VaultError.code`) so the screen can say what happened:
 *    "network"  the request never completed (offline, blocked)
 *    "http"     the server answered, but not with the file (404 after a bad deploy)
 *    "corrupt"  the file is not a vault, was edited, or fails authentication
 *    "empty"    it opened, but holds no usable catalogue
 *  A wrong password is not an error: unlock() resolves false. */
import type { Catalog } from "./catalog.ts";
import { exportDataKey, importDataKey, openBundleWithKey, openWithDataKey } from "./vaultcrypto.ts";

export interface Bundle {
  catalog: Catalog;
  /** ISO date -> weather for that night; empty when none was fetched. */
  weather: Record<string, unknown>;
}

export type VaultErrorCode = "network" | "http" | "corrupt" | "empty";

export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

const KEY = "mdc.vk";

export interface VaultDeps {
  fetchBytes: () => Promise<Uint8Array>;
  storage: () => Storage | null;
  /** Throttle sleep; replaceable so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

export function parseBundle(payload: Uint8Array): Bundle {
  let p: { catalog?: Catalog; weather?: Record<string, unknown> } | null;
  try { p = JSON.parse(new TextDecoder().decode(payload)); }
  catch { throw new VaultError("corrupt", "The vault contents are not readable"); }
  const c = p?.catalog;
  // A catalogue of another shape would crash a page later with an unhelpful
  // message, so refuse it here with a clear one.
  if (!c || !Array.isArray(c.tracks) || !Array.isArray(c.events) || !Array.isArray(c.people) ||
      !Array.isArray(c.songs) || !Array.isArray(c.artists) || !Array.isArray(c.phases)) {
    throw new VaultError("empty", "The vault has no usable catalogue in it");
  }
  return { catalog: c, weather: p?.weather ?? {} };
}

export function createVault(deps: VaultDeps) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let bundle: Bundle | null = null;
  let sealed: Promise<Uint8Array> | null = null;
  let failures = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let resuming: Promise<boolean> | null = null;

  const store = (): Storage | null => { try { return deps.storage(); } catch { return null; } };

  /** The ciphertext is public, so it may be fetched before anyone has a password. */
  function fetchSealed(): Promise<Uint8Array> {
    if (sealed) return sealed;
    const p = deps.fetchBytes();
    sealed = p;
    p.catch(() => { if (sealed === p) sealed = null; });   // a failure is retried, not cached
    return p;
  }

  /** Run a crypto step, turning a crypto-layer Error into a "corrupt" VaultError. */
  async function guarded<T>(step: () => Promise<T>): Promise<T> {
    try { return await step(); }
    catch (e) {
      if (e instanceof VaultError) throw e;
      throw new VaultError("corrupt", e instanceof Error ? e.message : "The vault could not be opened");
    }
  }

  async function tryPassword(password: string): Promise<boolean> {
    if (failures >= 3) await sleep(Math.min(30_000, 1000 * 2 ** (failures - 3)));
    const bytes = await fetchSealed();
    const opened = await guarded(() => openBundleWithKey(bytes, password));
    if (!opened) { failures++; return false; }
    failures = 0;
    bundle = parseBundle(opened.payload);
    try { store()?.setItem(KEY, exportDataKey(opened.key)); } catch { /* storage blocked: just prompt next time */ }
    return true;
  }

  return {
    /** True when a key from an earlier unlock in this tab session is still held. */
    hasSession(): boolean {
      if (bundle) return true;
      try { return !!store()?.getItem(KEY); } catch { return false; }
    },

    /** Start downloading the ciphertext now, so the password prompt only waits
     *  on the key derivation. Never throws; a failure is simply retried on unlock. */
    prefetch(): void { fetchSealed().catch(() => {}); },

    /** Try a password. Resolves true and holds the decrypted bundle on success;
     *  resolves false for a wrong password. Rejects with a VaultError when the
     *  vault itself cannot be loaded or read. Calls are queued, so two quick
     *  submits cannot race each other over the failure throttle or the bundle. */
    unlock(password: string): Promise<boolean> {
      const run = queue.then(() => tryPassword(password));
      queue = run.catch(() => {});
      return run;
    },

    /** Re-open the vault from a key held by an earlier unlock in this tab session. */
    resume(): Promise<boolean> {
      if (bundle) return Promise.resolve(true);
      if (resuming) return resuming;
      const run = (async () => {
        let saved: string | null = null;
        try { saved = store()?.getItem(KEY) ?? null; } catch { /* ignore */ }
        if (!saved) return false;
        let bytes: Uint8Array;
        try { bytes = await fetchSealed(); }
        catch { return false; }          // offline: keep the key, the next try may work
        try {
          bundle = parseBundle(await guarded(() => openWithDataKey(bytes, importDataKey(saved!))));
          return true;
        } catch {
          // Stale key (vault re-sealed) or unreadable file: forget it and ask again.
          try { store()?.removeItem(KEY); } catch { /* ignore */ }
          return false;
        }
      })();
      resuming = run;
      const clear = () => { if (resuming === run) resuming = null; };
      run.then(clear, clear);
      return run;
    },

    /** The decrypted bundle, or null until unlocked. Held in memory only. */
    getBundle(): Bundle | null { return bundle; },
  };
}

async function fetchVaultBytes(): Promise<Uint8Array> {
  let r: Response;
  try { r = await fetch(`${import.meta.env.BASE_URL}data/vault.bin`); }
  catch { throw new VaultError("network", "Could not reach the vault (network error)"); }
  if (!r.ok) throw new VaultError("http", `Could not load the vault (HTTP ${r.status})`);
  try { return new Uint8Array(await r.arrayBuffer()); }
  catch { throw new VaultError("network", "The vault download was interrupted"); }
}

const vault = createVault({
  fetchBytes: fetchVaultBytes,
  storage: () => sessionStorage,
});

export const { hasSession, prefetch, unlock, resume, getBundle } = vault;
