/** The one vault implementation, shared by the browser (src/vault.ts) and the
 *  Node tools (tools/seal.ts, tools/vault.test.ts). WebCrypto only.
 *
 *  File layout:  "MDCV" | u32be headerLength | header JSON (utf8) | AES-GCM ciphertext
 *  The payload is gzipped, then encrypted under a random 256-bit data key. Each
 *  password gets a "slot": the data key wrapped (AES-GCM) under a key derived
 *  from that password with PBKDF2-SHA256. No password or verifier is stored; a
 *  password is right exactly when its slot unwraps. The header is bound to the
 *  data ciphertext as AAD, so it cannot be swapped or edited undetected. */

export const KDF_ITERATIONS = 600_000;
const MAGIC = [0x4d, 0x44, 0x43, 0x56]; // "MDCV"

interface Slot { salt: string; iv: string; wrappedKey: string }
interface Header {
  v: 1;
  kdf: { name: "PBKDF2"; hash: "SHA-256"; iterations: number };
  iv: string;
  slots: Slot[];
}

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
type Bytes = Uint8Array<ArrayBuffer>;

function b64(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
function unb64(s: string): Bytes {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const rand = (n: number): Bytes => globalThis.crypto.getRandomValues(new Uint8Array(n));

async function pipe(data: Uint8Array, t: CompressionStream | DecompressionStream): Promise<Bytes> {
  const stream = new Blob([data as Bytes]).stream().pipeThrough(t as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(stream as ReadableStream).arrayBuffer());
}
export const gzip = (d: Uint8Array) => pipe(d, new CompressionStream("gzip"));
export const gunzip = (d: Uint8Array) => pipe(d, new DecompressionStream("gzip"));

export const cleanPassword = (p: string) => p.trim();

async function derive(password: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const base = await subtle.importKey("raw", enc.encode(cleanPassword(password)), "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const dataKey = (raw: Bytes, use: KeyUsage) => subtle.importKey("raw", raw, "AES-GCM", false, [use]);

function pack(header: Header, ct: Bytes): Bytes {
  const h = enc.encode(JSON.stringify(header));
  const out = new Uint8Array(8 + h.length + ct.length);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(4, h.length);
  out.set(h, 8);
  out.set(ct, 8 + h.length);
  return out;
}

function unpack(bytes: Uint8Array): { header: Header; headerBytes: Bytes; ct: Bytes } {
  if (bytes.length < 8 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("Not a vault file");
  const hl = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4);
  if (8 + hl > bytes.length) throw new Error("Vault header is truncated");
  const headerBytes = bytes.slice(8, 8 + hl);
  let header: Header;
  try { header = JSON.parse(new TextDecoder().decode(headerBytes)); }
  catch { throw new Error("Vault header is unreadable"); }
  if (header?.v !== 1 || header.kdf?.name !== "PBKDF2" || !Array.isArray(header.slots)) {
    throw new Error("Unsupported vault version");
  }
  return { header, headerBytes, ct: bytes.slice(8 + hl) };
}

/** Encrypt `payload` so that any one of `passwords` opens it. */
export async function sealBundle(payload: Uint8Array, passwords: string[]): Promise<Uint8Array> {
  const pws = passwords.map(cleanPassword).filter(Boolean);
  if (!pws.length) throw new Error("sealBundle needs at least one non-empty password");
  const raw = rand(32);
  const slots = await Promise.all(pws.map(async (pw): Promise<Slot> => {
    const salt = rand(16), iv = rand(12);
    const kek = await derive(pw, salt, KDF_ITERATIONS);
    const wrapped = await subtle.encrypt({ name: "AES-GCM", iv }, kek, raw);
    return { salt: b64(salt), iv: b64(iv), wrappedKey: b64(new Uint8Array(wrapped)) };
  }));
  const iv = rand(12);
  const header: Header = {
    v: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: KDF_ITERATIONS },
    iv: b64(iv), slots,
  };
  const aad = enc.encode(JSON.stringify(header));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, await dataKey(raw, "encrypt"), await gzip(payload));
  return pack(header, new Uint8Array(ct));
}

async function decryptData(bytes: Uint8Array, raw: Bytes): Promise<Bytes> {
  const { header, headerBytes, ct } = unpack(bytes);
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: "AES-GCM", iv: unb64(header.iv), additionalData: headerBytes }, await dataKey(raw, "decrypt"), ct);
  } catch { throw new Error("Vault data failed authentication (corrupt or tampered)"); }
  return gunzip(new Uint8Array(plain));
}

/** Try one password against every slot. Returns the data key and payload, or
 *  null when no slot opens (wrong password). Throws only for a damaged file. */
export async function openBundleWithKey(bytes: Uint8Array, password: string): Promise<{ key: Uint8Array; payload: Uint8Array } | null> {
  const { header } = unpack(bytes);
  const pw = cleanPassword(password);
  if (!pw) return null;
  const tries = await Promise.all(header.slots.map(async (s): Promise<Bytes | null> => {
    try {
      const kek = await derive(pw, unb64(s.salt), header.kdf.iterations);
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(s.iv) }, kek, unb64(s.wrappedKey)));
    } catch { return null; }
  }));
  const raw = tries.find((k) => k !== null) ?? null;
  if (!raw) return null;
  return { key: raw, payload: await decryptData(bytes, raw) };
}

export async function openBundle(bytes: Uint8Array, password: string): Promise<Uint8Array | null> {
  return (await openBundleWithKey(bytes, password))?.payload ?? null;
}

/** Open with a data key saved from an earlier unlock (session resume). */
export async function openWithDataKey(bytes: Uint8Array, rawKey: Uint8Array): Promise<Uint8Array> {
  return decryptData(bytes, rawKey as Bytes);
}

export const exportDataKey = (key: Uint8Array): string => b64(key);
export const importDataKey = (s: string): Uint8Array => unb64(s);
