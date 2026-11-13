"""Anonymise engine: make a mirror copy of chosen audio files with every identifying
tag removed and the file names anonymised. Pure Python, no GUI.

Originals are never modified or deleted: each file is copied byte-for-byte to a
temp name inside the output folder, stripped and verified THERE, then renamed.
Audio is never re-encoded; verification compares the audio payload (MP3: bytes
between the tag areas; FLAC: bytes after the metadata blocks; WAV/AIFF: the
data chunk; MP4: the mdat atoms; Ogg Opus/Vorbis: the audio packets) between
source and copy, and durations to 1 ms.

Modes
  true       anon_<random number>.<ext>          unique, seedable, order independent
  kinda      anon_<Person>_<Phase>_<NN>.<ext>    my reading of the requested
             'anonsongandtitle_person_phase(if applicable)': the song and title are
             replaced by the literal word 'anon', then person, then phase (both
             underscore-joined, phase and its underscore dropped when there is none),
             then a running number inside each (person, phase) group, in list order.
             folders=True additionally puts files in <Person>/<Phase>/.
  switcheroo <fake artist> - <fake title>.<ext>  content words replaced by words from
             wordbank.py; the fake artist/title are also written into the copy's tags.

Switcheroo word rules (see _Switcher)
  * a 'word' is a run of letters/digits (apostrophes inside allowed); everything
    else (spaces, punctuation, brackets, '&') is kept as it was.
  * function words are kept: and or the a an of in on to for with vs feat ft x
    en de het een et le la les und der die das.
  * digits-only words are dropped (and empty brackets / dangling separators tidied).
  * every other word is replaced: a verb pool if it ends in 'ing' (gerund pool) or
    'ed' (len>3) or is in wordbank.COMMON_VERBS, else the noun pool. Non-Latin and
    mixed letter/digit words are replaced too (as nouns).
  * capitalisation is copied (UPPER / Title / lower); a noun that looks plural
    (ends in 's', not 'ss', len>3) gets its fake pluralised, and 'Star'/'Stars'
    share one fake base.
  * same real word -> same fake word within a run; fakes are not reused until the
    pool is exhausted; a fake never equals the original word; two files never get
    the same fake name (a roman numeral is appended to the title).
Everything is seeded: same files + same seed -> same output.

Stripping failures are NOT shipped: if a supported format cannot be stripped or
verified the copy is deleted and the file goes to `failed`. Only formats with no
handler at all are copied as-is and listed in `unstrippable` (their tags remain!).
Source files that mutagen/this module cannot parse as the claimed format fail the same way.
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import re
import secrets
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime

import wordbank
from common import (AIFF_EXTS, FLAC_EXTS, MP3_EXTS, MP4_EXTS, OGG_EXTS, WAV_EXTS, is_within as _is_within,
                    long_path as _lp, norm_path as _norm)

MODES = ("true", "kinda", "switcheroo")
MAX_FAKE_NAME = 120
COPY_BLOCK = 1 << 20            # bytes per read/write when copying and hashing
UNSAFE_CHARS = '<>:"/' + chr(92) + '|?*'
_UNSAFE_RE = re.compile('[' + re.escape(UNSAFE_CHARS) + chr(0) + '-' + chr(31) + ']')   # also control characters
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}

FUNCTION_WORDS = {
    "and", "or", "the", "a", "an", "of", "in", "on", "to", "for", "with", "vs", "feat", "ft", "x",
    "en", "de", "het", "een", "et", "le", "la", "les", "und", "der", "die", "das",
}

_SPACES = re.compile(r"\s+")


# ----------------------------------------------------------------- helpers

def sanitize_part(s, maxlen: int | None = None) -> str:
    """Make a string safe as one Windows file-name component."""
    s = "" if s is None else str(s)
    s = _UNSAFE_RE.sub("", s)
    s = _SPACES.sub(" ", s).strip()
    if maxlen and len(s) > maxlen:
        s = s[:maxlen]
    s = s.rstrip(". ").strip()
    if s.lower() in _RESERVED:
        s = "_" + s
    return s


def _roman(n: int) -> str:
    out = ""
    for v, r in ((1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
                 (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I")):
        while n >= v:
            out += r
            n -= v
    return out


# ---------------------------------------------------------------- identity

@dataclass
class Identity:
    path: str
    artist: str | None
    title: str | None
    album: str | None
    duration: float | None
    ext: str


def _first(tags, keys):
    for k in keys:
        try:
            v = tags.get(k)
        except Exception:   # tag containers differ wildly; a key that cannot be read is just absent
            continue
        if v is None:
            continue
        if hasattr(v, "text"):
            v = v.text
        if isinstance(v, (list, tuple)):
            v = v[0] if v else None
        if v is None or isinstance(v, (bytes, bytearray)):
            continue
        s = str(v).strip()
        if s:
            return s
    return None


_TRACK_NO = re.compile(r"^\s*\d{1,3}\s*[.\-_)]*\s+(?=\S)")   # leading track number


def _from_filename(path: str):
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = _TRACK_NO.sub("", stem)
    if " - " in stem:
        a, t = stem.split(" - ", 1)
        a, t = a.strip(), t.strip()
        if a and t:
            return a, t
    return None, stem.strip() or None


def read_identity(path) -> Identity:
    """Tags first, filename fallback ('Artist - Title'). Never raises."""
    path = str(path)
    ext = os.path.splitext(path)[1].lower()
    artist = title = album = None
    duration = None
    try:
        from mutagen import File as MutagenFile
        mf = MutagenFile(_lp(path))
        if mf is not None:
            info = getattr(mf, "info", None)
            ln = getattr(info, "length", None)
            if ln:
                duration = float(ln)
            tags = getattr(mf, "tags", None)
            if tags is not None:
                artist = _first(tags, ("TPE1", "artist", "\xa9ART", "ARTIST", "TPE2", "albumartist", "aART"))
                title = _first(tags, ("TIT2", "title", "\xa9nam", "TITLE"))
                album = _first(tags, ("TALB", "album", "\xa9alb", "ALBUM"))
    except Exception:   # never-raise contract: any unreadable file simply has no tags
        pass
    fa, ft = _from_filename(path)
    if not title:
        title = ft
        if not artist:
            artist = fa
    return Identity(path, artist, title, album, duration, ext)


# -------------------------------------------------------------------- plan

@dataclass
class PlanItem:
    src: str
    dst_rel: str
    mode: str
    person: str | None
    phase: str | None
    number: int
    identity: Identity
    fake_artist: str | None = None
    fake_title: str | None = None


class Plan(list):
    """A list of PlanItem that also remembers the seed (needed to reproduce a run)."""
    seed: int | None = None


class _Switcher:
    WORD = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")
    _EMPTY_BRACKETS = re.compile(r"\(\s*\)|\[\s*\]|\{\s*\}")
    _ES_ENDING = re.compile(r"(s|x|z|ch|sh)$")
    _CONSONANT_Y = re.compile(r"[^aeiou]y$")

    def __init__(self, rng: random.Random):
        self.rng = rng
        self.pools = {}
        self.pos = {}
        self.used = {}
        self.map = {}
        for kind, words in (("noun", wordbank.NOUNS),
                            ("verb", wordbank.VERBS_BASE),
                            ("ing", wordbank.VERBS_ING)):
            pool = list(words)
            rng.shuffle(pool)
            self.pools[kind] = pool
            self.pos[kind] = 0
            self.used[kind] = set()

    @staticmethod
    def _kind(lw: str) -> str:
        if len(lw) > 4 and lw.endswith("ing"):
            return "ing"
        if (len(lw) > 3 and lw.endswith("ed")) or lw in wordbank.COMMON_VERBS:
            return "verb"
        return "noun"

    @staticmethod
    def _plural(w: str) -> str:
        if _Switcher._ES_ENDING.search(w):
            return w + "es"
        if _Switcher._CONSONANT_Y.search(w):
            return w[:-1] + "ies"
        return w + "s"

    @staticmethod
    def _case(fake: str, orig: str) -> str:
        letters = [c for c in orig if c.isalpha() and c.lower() != c.upper()]
        if len(letters) > 1 and all(c.isupper() for c in letters):
            return fake.upper()
        if letters and letters[0].isupper():
            return fake.capitalize()
        return fake.lower()

    def word(self, orig: str) -> str:
        lw = orig.lower()
        kind = self._kind(lw)
        plural = (kind == "noun" and len(lw) > 3 and lw.endswith("s") and not lw.endswith("ss")
                  and lw.isascii())
        key = (kind, lw[:-1] if plural else lw)
        base = self.map.get(key)
        if base is None:
            base = self._draw(kind, lw, plural)
            self.map[key] = base
        out = self._plural(base) if plural else base
        return self._case(out, orig)

    def _draw(self, kind: str, lw: str, plural: bool) -> str:
        pool, used = self.pools[kind], self.used[kind]
        n = len(pool)
        for _ in range(n * 2):
            cand = pool[self.pos[kind] % n]
            self.pos[kind] += 1
            if cand in used and len(used) < n:
                continue
            final = self._plural(cand) if plural else cand
            if cand == lw or final == lw:
                continue
            used.add(cand)
            return cand
        return pool[0] if pool[0] != lw else pool[1]

    def text(self, s: str) -> str:
        def rep(m):
            w = m.group(0)
            if w.lower() in FUNCTION_WORDS:
                return w
            if w.isdigit():
                return ""
            return self.word(w)
        out = self.WORD.sub(rep, s)
        out = self._EMPTY_BRACKETS.sub("", out)
        out = _SPACES.sub(" ", out)
        out = out.strip(" -–—_.,;:&")
        return out.strip()


def _group_key(person, phase):
    return ((person or "").lower(), (phase or "").lower())


class _UniqueNames:
    """Hands out relative names that never repeat, compared case-insensitively (Windows)."""

    def __init__(self):
        self.used = set()

    def __call__(self, rel: str) -> str:
        base, ext = os.path.splitext(rel)
        cand, n = rel, 1
        while cand.lower() in self.used:
            n += 1
            cand = f"{base}_{n}{ext}"
        self.used.add(cand.lower())
        return cand


def _dedupe_sources(files) -> list:
    seen, srcs = set(), []
    for f in files:
        f = str(f)
        k = _norm(f)
        if k not in seen:
            seen.add(k)
            srcs.append(f)
    return srcs


def _plan_true(srcs, idents, rng, plan, unique):
    digits = 6
    while 9 * 10 ** (digits - 1) < len(srcs) * 2:
        digits += 1
    nums = rng.sample(range(10 ** (digits - 1), 10 ** digits), len(srcs))
    for src, ident, num in zip(srcs, idents, nums):
        rel = unique(f"anon_{num}{ident.ext}")
        plan.append(PlanItem(src, rel, "true", None, None, num, ident))


def _plan_kinda(srcs, idents, spers, phase_of, folders, plan, unique):
    phs = [phase_of(s) for s in srcs]
    counts = {}
    for ph in phs:
        g = _group_key(spers, ph)
        counts[g] = counts.get(g, 0) + 1
    running = {}
    for src, ident, ph in zip(srcs, idents, phs):
        g = _group_key(spers, ph)
        running[g] = running.get(g, 0) + 1
        n = running[g]
        width = max(2, len(str(counts[g])))
        parts = ["anon"] + [x for x in (spers, ph) if x] + [str(n).zfill(width)]
        name = "_".join(parts) + ident.ext
        rel = "/".join([x for x in (spers, ph) if x] + [name]) if folders else name
        plan.append(PlanItem(src, unique(rel), "kinda", spers, ph, n, ident))


def _plan_switcheroo(srcs, idents, rng, plan, unique):
    sw = _Switcher(rng)
    names = set()
    resume = {}   # (artist, title) -> last numeral tried: every smaller one is already taken
    for i, (src, ident) in enumerate(zip(srcs, idents), 1):
        stem = os.path.splitext(os.path.basename(src))[0]
        fa = sw.text(ident.artist) if ident.artist else ""
        ft = sw.text(ident.title or stem)
        if not ft and not fa:
            ft = " ".join(rng.sample(wordbank.NOUNS, 2)).title()
        n = resume.get((fa, ft), 1)
        while True:
            title = ft if n == 1 else f"{ft} {_roman(n)}".strip()
            stem_out = f"{fa} - {title}" if fa and title else (title or fa)
            fname = sanitize_part(stem_out, MAX_FAKE_NAME) or "anon"
            if fname.lower() not in names:
                break
            n += 1
        names.add(fname.lower())
        resume[(fa, ft)] = n
        plan.append(PlanItem(src, unique(fname + ident.ext), "switcheroo", None, None, i, ident,
                             fa or None, title or None))


def build_plan(files, mode, person=None, phase=None, seed=None, folders=False, phases=None) -> Plan:
    """List order = play order. `phases` maps src path -> phase name (overrides `phase`)."""
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
    if seed is None:
        seed = secrets.randbits(32)
    rng = random.Random(seed)

    srcs = _dedupe_sources(files)
    idents = [read_identity(f) for f in srcs]
    plan = Plan()
    plan.seed = seed
    unique = _UniqueNames()

    if mode == "true":
        _plan_true(srcs, idents, rng, plan, unique)
    elif mode == "kinda":
        by_norm = None   # the same lookup keyed by normalised path, built once and only if needed

        def phase_of(src):
            nonlocal by_norm
            p = phases.get(src) if phases else None
            if p is None and phases:
                if by_norm is None:
                    by_norm = {_norm(k): v for k, v in reversed(list(phases.items()))}
                p = by_norm.get(_norm(src))
            if p is None:
                p = phase
            return sanitize_part(p, 60) or None

        _plan_kinda(srcs, idents, sanitize_part(person, 60) or None, phase_of, folders, plan, unique)
    else:
        _plan_switcheroo(srcs, idents, rng, plan, unique)
    return plan


def preview(plan) -> list:
    return [(os.path.basename(p.src), p.dst_rel) for p in plan]


# ------------------------------------------------------------ audio payload
#
# The *_ranges(f, size) helpers take an OPEN binary file (so one open serves the container walk and
# the hashing) and return [(start, end)] byte ranges that hold audio only. The path-taking
# wrappers below them are the older, still-used entry points.

def _syncsafe(b) -> int:
    return ((b[0] & 0x7F) << 21) | ((b[1] & 0x7F) << 14) | ((b[2] & 0x7F) << 7) | (b[3] & 0x7F)


def _mp3_ranges(f, size: int):
    start = 0
    while True:      # stacked ID3v2 tags
        f.seek(start)
        h = f.read(10)
        if len(h) == 10 and h[:3] == b"ID3":
            start += 10 + _syncsafe(h[6:10]) + (10 if h[5] & 0x10 else 0)
        else:
            break
    end = size
    for _ in range(3):   # ID3v1 and APEv2 may follow each other in either order
        before = end
        if end - start >= 128:
            f.seek(end - 128)
            if f.read(3) == b"TAG":
                end -= 128
        if end - start >= 32:
            f.seek(end - 32)
            ft = f.read(32)
            if ft[:8] == b"APETAGEX":
                tsize, flags = struct.unpack("<I", ft[12:16])[0], struct.unpack("<I", ft[20:24])[0]
                end -= tsize + (32 if flags & (1 << 31) else 0)
        if end == before:
            break
    return [(start, max(start, end))]


def _flac_ranges(f, size: int):
    pos = 0
    h = f.read(10)
    if h[:3] == b"ID3":
        pos = 10 + _syncsafe(h[6:10])
    f.seek(pos)
    if f.read(4) != b"fLaC":
        raise ValueError("not a FLAC stream")
    pos += 4
    while True:
        f.seek(pos)
        bh = f.read(4)
        if len(bh) < 4:
            raise ValueError("truncated FLAC metadata")
        pos += 4 + int.from_bytes(bh[1:4], "big")
        if bh[0] & 0x80:   # last-metadata-block flag
            break
    return [(pos, size)]


def _chunks(f, fsize: int, big: bool) -> list:
    """[(id, data_offset, size)] for the top-level chunks of RIFF/WAVE (little endian) or FORM/AIFF."""
    fmt = ">I" if big else "<I"
    f.seek(0)
    h = f.read(12)
    if len(h) < 12 or h[:4] not in (b"FORM", b"RIFF"):
        raise ValueError("not a RIFF/FORM container")
    out, pos = [], 12
    while pos + 8 <= fsize:
        f.seek(pos)
        cid = f.read(4)
        sz = struct.unpack(fmt, f.read(4))[0]
        if pos + 8 + sz > fsize:
            sz = fsize - pos - 8
        out.append((cid, pos + 8, sz))
        pos += 8 + sz + (sz & 1)
    return out


def _mp4_ranges(f, fsize: int):
    out, pos = [], 0
    while pos + 8 <= fsize:
        f.seek(pos)
        sz, typ = struct.unpack(">I4s", f.read(8))
        hdr = 8
        if sz == 1:
            sz = struct.unpack(">Q", f.read(8))[0]
            hdr = 16
        elif sz == 0:
            sz = fsize - pos
        if sz < hdr:
            raise ValueError("bad atom size")
        if typ == b"mdat":
            out.append((pos + hdr, min(pos + sz, fsize)))
        pos += sz
    if not out:
        raise ValueError("no mdat atom")
    return out


def _payload_ranges(f, size: int, ext: str):
    """Audio byte ranges of an open file, or None when the format has no byte-range notion (Ogg)."""
    if ext in MP3_EXTS:
        return _mp3_ranges(f, size)
    if ext in FLAC_EXTS:
        return _flac_ranges(f, size)
    if ext in MP4_EXTS:
        return _mp4_ranges(f, size)
    if ext in WAV_EXTS or ext in AIFF_EXTS:
        big = ext in AIFF_EXTS
        want = b"SSND" if big else b"data"
        return [(o, o + s) for c, o, s in _chunks(f, size, big) if c == want]
    return None


def _open_raw(path: str):
    """Unbuffered read handle (we do our own big reads) and its size."""
    f = open(_lp(path), "rb", buffering=0)
    return f, os.fstat(f.fileno()).st_size


def _with_file(path: str, fn):
    f, size = _open_raw(path)
    with f:
        return fn(f, size)


def _mp3_range(path: str):
    return _with_file(path, _mp3_ranges)


def _flac_range(path: str):
    return _with_file(path, _flac_ranges)


def _mp4_range(path: str):
    return _with_file(path, _mp4_ranges)


def _chunk_walk(path: str, big: bool) -> list:
    return _with_file(path, lambda f, size: _chunks(f, size, big))


def _hash_ranges_f(f, ranges) -> str:
    h = hashlib.sha1()
    for start, end in ranges:
        f.seek(start)
        _copy_range(f, None, end - start, h)
    return h.hexdigest()


def _copy_range(fin, fout, count: int, h=None) -> None:
    """Move `count` bytes from fin's current position to fout (None = just hash), in big blocks,
    feeding `h` on the way. Stops quietly at end of file."""
    buf = bytearray(min(COPY_BLOCK, max(count, 1)))
    mv = memoryview(buf)
    while count > 0:
        n = fin.readinto(mv[:min(len(buf), count)])
        if not n:
            break
        if fout is not None:
            fout.write(mv[:n])
        if h is not None:
            h.update(mv[:n])
        count -= n


def _ogg_payload(f):
    from mutagen.ogg import OggPage
    f.seek(0)
    pages = []
    while True:
        try:
            pages.append(OggPage(f))
        except Exception:   # mutagen raises assorted errors at the end of the stream
            break
    pk = OggPage.to_packets(pages, strict=False) if pages else []
    if not pk:
        return None
    head = pk[0]
    skip = 2 if head.startswith(b"OpusHead") else 3 if head.startswith(b"\x01vorbis") else None
    if skip is None:
        return None
    h = hashlib.sha1()
    for p in pk[skip:]:
        h.update(p)
    return h.hexdigest()


def _payload_hash_f(f, size: int, ext: str):
    """sha1 of the audio data of an open file; None if the format has no way to tell."""
    if ext in OGG_EXTS:
        return _ogg_payload(f)
    ranges = _payload_ranges(f, size, ext)
    return None if ranges is None else _hash_ranges_f(f, ranges)


def audio_payload_hash(path: str, ext: str):
    """Hash of the audio data only (tags/metadata excluded); None if not computable."""
    return _with_file(path, lambda f, size: _payload_hash_f(f, size, ext.lower()))


# ------------------------------------------------------------------ copy + strip

def _copy_stream(fin, size: int, fout, ext: str):
    """Byte-for-byte copy of fin to fout in ONE read of the source; returns the audio-payload hash of
    the source (None for formats without byte ranges, e.g. Ogg). Bytes only: no timestamps, ACLs
    or streams come along."""
    ranges = _payload_ranges(fin, size, ext) if ext in _RANGED else None
    fin.seek(0)
    h = hashlib.sha1() if ranges is not None else None
    buf = bytearray(COPY_BLOCK)
    mv = memoryview(buf)
    pos = 0
    while True:
        n = fin.readinto(buf)
        if not n:
            break
        fout.write(mv[:n])
        if h is not None:
            lo, hi = pos, pos + n
            for s, e in ranges:
                a, b = max(s, lo), min(e, hi)
                if a < b:
                    h.update(mv[a - lo:b - lo])
        pos += n
    return None if h is None else h.hexdigest()


_RANGED = MP3_EXTS | FLAC_EXTS | MP4_EXTS | WAV_EXTS | AIFF_EXTS
_WAV_KEEP = {b"fmt ", b"data", b"fact"}
_AIFF_KEEP = {b"COMM", b"SSND", b"FVER"}


def is_strippable(ext: str) -> bool:
    ext = ext.lower()
    return ext in (MP3_EXTS | FLAC_EXTS | MP4_EXTS | WAV_EXTS | AIFF_EXTS | OGG_EXTS)


def _rm(path: str):
    try:
        os.remove(_lp(path))
    except OSError:
        pass


def _fake_id3(fake_artist, fake_title) -> bytes:
    """A bare ID3v2.3 tag (no padding) carrying only the fake artist/title."""
    from io import BytesIO
    from mutagen.id3 import ID3, TIT2, TPE1
    t = ID3()
    if fake_artist:
        t.add(TPE1(encoding=3, text=[fake_artist]))
    if fake_title:
        t.add(TIT2(encoding=3, text=[fake_title]))
    out = BytesIO()
    t.save(out, v1=0, v2_version=3, padding=lambda info: 0)
    return out.getvalue()


def _stream_stripped_mp3(fin, size: int, fout, fake_artist=None, fake_title=None) -> str:
    """Write only the audio frames of fin to fout (no ID3v2 / ID3v1 / APEv2), preceded by a fresh
    ID3v2.3 tag when fakes are given. One read of the source; returns the sha1 of the audio copied."""
    ((start, end),) = _mp3_ranges(fin, size)
    fin.seek(start)
    h = hashlib.sha1()
    if fake_artist or fake_title:
        fout.write(_fake_id3(fake_artist, fake_title))
    _copy_range(fin, fout, end - start, h)
    return h.hexdigest()


def _stream_stripped_chunks(fin, size: int, fout, big: bool) -> str:
    """Write the RIFF/WAVE or FORM/AIFF container with only its format and audio chunks (all other
    chunks, where tags live, are left behind). Returns the sha1 of the audio chunk(s) copied."""
    keep, want = (_AIFF_KEEP, b"SSND") if big else (_WAV_KEEP, b"data")
    pack = ">I" if big else "<I"
    chunks = [c for c in _chunks(fin, size, big) if c[0] in keep]
    if not chunks:
        raise ValueError("no audio chunks found")
    fin.seek(0)
    head = fin.read(12)
    h = hashlib.sha1()
    fout.write(b"\0" * 12)
    total = 4
    for cid, off, sz in chunks:
        fout.write(cid + struct.pack(pack, sz))
        fin.seek(off)
        before = fout.tell()
        _copy_range(fin, fout, sz, h if cid == want else None)
        if fout.tell() - before != sz:
            raise ValueError("truncated chunk")
        if sz & 1:
            fout.write(b"\0")
        total += 8 + sz + (sz & 1)
    fout.seek(0)
    fout.write(head[:4] + struct.pack(pack, total) + head[8:12])
    fout.seek(0, 2)
    return h.hexdigest()


def _load(cls, target):
    """cls(target) for a path or an open file; mutagen reads a file object from its CURRENT position."""
    if hasattr(target, "seek"):
        target.seek(0)
    return cls(target)


def _save(f, target, **kw) -> None:
    """f.save(target): a tag object loaded from a file object has no filename to save to by itself."""
    if hasattr(target, "seek"):
        target.seek(0)
    f.save(target, **kw)


def _strip_tags(target, ext: str, fake_artist=None, fake_title=None) -> None:
    """mutagen-driven stripping for FLAC, MP4 and Ogg, and the fake-tag step for WAV/AIFF (whose own
    chunks are dropped by _stream_stripped_chunks). `target` is a path or an open read/write file."""
    fake = bool(fake_artist or fake_title)
    if ext in FLAC_EXTS:
        from mutagen.flac import FLAC, SeekTable, StreamInfo, VCFLACDict
        f = _load(FLAC, target)
        f.clear_pictures()
        f.metadata_blocks[:] = [b for b in f.metadata_blocks if isinstance(b, (StreamInfo, SeekTable, VCFLACDict))]
        if f.tags is None:
            f.add_tags()
        f.tags.clear()
        f.tags.vendor = ""
        if fake_artist:
            f.tags["artist"] = [fake_artist]
        if fake_title:
            f.tags["title"] = [fake_title]
        _save(f, target, deleteid3=True)
    elif ext in MP4_EXTS:
        from mutagen.mp4 import MP4
        f = _load(MP4, target)
        if hasattr(target, "seek"):
            target.seek(0)
        f.delete(target)
        if fake:
            f = _load(MP4, target)
            if f.tags is None:
                f.add_tags()
            if fake_artist:
                f.tags["©ART"] = [fake_artist]
            if fake_title:
                f.tags["©nam"] = [fake_title]
            _save(f, target)
    elif ext in WAV_EXTS or ext in AIFF_EXTS:
        if fake:
            from mutagen.aiff import AIFF
            from mutagen.id3 import TIT2, TPE1
            from mutagen.wave import WAVE
            f = _load(WAVE if ext in WAV_EXTS else AIFF, target)
            f.add_tags()
            if fake_artist:
                f.tags.add(TPE1(encoding=3, text=[fake_artist]))
            if fake_title:
                f.tags.add(TIT2(encoding=3, text=[fake_title]))
            _save(f, target)
    elif ext in OGG_EXTS:
        from mutagen import File as MutagenFile
        f = _load(MutagenFile, target)
        if f is None or f.tags is None:
            raise ValueError("unrecognised Ogg stream")
        f.tags.clear()
        try:
            f.tags.vendor = ""
        except AttributeError:   # not every Ogg flavour carries a vendor string
            pass
        if fake_artist:
            f.tags["artist"] = [fake_artist]
        if fake_title:
            f.tags["title"] = [fake_title]
        _save(f, target)
    else:
        raise ValueError(f"no stripper for {ext}")


def strip_file(path: str, ext: str, fake_artist=None, fake_title=None) -> None:
    """Strip every tag from `path` in place (callers pass a COPY). Raises on failure."""
    ext = ext.lower()
    p = _lp(path)
    if ext in MP3_EXTS or ext in WAV_EXTS or ext in AIFF_EXTS:
        tmp = path + ".rw"
        try:
            fin, size = _open_raw(path)
            with fin, open(_lp(tmp), "wb") as fout:
                if ext in MP3_EXTS:
                    _stream_stripped_mp3(fin, size, fout, fake_artist, fake_title)
                else:
                    _stream_stripped_chunks(fin, size, fout, ext in AIFF_EXTS)
            os.replace(_lp(tmp), p)
        except BaseException:
            _rm(tmp)
            raise
        if ext not in MP3_EXTS:
            _strip_tags(p, ext, fake_artist, fake_title)
    else:
        _strip_tags(p, ext, fake_artist, fake_title)


def _allowed_keys(fake_artist, fake_title):
    keys = set()
    if fake_artist:
        keys |= {"tpe1", "artist", "\xa9art"}
    if fake_title:
        keys |= {"tit2", "title", "\xa9nam"}
    return keys


def _vals(v):
    if hasattr(v, "text"):
        v = v.text
    if not isinstance(v, (list, tuple)):
        v = [v]
    return [str(x) for x in v]


def _raw_container_problems(f, size: int, ext: str, fake: bool) -> list:
    """Leftover tag containers that mutagen would not report, read straight from the bytes."""
    problems = []
    if ext in MP3_EXTS:
        f.seek(0)
        head = f.read(3)
        tail = b""
        if size >= 128:
            f.seek(size - 128)
            tail = f.read(3)
        f.seek(max(0, size - 32))
        ape = f.read(8)
        if head == b"ID3" and not fake:
            problems.append("ID3v2 header present")
        if tail == b"TAG":
            problems.append("ID3v1 present")
        if ape == b"APETAGEX":
            problems.append("APEv2 present")
    elif ext in WAV_EXTS or ext in AIFF_EXTS:
        ok_ids = (_WAV_KEEP if ext in WAV_EXTS else _AIFF_KEEP) | ({b"id3 ", b"ID3 "} if fake else set())
        for cid, _, _ in _chunks(f, size, ext in AIFF_EXTS):
            if cid not in ok_ids:
                problems.append(f"leftover chunk {cid!r}")
    return problems


def _verify_open(src: str, dst_f, dst_name: str, ext: str, fake_artist, fake_title, src_hash):
    """verify_stripped on a copy that is already open (read access, seekable). Writing a file and
    then re-opening it is slow on Windows (the virus scanner holds the first re-open), so the
    pipeline verifies through the handle it wrote with."""
    from mutagen import File as MutagenFile
    allowed = _allowed_keys(fake_artist, fake_title)
    fake = bool(allowed)
    dst_f.flush()
    size = os.fstat(dst_f.fileno()).st_size

    problems = _raw_container_problems(dst_f, size, ext, fake)
    dst_hash, dst_err = None, None
    try:
        dst_hash = _payload_hash_f(dst_f, size, ext)
    except Exception as e:   # reported below as a failed check, never raised
        dst_err = e

    # tag keys as mutagen sees them
    dst_f.seek(0)
    mf = MutagenFile(dst_f)
    if mf is None:
        problems.append("copy not parseable after strip")
    else:
        tags = getattr(mf, "tags", None)
        keys = [] if tags is None else [str(k) for k in tags.keys()]
        extra = [k for k in keys if k.lower() not in allowed]
        if extra:
            problems.append(f"tag keys remain: {extra[:5]}")
        if getattr(mf, "pictures", None):
            problems.append("pictures remain")
        if tags is not None and fake:
            for k in keys:
                if k.lower() in ("tpe1", "artist", "©art") and fake_artist not in _vals(tags[k]):
                    problems.append("fake artist not in tags")
                if k.lower() in ("tit2", "title", "©nam") and fake_title not in _vals(tags[k]):
                    problems.append("fake title not in tags")

    # audio untouched
    audio_check = "duration"
    try:
        if dst_err is not None:
            raise dst_err
        a = src_hash if src_hash is not None else audio_payload_hash(src, ext)
        if a is not None:
            audio_check = "payload"
            if a != dst_hash:
                problems.append("audio payload differs")
    except Exception as e:   # unreadable/odd container: a failed check, not a crash
        problems.append(f"payload check failed: {e}")
    try:
        # Mutagen estimates MP3 length from file size (trailing tags skew it by ms), so the
        # duration check only decides when there is no payload hash to compare.
        ms = MutagenFile(_lp(src)) if audio_check == "duration" else None
        if ms is not None and mf is not None:
            ds, dd = ms.info.length, mf.info.length
            if abs(ds - dd) > 0.001:
                problems.append(f"duration changed {ds:.3f}->{dd:.3f}")
    except Exception:   # no duration on one side: nothing to compare
        pass
    return (not problems), "; ".join(problems), audio_check


def verify_stripped(src: str, dst: str, ext: str, fake_artist=None, fake_title=None, src_hash=None):
    """Re-open the copy: no tag keys beyond the allowed fakes, audio unchanged.

    `src_hash` is the source's audio-payload hash if the caller already has it; otherwise the
    source is read here.
    Returns (ok, detail, audio_check) where audio_check is 'payload' or 'duration'.
    """
    with open(_lp(dst), "rb") as f:
        return _verify_open(src, f, dst, ext.lower(), fake_artist, fake_title, src_hash)


# ----------------------------------------------------------------- execute

@dataclass
class CloakResult:
    copied: int = 0
    failed: list = field(default_factory=list)
    unstrippable: list = field(default_factory=list)
    verified: int = 0
    record_dir: str = ""
    out_dir: str = ""


_DO_NOT_SHARE = """DO NOT SHARE THIS FOLDER.

