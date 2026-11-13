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

import csv
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import struct
import time
from dataclasses import dataclass, field
from datetime import datetime

import wordbank

MODES = ("true", "kinda", "switcheroo")
MAX_FAKE_NAME = 120
UNSAFE_CHARS = '<>:"/\\|?*'
_RESERVED = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}

FUNCTION_WORDS = {
    "and", "or", "the", "a", "an", "of", "in", "on", "to", "for", "with", "vs", "feat", "ft", "x",
    "en", "de", "het", "een", "et", "le", "la", "les", "und", "der", "die", "das",
}

MP3_EXTS = {".mp3"}
FLAC_EXTS = {".flac"}
MP4_EXTS = {".m4a", ".mp4", ".m4b"}
WAV_EXTS = {".wav"}
AIFF_EXTS = {".aiff", ".aif"}
OGG_EXTS = {".ogg", ".oga", ".opus"}


# ----------------------------------------------------------------- helpers

def _lp(p: str) -> str:
    """Long-path form on Windows (260-char limit otherwise)."""
    if os.name != "nt":
        return p
    pfx = "\\\\?\\"
    if p.startswith(pfx):
        return p
    p = os.path.abspath(p)
    if p.startswith("\\\\"):
        return pfx + "UNC" + "\\" + p[2:]
    return pfx + p


def _norm(p: str) -> str:
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def _is_within(child: str, parent: str) -> bool:
    """True if child == parent or child is inside parent (both already normalised)."""
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives
        return False


def sanitize_part(s, maxlen: int | None = None) -> str:
    """Make a string safe as one Windows file-name component."""
    s = "" if s is None else str(s)
    s = "".join(c for c in s if c not in UNSAFE_CHARS and ord(c) >= 32)
    s = re.sub(r"\s+", " ", s).strip()
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
        except Exception:
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


def _from_filename(path: str):
    stem = os.path.splitext(os.path.basename(path))[0]
    stem = re.sub(r"^\s*\d{1,3}\s*[.\-_)]*\s+(?=\S)", "", stem)  # leading track number
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
    except Exception:
        pass
    try:
        fa, ft = _from_filename(path)
    except Exception:
        fa = ft = None
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
        if re.search(r"(s|x|z|ch|sh)$", w):
            return w + "es"
        if re.search(r"[^aeiou]y$", w):
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
        out = re.sub(r"\(\s*\)|\[\s*\]|\{\s*\}", "", out)
        out = re.sub(r"\s+", " ", out)
        out = out.strip(" -–—_.,;:&")
        return out.strip()


def _group_key(person, phase):
    return ((person or "").lower(), (phase or "").lower())


