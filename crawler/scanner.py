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

from common import AUDIO_EXTS, VIDEO_EXTS, atomic_write, long_path, walk_entries

SCHEMA = "mdc-crawl/2"
TOOL_VERSION = "2.0.0"
CACHE_NAME = ".mdc-cache.json"

# AUDIO_EXTS / VIDEO_EXTS (common.py): the extensions we treat as library content and hand to
# mutagen. Everything else is counted and summarised but not given a record.


def _own_files() -> set:
    """The crawler's own footprint (lower case). Excluded so a library does not end up catalogued
    with the tool that catalogued it -- this is the crawler ignoring its own litter, not making
    judgements about the library."""
    return {CACHE_NAME, os.path.basename(sys.executable).lower(),
            os.path.basename(os.path.abspath(__file__)).lower(), "dankcrawl.py"}


def _is_own_output(name: str) -> bool:
    n = name.lower()
    return n.startswith("mdc-crawl-") and n.endswith(".json")


# Tag frames holding binary blobs (cover art, arbitrary private data). Their
# *presence* is worth recording, their contents are not.
BINARY_TAG_PREFIXES = ("APIC", "covr", "PRIV", "GEOB", "MCDI", "metadata_block_picture")

MAX_TAG_VALUE = 400   # characters; longer values are truncated with a marker
MAX_TAG_VALUES = 16   # per key


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


_AUDIO_PROPS = (("length", "dur"), ("bitrate", "br"), ("sample_rate", "sr"),
                ("channels", "ch"), ("bits_per_sample", "bits"))


def _easy_tags(mf, p: str):
    """mutagen's normalised ('easy') tag view of the open file `mf`, parsing the file again only when
    there is no cheaper way. Formats whose easy view IS the raw tags (FLAC, Ogg, APE, ASF, ...) reuse
    them; MP3 wraps the already-parsed ID3 tags; everything else (MP4, ...) re-opens with easy=True."""
    from mutagen import File as MutagenFile
    from mutagen.id3 import ID3FileType
    from mutagen.mp3 import MP3
    from mutagen.mp4 import MP4
    from mutagen.trueaudio import TrueAudio
    if not isinstance(mf, (MP3, MP4, TrueAudio, ID3FileType)):
        return mf.tags
    if type(mf) is MP3:
        if mf.tags is None:
            return None
        try:
            from mutagen.easyid3 import EasyID3
            easy = EasyID3()
            easy._EasyID3__id3 = mf.tags   # EasyID3 is a thin view over an ID3 object
            return easy
        except Exception:   # a mutagen layout we do not know: take the slow, always-right way
            pass
    mf2 = MutagenFile(p, easy=True)
    return None if mf2 is None else mf2.tags


def read_metadata(full_path: str):
    """Return (audio_props, raw_tags, easy_tags, error). Any may be empty/None."""
    try:
        from mutagen import File as MutagenFile
    except ImportError:
        return {}, {}, {}, "mutagen-missing"

    p = long_path(full_path)
    audio, easy = {}, {}

    try:
        mf = MutagenFile(p)
    except Exception as e:   # mutagen raises many unrelated types on damaged files
        return {}, {}, {}, f"{type(e).__name__}: {e}"[:200]

    if mf is None:
        return {}, {}, {}, "unrecognised-format"

    info = getattr(mf, "info", None)
    if info is not None:
        for src, dst in _AUDIO_PROPS:
            v = getattr(info, src, None)
            if v:
                audio[dst] = round(v, 2) if dst == "dur" else v
        audio["codec"] = type(info).__name__

    tags = stringify_tags(getattr(mf, "tags", None))

    # Normalised view via mutagen's "easy" mapping, kept alongside -- not
    # instead of -- the raw dump above. Best effort: whatever was read before a failure stays.
    try:
        etags = _easy_tags(mf, p)
        if etags is not None:
            for k in list(etags.keys()):   # keys() is the expensive call for EasyID3: do it once
                v = etags[k]
                val = v[0] if isinstance(v, list) and v else v
                if val:
                    easy[str(k)] = str(val)[:MAX_TAG_VALUE]
    except Exception:
        pass

    return audio, tags, easy, None


