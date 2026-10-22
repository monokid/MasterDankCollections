import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Plaintext must never ship. After the build, dist/data may hold only the sealed
 *  vault and the aggregate teaser: anything else copied over from public/data is
 *  deleted, and the build FAILS if a data file or real catalogue text is still
 *  readable anywhere in dist. */
const ALLOWED_DATA = new Set(["vault.bin", "teaser.json"]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

function noPlaintext(): Plugin {
  let outDir = "dist";
  return {
    name: "mdc-no-plaintext",
    apply: "build",
    configResolved(c) { outDir = resolve(c.root, c.build.outDir); },
    closeBundle() {
      if (!existsSync(outDir)) return;
      const data = join(outDir, "data");
      if (existsSync(data)) {
        for (const f of readdirSync(data)) {
          if (!ALLOWED_DATA.has(f)) {
            rmSync(join(data, f), { recursive: true, force: true });
            this.warn(`removed plaintext-capable file from the build: data/${f}`);
          }
        }
      }
      const files = walk(outDir);
      const stray = files.filter((f) => /\.(json|csv|ndjson|tsv)$/i.test(f) &&
        relative(outDir, f).replace(/\\/g, "/") !== "data/teaser.json");
      if (stray.length) {
        throw new Error(`plaintext guard: data files in dist: ${stray.map((f) => relative(outDir, f)).join(", ")}`);
      }
      // Distinctive strings from the real catalogue, when it is on disk to compare with.
      const catPath = resolve("public/data/catalog.json");
      if (!existsSync(catPath)) return;
      const cat = JSON.parse(readFileSync(catPath, "utf8")) as { tracks?: { title: string | null; artist: string | null }[] };
      // Skip strings the app's own source legitimately contains (placeholder examples).
      const src = walk(resolve("src")).filter((f) => /\.(tsx?|css)$/.test(f)).map((f) => readFileSync(f, "utf8")).join(" ");
      const markers = new Set<string>();
      for (const t of cat.tracks ?? []) {
        for (const s of [t.title, t.artist]) if (s && s.length >= 12 && !src.includes(s)) markers.add(s);
        if (markers.size >= 400) break;
      }
      for (const f of files) {
        const buf = readFileSync(f);
        const utf = buf.toString("utf8"), bin = buf.toString("latin1");
        for (const m of markers) {
          if (utf.includes(m) || bin.includes(m)) {
            throw new Error(`plaintext guard: catalogue text found in dist/${relative(outDir, f)}`);
          }
        }
      }
    },
  };
}

// Served from https://monokid.github.io/MasterDankCollections/ in production.
// Keyed on `mode` rather than `command` so that `vite preview` -- which is a
// serve command running a production build -- gets the same base the deploy
// will use, instead of silently serving from the root and looking fine.
export default defineConfig(({ mode }) => ({
  plugins: [react(), noPlaintext()],
  base: mode === "production" ? "/MasterDankCollections/" : "/",
  build: { outDir: "dist", assetsDir: "assets" },
}));
