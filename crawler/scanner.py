"""Filesystem + metadata scanner. Records what is there; interprets nothing.

The only judgement call this module makes is which files to *attempt* a metadata
read on -- and even that failing is recorded rather than hidden. Every file the
walk encounters ends up in the output, including video, images, playlists and
junk, because deciding what counts as music is the catalog's job, not the
crawler's.
"""
from __future__ import annotations

import json
import os
import platform
import sys
import time
from datetime import datetime, timezone

SCHEMA = "mdc-crawl/2"
TOOL_VERSION = "2.0.0"
CACHE_NAME = ".mdc-cache.json"

# Extensions we treat as library content. Audio is the point; video is kept
# because a video sitting among the tracks is a real anomaly worth cataloguing,
# not junk. Everything else is counted and summarised but not given a record.
VIDEO_EXTS = {".mp4", ".mkv", ".avi", ".webm", ".mov", ".wmv", ".m4v", ".flv"}

# The crawler's own footprint. Excluded so a library does not end up catalogued
# with the tool that catalogued it -- this is the crawler ignoring its own
# litter, not making judgements about the library.
def _own_files():
    names = {CACHE_NAME}
    try:
        names.add(os.path.basename(sys.executable).lower())
    except Exception:
        pass
    try:
        names.add(os.path.basename(os.path.abspath(__file__)).lower())
        names.add("dankcrawl.py")
    except Exception:
        pass
    return names


def _is_own_output(name: str) -> bool:
    n = name.lower()
    return n.startswith("mdc-crawl-") and n.endswith(".json")


# Extensions we bother handing to mutagen. A miss here costs one failed open,
# recorded as an error, so the list can stay generous.
AUDIO_EXTS = {
    ".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav",
    ".wma", ".ape", ".wv", ".mpc", ".aiff", ".aif", ".alac", ".m4b", ".mka",
}

# Tag frames holding binary blobs (cover art, arbitrary private data). Their
# *presence* is worth recording, their contents are not.
BINARY_TAG_PREFIXES = ("APIC", "covr", "PRIV", "GEOB", "MCDI", "metadata_block_picture")

MAX_TAG_VALUE = 400   # characters; longer values are truncated with a marker
MAX_TAG_VALUES = 16   # per key


def _longpath(p: str) -> str:
    """Windows caps paths at 260 chars unless prefixed. Event folders nest deep."""
    if os.name != "nt":
        return p
    pfx = '\\\\?\\'
    if p.startswith(pfx):
        return p
    p = os.path.abspath(p)
    if p.startswith('\\\\'):
        return pfx + "UNC" + '\\' + p[2:]
    return pfx + p


def _is_binary_tag(key: str) -> bool:
    k = str(key)
    return any(k.startswith(p) for p in BINARY_TAG_PREFIXES)


def stringify_tags(tags) -> dict:
    """Best-effort dump of every tag key present, whatever the container format.

    ID3, Vorbis comments and MP4 atoms all expose different shapes; rather than
    map them onto a curated vocabulary we stringify whatever is there and let
    the catalog decide what it recognises.
    """
    out = {}
    if tags is None:
        return out
    try:
        items = list(tags.items())
    except Exception:
        return out
    for key, val in items:
        skey = str(key)
        if _is_binary_tag(skey):
            out[skey] = ["<binary>"]
            continue
        try:
            if isinstance(val, list):
                raw = val
            else:
                raw = getattr(val, "text", None)
                if raw is None:
                    raw = [val]
            vals = []
            for v in list(raw)[:MAX_TAG_VALUES]:
                if isinstance(v, (bytes, bytearray)):
                    vals.append("<binary>")
                    continue
                s = str(v)
                vals.append(s if len(s) <= MAX_TAG_VALUE else s[:MAX_TAG_VALUE] + "…")
            out[skey] = vals
        except Exception:
            out[skey] = ["<unreadable>"]
    return out


def read_metadata(full_path: str):
    """Return (audio_props, raw_tags, easy_tags, error). Any may be empty/None."""
    try:
        from mutagen import File as MutagenFile
    except ImportError:
        return {}, {}, {}, "mutagen-missing"

    p = _longpath(full_path)
    audio, tags, easy = {}, {}, {}

    try:
        mf = MutagenFile(p)
    except Exception as e:
        return {}, {}, {}, f"{type(e).__name__}: {e}"[:200]

    if mf is None:
        return {}, {}, {}, "unrecognised-format"

    info = getattr(mf, "info", None)
    if info is not None:
        for src, dst in (("length", "dur"), ("bitrate", "br"), ("sample_rate", "sr"),
                         ("channels", "ch"), ("bits_per_sample", "bits")):
            v = getattr(info, src, None)
            if v:
                audio[dst] = round(v, 2) if dst == "dur" else v
        audio["codec"] = type(info).__name__

    tags = stringify_tags(getattr(mf, "tags", None))

    # Normalised view via mutagen's "easy" mapping, kept alongside -- not
    # instead of -- the raw dump above.
    try:
        mf2 = MutagenFile(p, easy=True)
        if mf2 is not None and mf2.tags:
            for k, v in mf2.tags.items():
                val = v[0] if isinstance(v, list) and v else v
                if val:
                    easy[str(k)] = str(val)[:MAX_TAG_VALUE]
    except Exception:
        pass

    return audio, tags, easy, None


def _rel_segments(root: str, full: str) -> list:
    rel = os.path.relpath(full, root)
    return [s for s in rel.replace("\\", "/").split("/") if s not in ("", ".")]