def build_plan(files, mode, person=None, phase=None, seed=None, folders=False, phases=None) -> Plan:
    """List order = play order. `phases` maps src path -> phase name (overrides `phase`)."""
    if mode not in MODES:
        raise ValueError(f"unknown mode {mode!r}; expected one of {MODES}")
    if seed is None:
        seed = secrets.randbits(32)
    rng = random.Random(seed)

    seen, srcs = set(), []
    for f in files:
        f = str(f)
        k = _norm(f)
        if k in seen:
            continue
        seen.add(k)
        srcs.append(f)

    idents = [read_identity(f) for f in srcs]
    plan = Plan()
    plan.seed = seed
    spers = sanitize_part(person, 60) or None

    def phase_of(src):
        p = None
        if phases:
            p = phases.get(src)
            if p is None:
                nk = _norm(src)
                for k, v in phases.items():
                    if _norm(k) == nk:
                        p = v
                        break
        if p is None:
            p = phase
        return sanitize_part(p, 60) or None

    used = set()

    def unique(rel: str) -> str:
        base, ext = os.path.splitext(rel)
        cand, n = rel, 1
        while cand.lower() in used:
            n += 1
            cand = f"{base}_{n}{ext}"
        used.add(cand.lower())
        return cand

    if mode == "true":
        digits = 6
        while 9 * 10 ** (digits - 1) < len(srcs) * 2:
            digits += 1
        nums = rng.sample(range(10 ** (digits - 1), 10 ** digits), len(srcs))
        for src, ident, num in zip(srcs, idents, nums):
            rel = unique(f"anon_{num}{ident.ext}")
            plan.append(PlanItem(src, rel, mode, None, None, num, ident))
    elif mode == "kinda":
        phs = [phase_of(s) for s in srcs]
        counts = {}
        for ph in phs:
            counts[_group_key(spers, ph)] = counts.get(_group_key(spers, ph), 0) + 1
        running = {}
        for src, ident, ph in zip(srcs, idents, phs):
            g = _group_key(spers, ph)
            running[g] = running.get(g, 0) + 1
            n = running[g]
            width = max(2, len(str(counts[g])))
            parts = ["anon"] + [x for x in (spers, ph) if x] + [str(n).zfill(width)]
            name = "_".join(parts) + ident.ext
            rel = "/".join([x for x in (spers, ph) if x] + [name]) if folders else name
            plan.append(PlanItem(src, unique(rel), mode, spers, ph, n, ident))
    else:
        sw = _Switcher(rng)
        names = set()
        for i, (src, ident) in enumerate(zip(srcs, idents), 1):
            stem = os.path.splitext(os.path.basename(src))[0]
            fa = sw.text(ident.artist) if ident.artist else ""
            ft = sw.text(ident.title or stem)
            if not ft and not fa:
                ft = " ".join(rng.sample(wordbank.NOUNS, 2)).title()
            n = 1
            while True:
                title = ft if n == 1 else f"{ft} {_roman(n)}".strip()
                stem_out = f"{fa} - {title}" if fa and title else (title or fa)
                fname = sanitize_part(stem_out, MAX_FAKE_NAME) or "anon"
                if fname.lower() not in names:
                    break
                n += 1
            names.add(fname.lower())
            plan.append(PlanItem(src, unique(fname + ident.ext), mode, None, None, i, ident,
                                 fa or None, title or None))
    return plan


def preview(plan) -> list:
    return [(os.path.basename(p.src), p.dst_rel) for p in plan]


# ------------------------------------------------------------ audio payload

def _hash_ranges(path: str, ranges) -> str:
    h = hashlib.sha1()
    with open(_lp(path), "rb") as f:
        for start, end in ranges:
            f.seek(start)
            left = end - start
            while left > 0:
                b = f.read(min(1 << 20, left))
                if not b:
                    break
                h.update(b)
                left -= len(b)
    return h.hexdigest()


def _mp3_range(path: str):
    with open(_lp(path), "rb") as f:
        size = os.fstat(f.fileno()).st_size
        start = 0
        while True:
            f.seek(start)
            h = f.read(10)
            if len(h) == 10 and h[:3] == b"ID3":
                sz = ((h[6] & 0x7F) << 21) | ((h[7] & 0x7F) << 14) | ((h[8] & 0x7F) << 7) | (h[9] & 0x7F)
                start += 10 + sz + (10 if h[5] & 0x10 else 0)
            else:
                break
        end = size
        if end - start >= 128:
            f.seek(end - 128)
            if f.read(3) == b"TAG":
                end -= 128
        for _ in range(2):
            if end - start >= 32:
                f.seek(end - 32)
                ft = f.read(32)
                if ft[:8] == b"APETAGEX":
                    tsize, flags = struct.unpack("<I", ft[12:16])[0], struct.unpack("<I", ft[20:24])[0]
                    end -= tsize + (32 if flags & (1 << 31) else 0)
                    continue
            break
    return [(start, max(start, end))]


