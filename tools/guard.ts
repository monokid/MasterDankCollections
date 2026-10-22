/** Wired into `npm run verify`: plaintext must never be tracked by git.
 *  Fails if git tracks any data/*.json, anything under public/data/ (the sealed
 *  vault and teaser are generated in CI, not committed), or any .env* file. */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function violations(files: string[]): string[] {
  return files.filter((f) =>
    /^data\/[^/]*\.json$/.test(f) ||
    f.startsWith("public/data/") ||
    /(^|\/)\.env/.test(f));
}

function main() {
  if (existsSync(".git")) {
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const bad = violations(tracked);
    if (bad.length) {
      console.error("guard: plaintext or secrets are tracked by git:\n  " + bad.join("\n  "));
      console.error("fix: git rm --cached <file>  (they are gitignored; keep data/inputs.enc)");
      process.exit(1);
    }
    console.log("guard: ok, no plaintext data or env files are tracked");
  } else {
    console.log("guard: not a git checkout, skipped");
  }
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