def enumerate_tree(root: str, skip_names: set):
    """First pass: cheap walk to learn the shape and give the progress bar a total.

    Returns (files, dirs) where files are (segments, full_path) and dirs are
    segment lists -- empty directories included, since an empty phase folder is
    itself a fact about the event.
    """
    files, dirs = [], []
    for dirpath, dirnames, filenames in os.walk(_longpath(root)):
        dirnames[:] = [d for d in dirnames if d not in skip_names]
        segs = _rel_segments(_longpath(root), dirpath)
        if segs:
            dirs.append(segs)
        for fn in filenames:
            if fn.lower() in skip_names or _is_own_output(fn):
                continue
            files.append((segs + [fn], os.path.join(dirpath, fn)))
    return files, dirs


def load_cache(root: str) -> dict:
    try:
        with open(os.path.join(root, CACHE_NAME), encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("schema") == SCHEMA:
            return data.get("entries", {})
    except Exception:
        pass
    return {}


def save_cache(root: str, entries: dict) -> None:
    try:
        tmp = os.path.join(root, CACHE_NAME + ".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"schema": SCHEMA, "entries": entries}, fh)
        os.replace(tmp, os.path.join(root, CACHE_NAME))
    except Exception:
        pass


def scan(root: str, progress=None, should_stop=None, use_cache: bool = True) -> dict:
    """Walk `root` and return the crawl document.

    `progress(done, total, current_path)` is called as files are read;
    `should_stop()` is polled so the GUI can cancel a long scan.
    """
    root = os.path.abspath(root)
    started = time.time()
    skip = {n.lower() for n in _own_files()}

    if progress:
        progress(0, 0, "Counting files…")

    all_files, all_dirs = enumerate_tree(root, skip)
    total = len(all_files)

    cache = load_cache(root) if use_cache else {}
    new_cache = {}
    out_files, errors = [], []
    excluded_by_ext, excluded_sample = {}, []
    cache_hits = 0
    stopped = False

    for i, (segs, full) in enumerate(all_files):
        if should_stop and should_stop():
            stopped = True
            break

        rec = {"p": segs}
        try:
            st = os.stat(_longpath(full))
            rec["sz"] = st.st_size
            rec["mt"] = int(st.st_mtime)
        except Exception as e:
            rec["err"] = f"stat: {type(e).__name__}"
            errors.append({"p": segs, "err": rec["err"]})
            out_files.append(rec)
            if progress:
                progress(i + 1, total, "/".join(segs))
            continue

        ext = os.path.splitext(segs[-1])[1].lower()
        rec["ext"] = ext

        if ext not in AUDIO_EXTS and ext not in VIDEO_EXTS:
            # Not library content. Counted and sampled so the exclusion is
            # visible in the output rather than silent, but given no record.
            excluded_by_ext[ext] = excluded_by_ext.get(ext, 0) + 1
            if len(excluded_sample) < 200:
                excluded_sample.append("/".join(segs))
            if progress:
                progress(i + 1, total, "/".join(segs))
            continue

        if ext in AUDIO_EXTS or ext in VIDEO_EXTS:
            key = "/".join(segs)
            hit = cache.get(key)
            if hit and hit.get("sz") == rec["sz"] and hit.get("mt") == rec["mt"]:
                cache_hits += 1
                meta = hit
            else:
                audio, tags, easy, err = read_metadata(full)
                meta = {"sz": rec["sz"], "mt": rec["mt"], "a": audio, "t": tags, "e": easy}
                if err:
                    meta["err"] = err
            new_cache[key] = meta
            if meta.get("a"):
                rec["a"] = meta["a"]
            if meta.get("t"):
                rec["t"] = meta["t"]
            if meta.get("e"):
                rec["e"] = meta["e"]
            if meta.get("err"):
                rec["err"] = meta["err"]
                errors.append({"p": segs, "err": meta["err"]})

        out_files.append(rec)
        if progress:
            progress(i + 1, total, "/".join(segs))

    if use_cache and not stopped:
        save_cache(root, new_cache)

    tagged = sum(1 for f in out_files if f.get("t") or f.get("e"))
    n_excluded = sum(excluded_by_ext.values())
    by_ext = {}
    for f in out_files:
        by_ext[f.get("ext", "")] = by_ext.get(f.get("ext", ""), 0) + 1

    return {
        "schema": SCHEMA,
        "tool_version": TOOL_VERSION,
        "scanned_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "root_name": os.path.basename(root.rstrip("/\\")) or root,
        "root_path": root,
        "machine": platform.node(),
        "elapsed_sec": round(time.time() - started, 1),
        "partial": stopped,
        "counts": {
            "media": len(out_files),
            "excluded": n_excluded,
            "seen": len(out_files) + n_excluded,
            "files": len(out_files),
            "dirs": len(all_dirs),
            "with_tags": tagged,
            "errors": len(errors),
            "cache_hits": cache_hits,
            "by_ext": dict(sorted(by_ext.items(), key=lambda kv: -kv[1])),
            "excluded_by_ext": dict(sorted(excluded_by_ext.items(),
                                           key=lambda kv: -kv[1])),
        },
        "excluded_sample": excluded_sample,
        "errors": errors[:500],
        "dirs": all_dirs,
        "files": out_files,
    }


def output_filename(root_name: str) -> str:
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    safe = "".join(c for c in root_name if c.isalnum() or c in "-_") or "library"
    return f"mdc-crawl-{safe}-{stamp}.json"