def _flac_range(path: str):
    with open(_lp(path), "rb") as f:
        size = os.fstat(f.fileno()).st_size
        pos = 0
        h = f.read(10)
        if h[:3] == b"ID3":
            pos = 10 + (((h[6] & 0x7F) << 21) | ((h[7] & 0x7F) << 14) | ((h[8] & 0x7F) << 7) | (h[9] & 0x7F))
        f.seek(pos)
        if f.read(4) != b"fLaC":
            raise ValueError("not a FLAC stream")
        pos += 4
        while True:
            f.seek(pos)
            bh = f.read(4)
            if len(bh) < 4:
                raise ValueError("truncated FLAC metadata")
            last = bh[0] & 0x80
            ln = int.from_bytes(bh[1:4], "big")
            pos += 4 + ln
            if last:
                break
    return [(pos, size)]


def _chunk_walk(path: str, big: bool):
    """Yield (id, data_offset, size) for the top-level chunks of RIFF/WAVE or FORM/AIFF."""
    fmt = ">I" if big else "<I"
    with open(_lp(path), "rb") as f:
        fsize = os.fstat(f.fileno()).st_size
        h = f.read(12)
        if len(h) < 12 or h[:4] not in (b"FORM", b"RIFF"):
            raise ValueError("not a RIFF/FORM container")
        pos = 12
        while pos + 8 <= fsize:
            f.seek(pos)
            cid = f.read(4)
            sz = struct.unpack(fmt, f.read(4))[0]
            if pos + 8 + sz > fsize:
                sz = fsize - pos - 8
            yield cid, pos + 8, sz
            pos += 8 + sz + (sz & 1)


def _mp4_range(path: str):
    out = []
    with open(_lp(path), "rb") as f:
        fsize = os.fstat(f.fileno()).st_size
        pos = 0
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


def _ogg_payload(path: str):
    from mutagen.ogg import OggPage
    pages = []
    with open(_lp(path), "rb") as f:
        while True:
            try:
                pages.append(OggPage(f))
            except Exception:
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


def audio_payload_hash(path: str, ext: str):
    """Hash of the audio data only (tags/metadata excluded); None if not computable."""
    ext = ext.lower()
    if ext in MP3_EXTS:
        return _hash_ranges(path, _mp3_range(path))
    if ext in FLAC_EXTS:
        return _hash_ranges(path, _flac_range(path))
    if ext in MP4_EXTS:
        return _hash_ranges(path, _mp4_range(path))
    if ext in WAV_EXTS or ext in AIFF_EXTS:
        big = ext in AIFF_EXTS
        want = b"SSND" if big else b"data"
        return _hash_ranges(path, [(o, o + s) for c, o, s in _chunk_walk(path, big) if c == want])
    if ext in OGG_EXTS:
        return _ogg_payload(path)
    return None


# ------------------------------------------------------------------ strip

def is_strippable(ext: str) -> bool:
    ext = ext.lower()
    return ext in (MP3_EXTS | FLAC_EXTS | MP4_EXTS | WAV_EXTS | AIFF_EXTS | OGG_EXTS)


def _rewrite_chunks(path: str, big: bool, keep: set):
    tmp = path + ".rw"
    chunks = [(c, o, s) for c, o, s in _chunk_walk(path, big) if c in keep]
    if not chunks:
        raise ValueError("no audio chunks found")
    with open(_lp(path), "rb") as src:
        head = src.read(12)
        with open(_lp(tmp), "wb") as dst:
            dst.write(b"\0" * 12)
            total = 4
            for c, o, s in chunks:
                dst.write(c + struct.pack(">I" if big else "<I", s))
                src.seek(o)
                left = s
                while left > 0:
                    b = src.read(min(1 << 20, left))
                    if not b:
                        raise ValueError("truncated chunk")
                    dst.write(b)
                    left -= len(b)
                if s & 1:
                    dst.write(b"\0")
                total += 8 + s + (s & 1)
            dst.seek(0)
            dst.write(head[:4] + struct.pack(">I" if big else "<I", total) + head[8:12])
    os.replace(_lp(tmp), _lp(path))


