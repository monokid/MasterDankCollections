"""DankCrawl glue: everything the GUI and the CLI share that is not drawing.

GUI-free on purpose, so it can be tested and so the packaged exe can prove itself
with --selftest. Nothing here touches the user's originals: scanning only lists
files, reading identities only opens them for reading, and the cloak pipeline
writes only into the output folder.
"""
from __future__ import annotations

import json
import os
import re
import struct
import time
from dataclasses import dataclass, field
from datetime import date

import cloak
import integrity
from common import (AUDIO_EXTS as _AUDIO_EXTS, atomic_write, is_within, long_path, natural_key, norm_path,
                    plain_path, split_hms, walk_entries)

AUDIO_EXTS = set(_AUDIO_EXTS)
MAX_SCAN_FILES = 20000          # a playlist folder, not a disk: stop before it takes minutes

# ------------------------------------------------------------------ small helpers


def human_duration(sec) -> str:
    """'3h12m', '12m05s', '45s'; '--' when unknown."""
    if sec is None or sec < 0:
        return "--"
    h, m, s = split_hms(sec)
    if h:
        return "%dh%02dm" % (h, m)
    if m:
        return "%dm%02ds" % (m, s)
    return "%ds" % s


def valid_client_id(s) -> bool:
    """A Spotify Client ID is 32 hex characters."""
    return bool(re.fullmatch(r"[0-9a-fA-F]{32}", (s or "").strip()))


def write_client_id(path: str, client_id: str) -> None:
    atomic_write(path, lambda f: json.dump({"client_id": client_id.strip()}, f), encoding="utf-8")


def default_playlist_name(person, folder, today=None) -> str:
    today = today or date.today()
    base = (person or "").strip() or (os.path.basename(os.path.normpath(folder)) if folder else "") or "DankCrawl"
    return "%s – %s" % (base, today.strftime("%Y-%m-%d"))


def parse_seed(text):
    """None for blank/'random'; else a non-negative int. Raises ValueError for junk."""
    t = (text or "").strip().lower()
    if t in ("", "random"):
        return None
    if not t.isdigit():
        raise ValueError("The seed must be a whole number, or the word random.")
    return int(t) % (2 ** 32)


# ------------------------------------------------------------------ settings


def settings_path() -> str:
    import spotify_link
    return os.path.join(os.path.dirname(spotify_link.token_path()), "ui.json")


