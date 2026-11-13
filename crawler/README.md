# Crawler (DankCrawl)

A tkinter app, shipped as one `DankCrawl.exe`. Cloak, Check and Spotify share one selection bar (playlist folder, file list); Dig has its own folder. All four share one console. Every control has a tooltip (texts in `gui/help_texts.py`); rarely needed options sit under a collapsed "Advanced" on each tab.

```bash
python crawler/dankcrawl.py        # GUI
./crawler/build.ps1                # builds dist/DankCrawl.exe + dist/DankCrawl-friends/ + .zip
python -m unittest discover -s crawler/tests
```

| Tab | What it does |
|---|---|
| Cloak | Anonymises a **mirror copy** of the selection (originals never touched): completely anonymous / keep who & where / switcheroo. The quick integrity check always runs first and failing files are left out and listed (Advanced: a thorough check instead). Preview of names; `anonymised/` (share) and `record/` (private). |
| Check | Integrity check, Quick or Thorough (decodes every file); results table, saves a CSV report, marks the selection list. |
| Spotify | Three steps: sign in, find tracks (from the selection's real tags or a `record.csv`), create the playlist; uncertain matches get reviewed first. A setup wizard appears only if no Client ID ships with the build. |
| Dig (library scan) | The original scan: tags and audio facts into one JSON next to the app (no audio read or sent). Put the result in `data/` and run `npm run inputs:seal`. |

Selection: subfolders of the chosen folder are *phases* (alphabetical, natural order) while "Subfolders are phases" is ticked; files are in natural filename order; the list can be reordered (drag or Up/Down) and files unticked. Window size and divider are remembered in `%APPDATA%\DankCrawl\ui.json`.

Code layout: `common.py` holds the few helpers the engines share (long paths, natural sort, atomic writes, a scandir walker that cannot loop on junctions, extension sets); each engine stays importable on its own and loads heavy modules (miniaudio/numpy, difflib, http.server, urllib.request, webbrowser) only when first used, so start-up is fast. `workflow.py` is the GUI-free glue (scan, plan arguments, output-folder rules, record.csv loading, the cloak pipeline, `selftest`); `dankcrawl.py` is the entry point (CLI and `main()`); the window lives in the `gui/` package (shell, one module per tab, selection list, console, tooltips, shared `Context`); `widgets.py` has the title, progress bar and header strip; `banner.py` the console art. Tests never touch the real `%APPDATA%\DankCrawl` (`tests/_isolate.py`). Easter eggs exist; they are not documented here.

## CLI

```bash
python crawler/dankcrawl.py --cli <folder>        # scan -> mdc-crawl-*.json in the cwd (unchanged)
python crawler/dankcrawl.py cloak <folder> --mode true|kinda|switcheroo [--person P] [--phase X] [--seed N] \
                            [--out DIR] [--no-check] [--keep-failed] [--no-phases]
python crawler/dankcrawl.py check <folder> [--deep] [--report out.csv] [--workers N]
DankCrawl.exe --selftest [--log result.txt]       # exit 0/1
```

`cloak` defaults the output to `DankCloak <date>` next to the folder (it refuses anything inside it) and exits 1 if any file failed or could not be stripped. `--selftest` runs every module on synthetic files (cloak in 3 modes, quick and deep integrity with the bundled decoder, the Spotify matcher with a fake transport; no network): use it on the packaged exe. The exe is windowed, so pass `--log` or redirect stdout.

## Build and the friends package

`build.ps1` runs PyInstaller (`--collect-all miniaudio --hidden-import _cffi_backend` for the deep decoder; `--additional-hooks-dir pyi_hooks` because PyInstaller-contrib has a stock hook named `workflow` that crashes the build on our `workflow.py`), then assembles `dist/DankCrawl-friends/` (exe, an empty `spotify_client.json`, `README-friends.txt` from `friends/`) and zips it. `dist/` and `build/` are git-ignored.

To give it to friends: create the Spotify app once (the Spotify tab's wizard walks through it), put its Client ID in `friends/spotify_client.json` before building (or in the copy you send), and add each friend's Spotify email under User Management in the Spotify dashboard (dev-mode apps allow only a handful of users). Each friend signs in with their own account; tokens stay on their PC.

## Spotify

`spotify_link.py` (GUI-free, standard library) matches tracks on Spotify and creates a playlist in the signed-in user's account. Tests: `python -m unittest discover -s crawler/tests`.

- Auth: Authorization Code + PKCE, no client secret. Redirect URI is exactly `http://127.0.0.1:8765/callback` and must be registered in the Spotify developer dashboard; other ports are only usable if you register those URIs too (`SpotifyLink(ports=[8765, 8766])`).
- Client ID: argument, then env `DANKCRAWL_SPOTIFY_CLIENT_ID`, then `spotify_client.json` (`{"client_id": "..."}`) next to the exe. Otherwise `NeedsClientId`; `setup_instructions()` gives the steps.
- Tokens: `%APPDATA%\DankCrawl\spotify.json` (`~/.dankcrawl/spotify.json` elsewhere); `sign_out()` deletes it; a different client ID discards them.
- Endpoints (per the Feb 2026 migration guide): `POST /me/playlists`, `POST /playlists/{id}/items` (100 per call), `GET /search` (limit max 10), `GET /me`.
- Dev-mode apps: owner needs Premium and only a few allowlisted users (5 for new apps). Others get `NotAllowlisted`.

## Integrity check

`integrity.py` (GUI-free) checks that each audio file is complete and plays without breaks.
`check_file(path, deep=False)` never raises; `check_many` runs many (optionally threaded, stoppable; `progress` calls are serialised, with `done` strictly increasing, but may come from a worker thread).

- Quick pass: structure only (MP3 frame walk + Xing/Info/VBRI/TLEN duration, FLAC STREAMINFO + last frame,
  M4A atom tree + sample tables, WAV/AIFF chunk sizes, Ogg/Opus page CRCs + end-of-stream). Fast.
- Deep pass: full streamed decode. `miniaudio` (bundled) for MP3/FLAC/WAV/OGG-Vorbis; `ffmpeg` (on PATH or
  next to the exe) for M4A/AAC, Opus, APE, AIFF. Without a decoder for a format the verdict stays
  `engine='structure'` with a "deep check skipped" warning. ffmpeg runs show no console window.
- PyInstaller needs: `--collect-all miniaudio --hidden-import _cffi_backend` (miniaudio is a cffi module).
- Speed: the MP3 frame walk caches parsed headers (a CBR file has a handful of distinct ones); Ogg CRCs use zlib; one `stat` per file.
- Tests: `python -m unittest discover -s crawler/tests` (synthetic audio only).

## Anonymise engine (`cloak.py`, `wordbank.py`)

GUI-free. `build_plan(files, mode, ...)` -> `preview(plan)` -> `execute(plan, out_dir)` copies files to `<out>/anonymised/` (share this) with every tag stripped and verified, and writes `<out>/record/` (private: csv, m3u8, json with seed). Modes: `true`, `kinda`, `switcheroo`; see the `cloak.py` docstring. Each file is read once and written once: MP3 audio frames are copied straight into the output (no tag is ever written, except the fake artist/title tag of switcheroo, which carries no padding), other formats are copied while the source's audio hash is computed, and the copy is verified through the handle it was written with (re-opening a just-written file stalls on Windows). Tests: `python -m unittest discover -s crawler/tests`.