It maps every anonymised file back to the real artist, title and source path.
Share only the sibling folder 'anonymised'.

record.csv   number, new name, real artist/title/album, person, phase, fake names, source path
record.m3u8  the new names in play order, with the real 'artist - title' in #EXTINF
record.json  the full mapping plus the seed (reproduces the run)
"""


def _free_name(path: str) -> str:
    base, ext = os.path.splitext(path)
    cand, n = path, 1
    while os.path.exists(_lp(cand)):
        n += 1
        cand = f"{base}_{n}{ext}"
    return cand


def _copy_strip_verify(it: PlanItem, tmp: str) -> dict:
    """Copy it.src to tmp, strip and verify the copy THERE. Raises on any failure."""
    ext = it.identity.ext or os.path.splitext(it.src)[1].lower()
    status = {"stripped": False, "verified": False, "audio_check": None, "detail": ""}
    strippable = is_strippable(ext)
    fa = it.fake_artist if it.mode == "switcheroo" else None
    ft = it.fake_title if it.mode == "switcheroo" else None
    fin, size = _open_raw(it.src)
    with fin, open(_lp(tmp), "w+b") as fout:
        if not strippable:
            _copy_stream(fin, size, fout, ext)
            status["detail"] = "UNSTRIPPABLE: copied as-is, tags remain"
            return status
        if ext in MP3_EXTS:    # copy and strip in one pass: only the audio frames are ever written
            src_hash = _stream_stripped_mp3(fin, size, fout, fa, ft)
        elif ext in WAV_EXTS or ext in AIFF_EXTS:
            src_hash = _stream_stripped_chunks(fin, size, fout, ext in AIFF_EXTS)
            _strip_tags(fout, ext, fa, ft)
        else:
            src_hash = _copy_stream(fin, size, fout, ext)
            _strip_tags(fout, ext, fa, ft)
        ok, detail, how = _verify_open(it.src, fout, tmp, ext, fa, ft, src_hash)
    if not ok:
        raise RuntimeError("verification failed: " + detail)
    status.update(stripped=True, verified=True, audio_check=how)
    return status


def execute(plan, out_dir, progress=None, stop=None, source_roots=None) -> CloakResult:
    """Copy + strip + verify every plan item into <out_dir>/anonymised, write <out_dir>/record.

    `source_roots` (optional) are extra folders (e.g. the scanned root) that out_dir
    must not be inside of. Raises ValueError if out_dir is, or is inside, a source folder.
    `progress(done, total, name)` is called on the calling thread after each item; an exception
    it raises is swallowed (a broken progress display must not abort the copy).
    """
    out_dir = os.path.abspath(str(out_dir))
    nout = _norm(out_dir)
    roots = {_norm(os.path.dirname(os.path.abspath(p.src))) for p in plan}
    roots |= {_norm(r) for r in (source_roots or [])}
    for r in roots:
        if _is_within(nout, r):
            raise ValueError(f"output folder {out_dir!r} is inside the source folder {r!r}")
    anon_dir = os.path.join(out_dir, "anonymised")
    rec_dir = os.path.join(out_dir, "record")
    os.makedirs(_lp(anon_dir), exist_ok=True)
    os.makedirs(_lp(rec_dir), exist_ok=True)

    res = CloakResult(record_dir=rec_dir, out_dir=out_dir)
    done_items = []  # (item, final_rel, status dict)
    now = time.time()
    total = len(plan)
    for i, it in enumerate(plan):
        if stop is not None and stop.is_set():
            break
        tmp = None
        try:
            rel = it.dst_rel.replace("\\", "/")
            final = _free_name(os.path.join(anon_dir, *rel.split("/")))
            os.makedirs(_lp(os.path.dirname(final)), exist_ok=True)
            tmp = os.path.join(os.path.dirname(final), "~cloak_" + os.path.basename(final))
            status = _copy_strip_verify(it, tmp)
            os.replace(_lp(tmp), _lp(final))
            tmp = None
            os.utime(_lp(final), (now, now))
            res.copied += 1
            if status["verified"]:
                res.verified += 1
            else:
                res.unstrippable.append(it.src)
            done_items.append((it, os.path.relpath(final, anon_dir).replace("\\", "/"), status))
        except Exception as e:   # one bad file must not stop the run: it goes to `failed`
            res.failed.append((it.src, f"{type(e).__name__}: {e}"))
            if tmp:
                _rm(tmp)
        if progress:
            try:
                progress(i + 1, total, os.path.basename(it.src))
            except Exception:
                pass
    try:
        for d, _, _ in os.walk(anon_dir):
            os.utime(_lp(d), (now, now))
    except OSError:
        pass
    _write_record(plan, done_items, res, rec_dir, now)
    return res


def _write_record(plan, done_items, res: CloakResult, rec_dir: str, now: float):
    import csv
    n, suffix = 1, ""
    while os.path.exists(_lp(os.path.join(rec_dir, f"record{suffix}.csv"))):
        n += 1
        suffix = f"-{n}"
    cols = ["number", "new_name", "artist", "title", "album", "duration_sec", "person", "phase",
            "fake_artist", "fake_title", "source_path"]
    rows, items_json = [], []
    for it, rel, st in done_items:
        idn = it.identity
        dur = round(idn.duration, 2) if idn.duration else ""
        rows.append([it.number, rel, idn.artist or "", idn.title or "", idn.album or "", dur,
                     it.person or "", it.phase or "", it.fake_artist or "", it.fake_title or "",
                     it.src])
        items_json.append({"number": it.number, "new_name": rel, "mode": it.mode,
                           "artist": idn.artist, "title": idn.title, "album": idn.album,
                           "duration_sec": idn.duration, "person": it.person, "phase": it.phase,
                           "fake_artist": it.fake_artist, "fake_title": it.fake_title,
                           "source_path": it.src, **st})
    with open(_lp(os.path.join(rec_dir, f"record{suffix}.csv")), "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(cols)
        w.writerows(rows)
    with open(_lp(os.path.join(rec_dir, f"record{suffix}.m3u8")), "w", encoding="utf-8", newline="\n") as f:
        f.write("#EXTM3U\n")
        for it, rel, _ in done_items:
            idn = it.identity
            label = " - ".join(x for x in (idn.artist, idn.title) if x) or os.path.basename(it.src)
            f.write(f"#EXTINF:{int(round(idn.duration)) if idn.duration else -1},{label}\n{rel}\n")
    with open(_lp(os.path.join(rec_dir, f"record{suffix}.json")), "w", encoding="utf-8") as f:
        json.dump({"seed": getattr(plan, "seed", None),
                   "mode": plan[0].mode if len(plan) else None,
                   "created": datetime.fromtimestamp(now).isoformat(timespec="seconds"),
                   "planned": len(plan), "copied": res.copied,
                   "failed": res.failed, "unstrippable": res.unstrippable,
                   "items": items_json}, f, ensure_ascii=False, indent=1)
    note = os.path.join(rec_dir, "DO-NOT-SHARE.txt")
    if not os.path.exists(_lp(note)):
        with open(_lp(note), "w", encoding="utf-8") as f:
            f.write(_DO_NOT_SHARE)