def _walk(root: str, skip_names: set):
    """The walk behind enumerate_tree: ([(segments, full_path, DirEntry)], [dir segments])."""
    files, dirs = [], []
    top = long_path(root)
    below = {top: []}   # dirpath -> segments below root
    for dirpath, dirnames, filenames in walk_entries(top):
        segs = below.pop(dirpath)
        dirnames[:] = [d for d in dirnames if d.name.lower() not in skip_names]
        for d in dirnames:
            below[d.path] = segs + [d.name]
        if segs:
            dirs.append(segs)
        for e in filenames:
            n = e.name
            if n.lower() in skip_names or _is_own_output(n):
                continue
            files.append((segs + [n], e.path, e))
    return files, dirs


def enumerate_tree(root: str, skip_names: set):
    """First pass: cheap walk to learn the shape and give the progress bar a total.

    Returns (files, dirs) where files are (segments, full_path) and dirs are
    segment lists -- empty directories included, since an empty phase folder is
    itself a fact about the event.
    """
    files, dirs = _walk(root, skip_names)
    return [(segs, full) for segs, full, _ in files], dirs


def load_cache(root: str) -> dict:
    try:
        with open(os.path.join(root, CACHE_NAME), encoding="utf-8") as fh:
            data = json.load(fh)
        if data.get("schema") == SCHEMA:
            return data.get("entries", {})
    except (OSError, ValueError, AttributeError):
        pass   # no cache, or an unreadable one: start fresh
    return {}


def save_cache(root: str, entries: dict) -> None:
    """Best effort: a library on a read-only share simply is not cached."""
    try:
        atomic_write(os.path.join(root, CACHE_NAME),
                     lambda fh: json.dump({"schema": SCHEMA, "entries": entries}, fh),
                     encoding="utf-8")
    except OSError:
        pass


def scan(root: str, progress=None, should_stop=None, use_cache: bool = True) -> dict:
    """Walk `root` and return the crawl document.

    `progress(done, total, current_path)` is called as files are read, on the calling thread;
    `should_stop()` is polled so the GUI can cancel a long scan.
    """
    root = os.path.abspath(root)
    started = time.time()
    skip = _own_files()

    if progress:
        progress(0, 0, "Counting files…")

    all_files, all_dirs = _walk(root, skip)
    total = len(all_files)

    cache = load_cache(root) if use_cache else {}
    new_cache = {}
    out_files, errors = [], []
    excluded_by_ext, excluded_sample = {}, []
    by_ext = {}
    cache_hits = tagged = 0
    stopped = False

    for i, (segs, full, entry) in enumerate(all_files):
        if should_stop and should_stop():
            stopped = True
            break

        rec = {"p": segs}
        try:
            st = entry.stat()
            rec["sz"] = st.st_size
            rec["mt"] = int(st.st_mtime)
        except OSError as e:
            rec["err"] = f"stat: {type(e).__name__}"
            errors.append({"p": segs, "err": rec["err"]})
            out_files.append(rec)
            by_ext[""] = by_ext.get("", 0) + 1
        else:
            ext = os.path.splitext(segs[-1])[1].lower()
            rec["ext"] = ext
            if ext not in AUDIO_EXTS and ext not in VIDEO_EXTS:
                # Not library content. Counted and sampled so the exclusion is
                # visible in the output rather than silent, but given no record.
                excluded_by_ext[ext] = excluded_by_ext.get(ext, 0) + 1
                if len(excluded_sample) < 200:
                    excluded_sample.append("/".join(segs))
            else:
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
                for field in ("a", "t", "e", "err"):
                    if meta.get(field):
                        rec[field] = meta[field]
                if meta.get("err"):
                    errors.append({"p": segs, "err": meta["err"]})
                if rec.get("t") or rec.get("e"):
                    tagged += 1
                out_files.append(rec)
                by_ext[ext] = by_ext.get(ext, 0) + 1
        if progress:
            progress(i + 1, total, "/".join(segs))

    if use_cache and not stopped:
        save_cache(root, new_cache)

    n_excluded = sum(excluded_by_ext.values())
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