def load_settings() -> dict:
    try:
        with open(settings_path(), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(d: dict) -> None:
    """Best effort: remembering the window size is never worth an error."""
    try:
        p = settings_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        atomic_write(p, lambda f: json.dump(d, f), encoding="utf-8")
    except (OSError, TypeError):
        pass


# ------------------------------------------------------------------ selection


@dataclass
class FileEntry:
    path: str
    name: str
    subfolder: str = ""          # first folder below the chosen one; "" = the chosen folder itself
    include: bool = True
    duration: float | None = None
    fmt: str = ""
    size: int = 0
    status: str | None = None    # integrity level after a Check: ok/warn/fail/unsupported


@dataclass
class Selection:
    folder: str
    entries: list = field(default_factory=list)
    subfolders: list = field(default_factory=list)   # subfolders that hold audio, in phase order
    non_audio: int = 0
    duplicates_removed: int = 0
    truncated: bool = False

    @property
    def has_subfolders(self) -> bool:
        return bool(self.subfolders)


def dedupe_paths(paths) -> tuple:
    """Drop repeats of the same real file (different spelling, case, links). -> (kept, removed)."""
    seen, kept, removed = set(), [], 0
    for p in paths:
        k = norm_path(p)
        if k in seen:
            removed += 1
            continue
        seen.add(k)
        kept.append(p)
    return kept, removed


def scan_selection(folder: str) -> Selection:
    """List the audio under `folder` in play order.

    Order: files directly in the folder (natural filename order), then each
    subfolder (alphabetical, natural) with its files in natural order of their
    path below it. Non-audio files are counted and ignored. Hidden folders are skipped.
    """
    folder = os.path.abspath(folder)
    sel = Selection(folder)
    found = []   # (subfolder, rel, full, size)
    below = {long_path(folder): []}   # dirpath -> folder names below the chosen one
    for dirpath, dirs, files in walk_entries(long_path(folder)):
        parts = below.pop(dirpath)
        dirs[:] = sorted((d for d in dirs if not d.name.startswith(".")), key=lambda d: natural_key(d.name))
        for d in dirs:
            below[d.path] = parts + [d.name]
        for e in files:
            if os.path.splitext(e.name)[1].lower() in AUDIO_EXTS:
                try:
                    size = e.stat().st_size
                except OSError:
                    size = 0
                found.append((parts[0] if parts else "", "/".join(parts + [e.name]), plain_path(e.path), size))
            else:
                sel.non_audio += 1
        if len(found) >= MAX_SCAN_FILES:
            sel.truncated = True
            break
    found.sort(key=lambda t: (t[0] != "", natural_key(t[0]), natural_key(t[1])))
    kept, removed = dedupe_paths([f[2] for f in found])
    sel.duplicates_removed = removed
    keep = set(kept)
    subs = []
    for sub, rel, full, size in found:
        if full not in keep:
            continue
        keep.discard(full)       # the first spelling wins
        ext = os.path.splitext(full)[1].lower()
        sel.entries.append(FileEntry(full, os.path.basename(full), sub, True, None,
                                     ext.lstrip(".").upper(), size))
        if sub and sub not in subs:
            subs.append(sub)
    sel.subfolders = subs
    return sel


def duplicate_groups(entries) -> list:
    """Groups of included files that look like the same track twice (same name and size)."""
    seen = {}
    for e in entries:
        if e.include:
            seen.setdefault((e.name.casefold(), e.size), []).append(e)
    return [g for g in seen.values() if len(g) > 1]


def read_duration(path: str):
    """Seconds, or None. Never raises."""
    try:
        from mutagen import File
        mf = File(long_path(path))
        ln = getattr(getattr(mf, "info", None), "length", None)
        return float(ln) if ln else None
    except Exception:
        return None


def summary_text(entries) -> str:
    inc = [e for e in entries if e.include]
    n = len(inc)
    folders = len({e.subfolder for e in inc})
    known = [e.duration for e in inc if e.duration is not None]
    total = human_duration(sum(known)) if known else "--"
    if known and len(known) < n:
        total += "+"
    word = "audio file" if n == 1 else "audio files"
    out = "%d %s · %d %s · %s" % (n, word, folders, "folder" if folders == 1 else "folders", total)
    if n < len(entries):
        out += "  (%d left out)" % (len(entries) - n)
    return out


# ------------------------------------------------------------------ cloak glue


def selected_files(entries) -> list:
    return [e.path for e in entries if e.include]


def plan_args(entries, mode, person=None, phase=None, seed=None, use_phases=True) -> dict:
    """Keyword arguments for cloak.build_plan, in the user's chosen play order.

    With `use_phases` each file's subfolder becomes its phase (and the free-text
    Phase field is ignored); files directly in the folder then have no phase.
    """
    inc = [e for e in entries if e.include]
    phases = {e.path: e.subfolder for e in inc if e.subfolder} if use_phases else {}
    from_folders = bool(phases)
    return {
        "files": [e.path for e in inc],
        "mode": mode,
        "person": (person or "").strip() or None,
        "phase": None if from_folders else ((phase or "").strip() or None),
        "seed": seed,
        "phases": phases or None,
    }


def default_output_dir(folder: str, today=None, exists=os.path.exists) -> str:
    """'DankCloak <date>' next to the playlist folder, never inside it."""
    today = today or date.today()
    folder = os.path.abspath(folder)
    parent = os.path.dirname(folder)
    if parent == folder:                      # a drive root has no 'next to'
        parent = os.path.expanduser("~")
    base = os.path.join(parent, "DankCloak " + today.strftime("%Y-%m-%d"))
    cand, n = base, 1
    while exists(cand):
        n += 1
        cand = "%s (%d)" % (base, n)
    return cand


def output_problem(out_dir: str, source_roots) -> str | None:
    """Plain-language reason the output folder is unacceptable, or None."""
    if not (out_dir or "").strip():
        return "Choose an output folder first."
    nout = norm_path(out_dir)
    for r in source_roots:
        if is_within(nout, norm_path(r)):
            return ("The output folder is inside the playlist folder. Pick somewhere else so the "
                    "originals and the copies never mix.")
    if os.path.isfile(out_dir):
        return "The output folder path is a file."
    return None


def example_name(mode, person=None, phase=None, ext=".mp3", from_folders=False) -> str:
    """What a cloaked name will look like, for the live example line."""
    ext = ext if ext.startswith(".") else "." + ext
    if mode == "true":
        return "anon_482913" + ext
    if mode == "kinda":
        who = cloak.sanitize_part(person, 60) or "Sam"
        ph = "Peak" if from_folders else cloak.sanitize_part(phase, 60)
        return "_".join(["anon", who] + ([ph] if ph else []) + ["03"]) + ext
    return "Carousel Satyr - Griffin the Gecko" + ext


@dataclass
class CloakRun:
    result: object = None                           # cloak.CloakResult, None if stopped before cloaking
    verdicts: list = field(default_factory=list)
    left_out: list = field(default_factory=list)    # (path, [reasons])
    plan: object = None
    seed: int | None = None
    stopped: bool = False


def run_cloak(entries, mode, out_dir, *, person=None, phase=None, seed=None, use_phases=True,
              check_first=True, drop_failed=True, source_root=None, progress=None, stop=None,
              workers=2) -> CloakRun:
    """Optional integrity check (quick + deep), then plan, copy, strip, verify.

    progress(stage, done, total, name) with stage in 'check' | 'plan' | 'cloak'.
    Raises ValueError for an unusable output folder or nothing left to cloak.
    """
    roots = [source_root] if source_root else []
    bad = output_problem(out_dir, roots)
    if bad:
        raise ValueError(bad)
    run = CloakRun()
    inc = [e for e in entries if e.include]
    if check_first and inc:
        verdicts = integrity.check_many(
            [e.path for e in inc], deep=True, workers=workers, stop=stop,
            progress=(lambda d, t, n: progress("check", d, t, n)) if progress else None)
        run.verdicts = verdicts
        if stop is not None and stop.is_set():
            run.stopped = True
            return run
        level = {v.path: v for v in verdicts}
        for e in inc:
            v = level.get(e.path)
            e.status = v.level if v else e.status
        if drop_failed:
            keep = []
            for e in inc:
                v = level.get(e.path)
                if v is not None and v.level == "fail":
                    run.left_out.append((e.path, list(v.reasons)))
                else:
                    keep.append(e)
            inc = keep
    if not inc:
        raise ValueError("Nothing left to cloak: every file was left out or none are ticked.")
    if progress:
        progress("plan", 0, len(inc), "")
    kw = plan_args(inc, mode, person, phase, seed, use_phases)
    plan = cloak.build_plan(**kw)
    run.plan, run.seed = plan, plan.seed
    run.result = cloak.execute(
        plan, out_dir, stop=stop, source_roots=roots,
        progress=(lambda d, t, n: progress("cloak", d, t, n)) if progress else None)
    run.stopped = bool(stop is not None and stop.is_set())
    return run


def _latest_record_json(record_dir: str) -> str | None:
    best, best_n = None, -1
    try:
        names = os.listdir(record_dir)
    except OSError:
        return None
    for name in names:
        m = re.fullmatch(r"record(?:-(\d+))?\.json", name)
        if m:
            n = int(m.group(1) or 1)
            if n > best_n:
                best, best_n = os.path.join(record_dir, name), n
    return best


def unstrippable_copies(result) -> list:
    """Absolute paths, inside anonymised/, of copies whose tags could NOT be removed."""
    path = _latest_record_json(result.record_dir)
    if not path or not result.unstrippable:
        return []
    try:
        with open(path, encoding="utf-8") as f:
            items = json.load(f).get("items", [])
    except (OSError, ValueError):
        return []
    anon = os.path.join(result.out_dir, "anonymised")
    return [os.path.join(anon, *it["new_name"].split("/")) for it in items
            if str(it.get("detail", "")).startswith("UNSTRIPPABLE") and it.get("new_name")]


def delete_copies(paths, anon_dir: str) -> int:
    """Delete files, but only ones that really live inside `anon_dir`. -> number deleted."""
    root = norm_path(anon_dir)
    n = 0
    for p in paths:
        key = norm_path(p)
        if is_within(key, root) and key != root:
            try:
                os.remove(long_path(p))
                n += 1
            except OSError:
                pass
    return n


def format_cloak_summary(run: CloakRun) -> str:
    r = run.result
    if r is None:
        return "Stopped before anything was copied."
    lines = ["Copied %d  ·  verified %d  ·  failed %d  ·  unstrippable %d"
             % (r.copied, r.verified, len(r.failed), len(r.unstrippable))]
    if run.left_out:
        lines.append("Left out because they failed the integrity check: %d" % len(run.left_out))
    if run.stopped:
        lines.append("You stopped it early; the record covers only what was done.")
    if run.seed is not None:
        lines.append("Seed %d (kept in the private record, so the run can be repeated)." % run.seed)
    return "\n".join(lines)


def format_check_counts(summary: dict) -> str:
    lb = summary["by_level"]
    return "OK %d  ·  warnings %d  ·  failed %d  ·  not checked %d" % (
        lb["ok"], lb["warn"], lb["fail"], lb["unsupported"])


# ------------------------------------------------------------------ Spotify glue

_ANON_NAME = re.compile(r"^anon(?:[_ ]|$)", re.I)


def looks_anonymised(ident) -> bool:
    """A file already cloaked by this tool: no artist and a title starting 'anon_'."""
    return not ident.artist and bool(_ANON_NAME.match(ident.title or ""))


def queries_from_entries(entries) -> tuple:
    """Real artist/title for each included file. -> (queries, number_skipped_as_anonymised)."""
    import spotify_link
    out, anon = [], 0
    for e in entries:
        if not e.include:
            continue
        ident = cloak.read_identity(e.path)
        if looks_anonymised(ident) or not (ident.title or ident.artist):
            anon += 1
            continue
        out.append(spotify_link.Query(ident.artist, ident.title, ident.album,
                                      ident.duration, ref=e.name))
    return out, anon


def load_record_csv(path: str) -> tuple:
    """Queries from a record.csv written by the cloak step. -> (queries, rows_skipped)."""
    import csv
    import spotify_link
    with open(path, newline="", encoding="utf-8-sig") as f:
        rd = csv.DictReader(f)
        names = {(n or "").strip().lower(): n for n in (rd.fieldnames or [])}
        if "artist" not in names and "title" not in names:
            raise ValueError("This does not look like a record.csv: it has no artist or title column.")

        def cell(row, key):
            n = names.get(key)
            return ((row.get(n) if n else "") or "").strip()

        out, skipped = [], 0
        for i, row in enumerate(rd, 2):
            artist, title = cell(row, "artist"), cell(row, "title")
            if not artist and not title:
                skipped += 1
                continue
            try:
                dur = float(cell(row, "duration_sec")) if cell(row, "duration_sec") else None
            except ValueError:
                dur = None
            out.append(spotify_link.Query(artist or None, title or None, cell(row, "album") or None,
                                          dur, ref=cell(row, "new_name") or "row %d" % i))
    return out, skipped


# ------------------------------------------------------------------ synthetic audio + selftest


def _pack(fields):
    v = n = 0
    for val, w in fields:
        v = (v << w) | (val & ((1 << w) - 1))
        n += w
    return v.to_bytes(n // 8, "big")


def synth_mp3_bytes(seconds=2.0, seed=1) -> bytes:
    """MPEG-1 Layer III mono 44.1 kHz of quiet noise: tiny, and the decoder accepts it."""
    import random
    rng = random.Random(seed)
    nframes = int(seconds * 44100 / 1152)
    frames, acc = [], 0
    for _ in range(nframes):
        acc += 18432000 % 44100
        pad = 0
        if acc >= 44100:
            acc -= 44100
            pad = 1
        length = 18432000 // 44100 + pad
        head = bytes([0xFF, 0xFB, (9 << 4) | (pad << 1), 0xC0])
        side = [(0, 9), (0, 5), (0, 4)]
        for _g in range(2):
            side += [(1000, 12), (100, 9), (150, 8), (0, 4), (0, 1), (5, 5), (5, 5), (5, 5),
                     (4, 4), (3, 3), (0, 1), (0, 1), (0, 1)]
        frames.append(head + _pack(side) + bytes(rng.getrandbits(8) for _ in range(length - 21)))
    hdr = bytearray(frames[0])
    hdr[4:] = bytes(len(hdr) - 4)
    hdr[21:33] = b"Info" + struct.pack(">II", 1, nframes)
    return bytes(hdr) + b"".join(frames)


def synth_wav(path: str, seconds=1.5, rate=8000) -> None:
    import math
    import wave
    n = int(seconds * rate)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(struct.pack("<%dh" % n, *[int(9000 * math.sin(i / 5)) for i in range(n)]))


def synth_mp3(path: str, artist="Test Artist", title="Test Song") -> None:
    with open(path, "wb") as f:
        f.write(synth_mp3_bytes())
    from mutagen.id3 import ID3, TIT2, TPE1
    t = ID3()
    t.add(TPE1(encoding=3, text=[artist]))
    t.add(TIT2(encoding=3, text=[title]))
    t.save(path, v2_version=3)


def selftest(say=print) -> bool:
    """Exercise every engine against synthetic files. For checking the PACKAGED exe."""
    ok_all = [True]

    def step(name, fn):
        try:
            detail = fn()
            say("PASS  %s%s" % (name, ("  (" + detail + ")") if detail else ""))
        except Exception as e:   # noqa: BLE001 - the point is to report any failure
            ok_all[0] = False
            say("FAIL  %s: %s: %s" % (name, type(e).__name__, e))

    def imports():
        import importlib
        mods = ["scanner", "cloak", "wordbank", "integrity", "spotify_link", "workflow",
                "banner", "widgets", "mutagen", "miniaudio", "tkinter"]
        for m in mods:
            importlib.import_module(m)
        return "%d modules" % len(mods)

    def art():
        import banner
        n = 0
        for name in ("dig", "cloak", "check", "orbit", "success", "failure"):
            n += len(banner.pieces(name))
        return "%d banner rows" % n

    import tempfile
    tmp = tempfile.mkdtemp(prefix="dankcrawl-selftest-")
    src = os.path.join(tmp, "src")
    os.makedirs(src)
    wav = os.path.join(src, "01 Wave Rider - Sine Song.wav")
    mp3 = os.path.join(src, "02 Test Artist - Test Song.mp3")

    def make():
        synth_wav(wav)
        synth_mp3(mp3)
        sel = scan_selection(src)
        assert len(sel.entries) == 2, "scan found %d files" % len(sel.entries)
        return "2 files"

    def do_cloak(mode):
        def go():
            sel = scan_selection(src)
            out = os.path.join(tmp, "out-" + mode)
            run = run_cloak(sel.entries, mode, out, person="Pat", phase="Peak", seed=4242,
                            use_phases=False, check_first=False, source_root=src)
            r = run.result
            assert r.copied == 2 and r.verified == 2 and not r.failed and not r.unstrippable, \
                "copied=%d verified=%d failed=%s unstrippable=%s" % (
                    r.copied, r.verified, r.failed, r.unstrippable)
            names = sorted(os.listdir(os.path.join(out, "anonymised")))
            return ", ".join(names)
        return go

    def quick():
        vs = integrity.check_many([wav, mp3], deep=False)
        assert [v.level for v in vs] == ["ok", "ok"], [(v.level, v.reasons) for v in vs]
        return "2 ok"

    def deep():
        vs = integrity.check_many([wav, mp3], deep=True)
        assert [v.level for v in vs] == ["ok", "ok"], [(v.level, v.reasons) for v in vs]
        assert all(v.engine == "miniaudio" for v in vs), [v.engine for v in vs]
        return "decoder: miniaudio"

    def spotify():
        import spotify_link as sl
        cid = "0123456789abcdef0123456789abcdef"
        tok = os.path.join(tmp, "spotify.json")
        with open(tok, "w", encoding="utf-8") as f:
            json.dump({"client_id": cid, "access_token": "x", "refresh_token": "y",
                       "expires_at": time.time() + 3600}, f)
        calls = []

        def transport(method, url, headers, body, timeout=30):
            calls.append((method, url.split("?")[0]))
            if "/search" in url:
                data = {"tracks": {"items": [{
                    "id": "t1", "uri": "spotify:track:t1", "name": "Test Song",
                    "artists": [{"name": "Test Artist"}], "album": {"name": "A"},
                    "duration_ms": 2000, "external_urls": {"spotify": "https://example.invalid/t1"}}]}}
            elif url.endswith("/me/playlists"):
                data = {"id": "p1", "external_urls": {"spotify": "https://example.invalid/p1"}}
            else:
                data = {}
            return 200, {}, json.dumps(data).encode()

        link = sl.SpotifyLink(client_id=cid, transport=transport, token_file=tok,
                              open_browser=lambda u: None, sleep=lambda s: None)
        ms = link.find([sl.Query("Test Artist", "Test Song", None, 2.0)])
        assert ms and ms[0].status == "matched", ms
        made = link.create_playlist("selftest", ms)
        assert made["added"] == 1, made
        return "fake transport, %d calls, no network" % len(calls)

    step("import every module", imports)
    step("art banners compose", art)
    step("make synthetic WAV + MP3", make)
    for m in ("true", "kinda", "switcheroo"):
        step("cloak %s" % m, do_cloak(m))
    step("integrity quick", quick)
    step("integrity deep (bundled decoder)", deep)
    step("spotify matcher + playlist (fake transport)", spotify)
    say("ALL PASSED" if ok_all[0] else "SOME STEPS FAILED")
    import shutil
    shutil.rmtree(tmp, ignore_errors=True)
    return ok_all[0]