_WAV_KEEP = {b"fmt ", b"data", b"fact"}
_AIFF_KEEP = {b"COMM", b"SSND", b"FVER"}


def strip_file(path: str, ext: str, fake_artist=None, fake_title=None) -> None:
    """Strip every tag from `path` in place (callers pass a COPY). Raises on failure."""
    ext = ext.lower()
    fake = bool(fake_artist or fake_title)
    p = _lp(path)
    if ext in MP3_EXTS:
        from mutagen import apev2
        from mutagen.id3 import ID3, TIT2, TPE1
        from mutagen.id3 import delete as id3_delete
        for _ in range(3):
            id3_delete(p, delete_v1=True, delete_v2=True)
            apev2.delete(p)
        if fake:
            t = ID3()
            if fake_artist:
                t.add(TPE1(encoding=3, text=[fake_artist]))
            if fake_title:
                t.add(TIT2(encoding=3, text=[fake_title]))
            t.save(p, v1=0, v2_version=3)
    elif ext in FLAC_EXTS:
        from mutagen.flac import FLAC, SeekTable, StreamInfo, VCFLACDict
        f = FLAC(p)
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
        f.save(deleteid3=True)
    elif ext in MP4_EXTS:
        from mutagen.mp4 import MP4
        f = MP4(p)
        f.delete()
        if fake:
            f = MP4(p)
            if f.tags is None:
                f.add_tags()
            if fake_artist:
                f.tags["\xa9ART"] = [fake_artist]
            if fake_title:
                f.tags["\xa9nam"] = [fake_title]
            f.save()
    elif ext in WAV_EXTS:
        _rewrite_chunks(path, False, _WAV_KEEP)
        if fake:
            from mutagen.id3 import TIT2, TPE1
            from mutagen.wave import WAVE
            f = WAVE(p)
            f.add_tags()
            if fake_artist:
                f.tags.add(TPE1(encoding=3, text=[fake_artist]))
            if fake_title:
                f.tags.add(TIT2(encoding=3, text=[fake_title]))
            f.save()
    elif ext in AIFF_EXTS:
        _rewrite_chunks(path, True, _AIFF_KEEP)
        if fake:
            from mutagen.aiff import AIFF
            from mutagen.id3 import TIT2, TPE1
            f = AIFF(p)
            f.add_tags()
            if fake_artist:
                f.tags.add(TPE1(encoding=3, text=[fake_artist]))
            if fake_title:
                f.tags.add(TIT2(encoding=3, text=[fake_title]))
            f.save()
    elif ext in OGG_EXTS:
        from mutagen import File as MutagenFile
        f = MutagenFile(p)
        if f is None or f.tags is None:
            raise ValueError("unrecognised Ogg stream")
        f.tags.clear()
        try:
            f.tags.vendor = ""
        except Exception:
            pass
        if fake_artist:
            f.tags["artist"] = [fake_artist]
        if fake_title:
            f.tags["title"] = [fake_title]
        f.save()
    else:
        raise ValueError(f"no stripper for {ext}")


def _allowed_keys(fake_artist, fake_title):
    keys = set()
    if fake_artist:
        keys |= {"tpe1", "artist", "\xa9art"}
    if fake_title:
        keys |= {"tit2", "title", "\xa9nam"}
    return keys


