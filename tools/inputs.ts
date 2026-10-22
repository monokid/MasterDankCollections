/** Sealed INPUTS: the plaintext crawl / Spotify / enrich / weather files in data/
 *  are never committed; data/inputs.enc is, so CI can rebuild.
 *    npm run inputs:seal   data/*.json  -> data/inputs.enc   (AES-256-GCM, MDC_INPUT_KEY)
 *    npm run inputs:open   data/inputs.enc -> data/*.json
 *  Payload = gzip(JSON {files: {name: text}}); file = "MDCI" | iv(12) | ciphertext+tag. */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip, gunzip } from "../src/vaultcrypto.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAGIC = new TextEncoder().encode("MDCI");
const subtle = globalThis.crypto.subtle;

async function keyOf(b64: string | undefined, use: KeyUsage): Promise<CryptoKey> {
  const raw = Buffer.from((b64 ?? "").trim(), "base64");
  if (raw.length !== 32) throw new Error("MDC_INPUT_KEY is missing or is not 32 bytes of base64");
  return subtle.importKey("raw", raw, "AES-GCM", false, [use]);
}

export async function sealInputs(files: Record<string, string>, keyB64: string | undefined): Promise<Uint8Array> {
  const key = await keyOf(keyB64, "encrypt");
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const body = await gzip(new TextEncoder().encode(JSON.stringify({ files })));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: MAGIC }, key, body));
  const out = new Uint8Array(MAGIC.length + 12 + ct.length);
  out.set(MAGIC, 0); out.set(iv, MAGIC.length); out.set(ct, MAGIC.length + 12);
  return out;
}

export async function openInputs(bytes: Uint8Array, keyB64: string | undefined): Promise<Record<string, string>> {
  const key = await keyOf(keyB64, "decrypt");
  if (bytes.length < 16 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error("Not an inputs file");
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(4, 16), additionalData: MAGIC }, key, bytes.slice(16));
  } catch { throw new Error("inputs.enc failed authentication: wrong MDC_INPUT_KEY, or the file is damaged"); }
  const { files } = JSON.parse(new TextDecoder().decode(await gunzip(new Uint8Array(plain))));
  return files;
}

/** Which data/ files travel in the bundle. */
export const isInput = (f: string) => f.endsWith(".json");

async function main() {
  const mode = process.argv[2];
  const dir = join(ROOT, "data");
  const encPath = join(dir, "inputs.enc");
  if (mode === "seal") {
    const files: Record<string, string> = {};
    for (const f of readdirSync(dir).filter(isInput).sort()) files[f] = readFileSync(join(dir, f), "utf8");
    if (!Object.keys(files).length) throw new Error("no data/*.json to seal");
    writeFileSync(encPath, await sealInputs(files, process.env.MDC_INPUT_KEY));
    console.log(`sealed   data/inputs.enc  ${Object.keys(files).length} files: ${Object.keys(files).join(", ")}`);
  } else if (mode === "open") {
    if (!existsSync(encPath)) throw new Error("data/inputs.enc not found");
    const files = await openInputs(new Uint8Array(readFileSync(encPath)), process.env.MDC_INPUT_KEY);
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, basename(name)), text);
    console.log(`opened   data/inputs.enc  ${Object.keys(files).length} files into data/`);
  } else throw new Error("usage: inputs.ts seal|open");
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main().catch((e) => { console.error(`inputs: ${e.message ?? e}`); process.exit(1); });
