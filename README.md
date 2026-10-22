# Master Dank Collections

A private, password-protected archive of music playlists, with search, a timeline and insights.

Vite + React + TypeScript, static, hosted on GitHub Pages. The data never lives in the repo in plain
text: it is sealed with AES-GCM, and the site opens it in the browser with a password.

## Develop

```bash
npm ci
# put MDC_PASSWORDS and MDC_INPUT_KEY in .env.local (never committed)
npm run inputs:open   # unseal data/inputs.enc into data/
npm run data          # build and seal the catalogue
npm run dev
```

After changing anything in `data/`, run `npm run inputs:seal` and commit `data/inputs.enc`.

| Script | Does |
|---|---|
| `npm run verify` | type-check, tests and the no-plaintext guard |
| `npm run build` | production build (fails if plaintext would ship) |
| `npm run spotify -- file.csv` | import playlist exports |
| `npm run enrich` | look songs up in public music databases |
| `npm run weather` | fetch historical weather for the dates |

`crawler/` scans a music folder; `launcher/` wraps the build for non-developers.