def verify_stripped(src: str, dst: str, ext: str, fake_artist=None, fake_title=None):
    """Re-open the copy: no tag keys beyond the allowed fakes, audio unchanged.

    Returns (ok, detail, audio_check) where audio_check is 'payload' or 'duration'.
    """
    ext = ext.lower()
    from mutagen import File as MutagenFile
    allowed = _allowed_keys(fake_artist, fake_title)
    fake = bool(allowed)
    problems = []

    # raw container checks
    if ext in MP3_EXTS:
        with open(_lp(dst), "rb") as f:
            data_head = f.read(3)
            f.seek(0, 2)
            size = f.tell()
            tail = b""
            if size >= 128:
                f.seek(size - 128)
                tail = f.read(3)
            f.seek(max(0, size - 32))
            ape = f.read(8)
        if data_head == b"ID3" and not fake:
            problems.append("ID3v2 header present")
        if tail == b"TAG":
            problems.append("ID3v1 present")
        if ape == b"APETAGEX":
            problems.append("APEv2 present")
    elif ext in WAV_EXTS or ext in AIFF_EXTS:
        ok_ids = (_WAV_KEEP if ext in WAV_EXTS else _AIFF_KEEP) | ({b"id3 ", b"ID3 "} if fake else set())
        for cid, _, _ in _chunk_walk(dst, ext in AIFF_EXTS):
            if cid not in ok_ids:
                problems.append(f"leftover chunk {cid!r}")

    # tag keys as mutagen sees them
    mf = MutagenFile(_lp(dst))
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
                if k.lower() in ("tpe1", "artist", "\xa9art") and fake_artist not in _vals(tags[k]):
                    problems.append("fake artist not in tags")
                if k.lower() in ("tit2", "title", "\xa9nam") and fake_title not in _vals(tags[k]):
                    problems.append("fake title not in tags")

    # audio untouched
    audio_check = "duration"
    try:
        a, b = audio_payload_hash(src, ext), audio_payload_hash(dst, ext)
        if a is not None:
            audio_check = "payload"
            if a != b:
                problems.append("audio payload differs")
    except Exception as e:
        problems.append(f"payload check failed: {e}")
    try:
        # Mutagen estimates MP3 length from file size (trailing tags skew it by ms), so the
        # duration check only decides when there is no payload hash to compare.
        ms = MutagenFile(_lp(src)) if audio_check == "duration" else None
        if ms is not None and mf is not None:
            ds, dd = ms.info.length, mf.info.length
            if abs(ds - dd) > 0.001:
                problems.append(f"duration changed {ds:.3f}->{dd:.3f}")
    except Exception:
        pass
    return (not problems), "; ".join(problems), audio_check


def _vals(v):
    if hasattr(v, "text"):
        v = v.text
    if not isinstance(v, (list, tuple)):
        v = [v]
    return [str(x) for x in v]


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


def _rm(path: str):
    try:
        os.remove(_lp(path))
    except OSError:
        pass


def execute(plan, out_dir, progress=None, stop=None, source_roots=None) -> CloakResult:
    """Copy + strip + verify every plan item into <out_dir>/anonymised, write <out_dir>/record.

    `source_roots` (optional) are extra folders (e.g. the scanned root) that out_dir
    must not be inside of. Raises ValueError if out_dir is, or is inside, a source folder.
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
            shutil.copyfile(_lp(it.src), _lp(tmp))  # bytes only: no timestamps, no ACLs/streams
            ext = it.identity.ext or os.path.splitext(it.src)[1].lower()
            status = {"stripped": False, "verified": False, "audio_check": None, "detail": ""}
            if is_strippable(ext):
                fa = it.fake_artist if it.mode == "switcheroo" else None
                ft = it.fake_title if it.mode == "switcheroo" else None
                strip_file(tmp, ext, fa, ft)
                ok, detail, how = verify_stripped(it.src, tmp, ext, fa, ft)
                if not ok:
                    raise RuntimeError("verification failed: " + detail)
                status.update(stripped=True, verified=True, audio_check=how)
            else:
                status["detail"] = "UNSTRIPPABLE: copied as-is, tags remain"
            os.replace(_lp(tmp), _lp(final))
            tmp = None
            os.utime(_lp(final), (now, now))
            res.copied += 1
            if status["verified"]:
                res.verified += 1
            else:
                res.unstrippable.append(it.src)
            done_items.append((it, os.path.relpath(final, anon_dir).replace("\\", "/"), status))
        except Exception as e:
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
