"""Audio integrity checker -- GUI-free. Is each file complete, and does it play without breaks?

Two passes:
  quick (deep=False): reads only structure (headers, frame walk, atom tree, page CRCs). No decoding.
  deep  (deep=True):  quick + a full streamed decode (miniaudio, or ffmpeg for formats it can't do).

Public API: Verdict, have_ffmpeg, deep_supported, check_file, check_many, summarise, write_report.
"""
from __future__ import annotations

import mmap
import os
import struct
import sys
import threading
import zlib
from dataclasses import dataclass, field

from common import is_regular_file, long_path, no_window_kwargs, split_hms

_ma = []   # [module or None] once tried; miniaudio drags in numpy (~0.25 s), so it loads on first deep use


def _miniaudio():
    """The miniaudio module, or None if it is not installed (the deep pass then falls back to ffmpeg)."""
    if not _ma:
        try:
            import miniaudio  # type: ignore
            _ma.append(miniaudio)
        except Exception:   # not installed, or its cffi backend is missing from a frozen build
            _ma.append(None)
    return _ma[0]


FFMPEG_TIMEOUT = 180          # seconds per file for the ffmpeg deep pass
MIN_AUDIO_BYTES = 1024        # anything smaller cannot hold real audio
SILENCE_TAIL_WARN_S = 10.0    # digital silence at the very end longer than this -> warning

MINIAUDIO_EXTS = {".mp3", ".flac", ".wav", ".ogg"}
FFMPEG_EXTS = {".mp3", ".flac", ".wav", ".ogg", ".oga", ".opus", ".m4a", ".m4b", ".mp4", ".aac",
               ".ape", ".aif", ".aiff", ".aifc", ".wma", ".wv"}
QUICK_EXTS = {".mp3", ".flac", ".m4a", ".m4b", ".mp4", ".wav", ".ogg", ".oga", ".opus",
              ".aif", ".aiff", ".aifc", ".ape"}


@dataclass
class Verdict:
    path: str
    ext: str
    level: str = "ok"                  # 'ok' | 'warn' | 'fail' | 'unsupported'
    reasons: list = field(default_factory=list)
    header_seconds: float | None = None   # duration the file itself claims (None = it doesn't say)
    decoded_seconds: float | None = None  # engine 'structure': audio found by walking; else: decoded
    error_at_seconds: float | None = None
    size_bytes: int = 0
    engine: str = "structure"          # 'structure' | 'miniaudio' | 'ffmpeg'


# ---------------------------------------------------------------- formatting helpers

def _t(sec: float) -> str:
    h, m, s = split_hms(sec)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _b(n: float) -> str:
    if n >= 1 << 20:
        return f"{n / (1 << 20):.1f} MB".replace(".0 MB", " MB")
    if n >= 1 << 10:
        return f"{n / (1 << 10):.0f} KB"
    return f"{int(n)} bytes"


def _tol(declared: float) -> float:
    return max(0.5, 0.01 * declared)


class _Q:
    """Accumulates findings of the quick pass."""

    def __init__(self):
        self.items = []             # (severity, message)
        self.header_seconds = None
        self.walked_seconds = None
        self.fatal = False          # not audio at all -> skip the deep pass

    def fail(self, msg, fatal=False):
        self.items.append(("fail", msg))
        self.fatal = self.fatal or fatal

    def warn(self, msg):
        self.items.append(("warn", msg))

    def level(self):
        sev = [s for s, _ in self.items]
        return "fail" if "fail" in sev else "warn" if "warn" in sev else "ok"

    def reasons(self):
        return [m for _, m in self.items]


def _early_msg(found: float, declared: float) -> str:
    return f"file ends early: the audio stops at {_t(found)} but the header says {_t(declared)}"


# ---------------------------------------------------------------- MP3

_BR_V1 = {1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
          2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
          3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]}
_BR_V2 = {1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
          2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
          3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]}
_SR = {3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000]}


_FREE = (0, 0, 0, 0, 0, 0, False, False, None)   # free-format marker; same shape as a header, never equals `first`
_MISS = object()
_HDR_CACHE = {}   # 4 header bytes -> parse result; a CBR file has only a handful of distinct headers


def _parse_header4(h: bytes):
    """Parse the 4 bytes of an MPEG audio frame header. Returns (length, samples, sr, version, layer,
    bitrate_kbps, mono, crc, (sr, version, layer)) or None if not a valid header, or _FREE for
    free-format."""
    b0, b1, b2, b3 = h
    if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
        return None
    ver = (b1 >> 3) & 3          # 3=MPEG1, 2=MPEG2, 0=MPEG2.5, 1=reserved
    layer_bits = (b1 >> 1) & 3   # 1=III, 2=II, 3=I, 0=reserved
    if ver == 1 or layer_bits == 0:
        return None
    layer = 4 - layer_bits
    bi, si = b2 >> 4, (b2 >> 2) & 3
    if bi == 15 or si == 3:
        return None
    sr = _SR[ver][si]
    mono = (b3 >> 6) == 3
    crc = (b1 & 1) == 0
    if bi == 0:
        return _FREE
    br = (_BR_V1 if ver == 3 else _BR_V2)[layer][bi]
    pad = (b2 >> 1) & 1
    if layer == 1:
        length = (12 * br * 1000 // sr + pad) * 4
        spf = 384
    elif layer == 2 or ver == 3:
        length = 144 * br * 1000 // sr + pad
        spf = 1152
    else:
        length = 72 * br * 1000 // sr + pad
        spf = 576
    return length, spf, sr, ver, layer, br, mono, crc, (sr, ver, layer)


def _mp3_header(buf, pos, end):
    """The parsed frame header at pos (see _parse_header4), or None if there are not 4 bytes before `end`."""
    if pos + 4 > end:
        return None
    k = bytes(buf[pos:pos + 4])
    h = _HDR_CACHE.get(k, _MISS)
    if h is _MISS:
        if len(_HDR_CACHE) > 8192:   # garbage data can produce endless distinct headers
            _HDR_CACHE.clear()
        h = _HDR_CACHE[k] = _parse_header4(k)
    return h


def _syncsafe(b):
    return (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3]


def _tlen_seconds(buf, start):
    """Seconds declared by an ID3v2 TLEN frame, or None. Best effort."""
    try:
        if buf[:3] != b"ID3" or start < 20:
            return None
        ver = buf[3]
        if ver not in (3, 4):
            return None
        flags = buf[5]
        pos = 10
        if flags & 0x40:  # extended header
            xs = _syncsafe(buf[10:14]) if ver == 4 else struct.unpack(">I", buf[10:14])[0] + 4
            pos += xs
        while pos + 10 <= start:
            fid = bytes(buf[pos:pos + 4])
            if fid[0] == 0:
                break
            size = _syncsafe(buf[pos + 4:pos + 8]) if ver == 4 else struct.unpack(">I", buf[pos + 4:pos + 8])[0]
            if size <= 0 or pos + 10 + size > start:
                break
            if fid == b"TLEN":
                raw = bytes(buf[pos + 11:pos + 10 + size])
                txt = raw.decode("utf-16" if buf[pos + 10] in (1, 2) else "latin-1", "ignore").strip("\x00 ")
                return int(txt) / 1000.0 if txt.isdigit() else None
            pos += 10 + size
    except Exception:
        pass
    return None


def _quick_mp3(path, size, q: _Q):
    if size < MIN_AUDIO_BYTES:
        q.fail(f"file is only {size} bytes: too small to hold audio", fatal=True)
        return
    with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as buf:
        start, end = 0, size
        if buf[:3] == b"ID3":
            start = 10 + _syncsafe(buf[6:10]) + (10 if buf[5] & 0x10 else 0)
            if start >= size:
                q.fail(f"the ID3 tag claims {_b(start)} but the whole file is {_b(size)}", fatal=True)
                return
        tlen = _tlen_seconds(buf, start)
        # trailing tags that are not audio
        if end >= 128 and buf[end - 128:end - 125] == b"TAG":
            end -= 128
        if end >= 32 and buf[end - 32:end - 24] == b"APETAGEX":
            tag = struct.unpack("<I", buf[end - 20:end - 16])[0]
            end = max(start, end - tag - (32 if (struct.unpack("<I", buf[end - 12:end - 8])[0] & 0x80000000) else 0))

        pos = start
        first = None            # (sr, ver, layer)
        first_spf = 1152
        frames = 0              # audio frames walked (Xing/VBRI frame excluded)
        samples = 0
        declared_frames = None
        gaps = []               # (seconds_at, bytes_skipped)
        skipped_total = 0
        leading_junk = 0
        free = False

        def params_ok(h):
            return h is not None and h is not _FREE and (first is None or h[8] == first)

        def next_ok(p, h):
            n = _mp3_header(buf, p + h[0], end)
            return p + h[0] == end or (params_ok(n) and n is not None and n[8] == h[8])

        while pos < end:
            h = _mp3_header(buf, pos, end)
            if h is _FREE:
                free = True
                break
            if params_ok(h) and pos + h[0] <= end:
                if first is None:
                    first = h[8]
                    first_spf = h[1]
                    # Xing / Info / VBRI header frame?
                    if h[4] == 3:
                        so = (9 if h[3] != 3 else 17) if h[6] else (17 if h[3] != 3 else 32)
                        xo = pos + 4 + so + (2 if h[7] else 0)
                        tag = bytes(buf[xo:xo + 4])
                        if tag in (b"Xing", b"Info") and xo + 12 <= end:
                            flags = struct.unpack(">I", buf[xo + 4:xo + 8])[0]
                            if flags & 1:
                                declared_frames = struct.unpack(">I", buf[xo + 8:xo + 12])[0]
                            pos += h[0]
                            continue
                        vo = pos + 4 + 32
                        if bytes(buf[vo:vo + 4]) == b"VBRI" and vo + 18 <= end:
                            declared_frames = struct.unpack(">I", buf[vo + 14:vo + 18])[0]
                            pos += h[0]
                            continue
                frames += 1
                samples += h[1]
                pos += h[0]
                # Hot path: a run of frames with the same parameters. Headers repeat byte for byte
                # (CBR) or nearly, so a dict hit replaces re-parsing the header every frame.
                cget, p, run = _HDR_CACHE.get, pos, 0
                while p < end:
                    nh = cget(buf[p:p + 4])
                    if nh is None or nh[8] != first or p + nh[0] > end:
                        break
                    p += nh[0]
                    run += 1
                frames += run
                samples += run * first_spf
                pos = p
                continue
            # --- lost sync (or truncated last frame)
            if params_ok(h) and pos + h[0] > end:
                q.warn(f"the last audio frame is cut off ({_b(end - pos)} of {_b(h[0])} present)")
                pos = end
                break
            if buf[pos:pos + 3] == b"ID3" and pos + 10 <= end:       # embedded tag: skip, not a fault
                pos += 10 + _syncsafe(buf[pos + 6:pos + 10])
                continue
            at = samples / first[0] if first else 0.0
            cand = pos + 1
            found = None
            while True:
                cand = buf.find(b"\xff", cand, end)
                if cand < 0:
                    break
                ch = _mp3_header(buf, cand, end)
                if params_ok(ch) and \
                        (cand + ch[0] <= end and next_ok(cand, ch) or
                         (cand + ch[0] > end and end - cand >= 4 and first is not None)):
                    found = cand
                    break
                cand += 1
            if found is None:
                rest = end - pos
                if first is None:
                    break
                if rest >= 1024:
                    q.warn(f"{_b(rest)} of non-audio data after the last frame (at {_t(at)})")
                pos = end
                break
            skipped = found - pos
            if first is None:
                if skipped > 1024 and any(buf[pos:found]):
                    leading_junk = skipped
            else:
                gaps.append((at, skipped))
                skipped_total += skipped
            pos = found

        if free:
            q.warn("free-format MP3: frame structure cannot be checked without decoding")
            return
        if first is None or frames == 0:
            q.fail("no MPEG audio frames found: this does not look like an MP3", fatal=True)
            return
        sr = first[0]
        walked = samples / sr
        q.walked_seconds = walked
        if leading_junk:
            q.warn(f"{_b(leading_junk)} of garbage before the first audio frame")
        if gaps:
            at, n = gaps[0]
            more = f" ({len(gaps)} breaks in total, {_b(skipped_total)} lost)" if len(gaps) > 1 else ""
            msg = f"lost sync at {_t(at)} (about {_b(n)} of garbage){more}"
            if skipped_total > 2048 or len(gaps) >= 3:
                q.fail(msg)
            else:
                q.warn(msg)
        if declared_frames is not None:
            spf = first_spf
            declared = declared_frames * spf / sr
            q.header_seconds = declared
            if frames < declared_frames and walked < declared - _tol(declared):
                q.fail(_early_msg(walked, declared))
            elif walked > declared + _tol(declared):
                q.warn(f"the file holds more audio ({_t(walked)}) than its header says ({_t(declared)})")
        elif tlen:
            q.header_seconds = tlen
            if walked < 0.9 * tlen - 1:
                q.fail(_early_msg(walked, tlen))
            elif walked < tlen - max(2.0, 0.03 * tlen):
                q.warn(_early_msg(walked, tlen))


# ---------------------------------------------------------------- FLAC

def _crc_table8() -> list:
    out = []
    for i in range(256):
        crc = i
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
        out.append(crc)
    return out


_CRC8 = _crc_table8()


def _crc8(data: bytes) -> int:
    crc = 0
    for b in data:
        crc = _CRC8[crc ^ b]
    return crc


_BS_CODE = {1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608, 8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096,
            13: 8192, 14: 16384, 15: 32768}


def _flac_frame(buf, pos, end, streaminfo_bs=None):
    """Parse a FLAC frame header at pos. Returns (first_sample, blocksize, header_len) or None."""
    if pos + 8 > end or buf[pos] != 0xFF or (buf[pos + 1] & 0xFE) != 0xF8:
        return None
    variable = buf[pos + 1] & 1
    bs_code, sr_code = buf[pos + 2] >> 4, buf[pos + 2] & 15
    if bs_code == 0 or sr_code == 15 or (buf[pos + 3] & 1):
        return None
    p = pos + 4
    first = buf[p]
    if first < 0x80:
        n, extra = first, 0
    else:
        extra = 0
        while first & (0x80 >> (extra + 1)) and extra < 6:
            extra += 1
        if extra == 0 or extra > 6:
            return None
        n = first & (0x7F >> (extra + 1))
        for i in range(1, extra + 1):
            if p + i >= end or (buf[p + i] & 0xC0) != 0x80:
                return None
            n = (n << 6) | (buf[p + i] & 0x3F)
    p += extra + 1
    if bs_code == 6:
        bs = buf[p] + 1
        p += 1
    elif bs_code == 7:
        bs = struct.unpack(">H", buf[p:p + 2])[0] + 1
        p += 2
    else:
        bs = _BS_CODE[bs_code]
    p += {12: 1, 13: 2, 14: 2}.get(sr_code, 0)
    if p >= end or _crc8(bytes(buf[pos:p])) != buf[p]:
        return None
    first_sample = n if variable else n * (streaminfo_bs or bs)
    return first_sample, bs, p + 1 - pos


def _quick_flac(path, size, q: _Q):
    if size < MIN_AUDIO_BYTES:
        q.fail(f"file is only {size} bytes: too small to hold audio", fatal=True)
        return
    with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as buf:
        pos = 0
        if buf[:3] == b"ID3":
            pos = 10 + _syncsafe(buf[6:10])
        if buf[pos:pos + 4] != b"fLaC":
            q.fail("no FLAC marker at the start: this does not look like a FLAC file", fatal=True)
            return
        pos += 4
        si = None
        seek_last = None
        last = False
        first_block = True
        while not last:
            if pos + 4 > size:
                q.fail("file ends inside the FLAC metadata headers", fatal=True)
                return
            hdr = buf[pos]
            last, btype = bool(hdr & 0x80), hdr & 0x7F
            blen = int.from_bytes(buf[pos + 1:pos + 4], "big")
            if first_block and btype != 0:
                q.fail("the FLAC STREAMINFO block is missing", fatal=True)
                return
            first_block = False
            if btype == 127:
                q.fail("invalid FLAC metadata block type", fatal=True)
                return
            if pos + 4 + blen > size:
                q.fail(f"a metadata block claims {_b(blen)} but the file ends first", fatal=True)
                return
            body = pos + 4
            if btype == 0:
                if blen != 34:
                    q.fail("the FLAC STREAMINFO block has the wrong size", fatal=True)
                    return
                v = int.from_bytes(buf[body + 10:body + 18], "big")
                si = dict(minbs=struct.unpack(">H", buf[body:body + 2])[0],
                          maxbs=struct.unpack(">H", buf[body + 2:body + 4])[0],
                          sr=(v >> 44) & 0xFFFFF, ch=((v >> 41) & 7) + 1, bps=((v >> 36) & 31) + 1,
                          total=v & 0xFFFFFFFFF)
            elif btype == 3:
                for i in range(blen // 18):
                    sp = body + i * 18
                    smp = struct.unpack(">Q", buf[sp:sp + 8])[0]
                    off = struct.unpack(">Q", buf[sp + 8:sp + 16])[0]
                    if smp != 0xFFFFFFFFFFFFFFFF:
                        seek_last = (smp, off)
            pos = body + blen
        audio_start = pos
        if si is None or not (0 < si["sr"] <= 655350) or si["bps"] < 4 or si["maxbs"] < si["minbs"] or \
                si["maxbs"] and si["maxbs"] < 16:
            q.fail("the FLAC STREAMINFO block holds nonsense values (sample rate / block size)", fatal=True)
            return
        sr, total = si["sr"], si["total"]
        raw = total * si["ch"] * si["bps"] / 8
        declared = total / sr if total else None
        q.header_seconds = declared
        if total and (size - audio_start) > raw * 1.2 + 4096:
            q.warn(f"the file is {_b(size)} but the header says only {_t(declared)} of audio ({_b(raw)} raw)")
        first_frame = _flac_frame(buf, audio_start, size, si["maxbs"] if si["minbs"] == si["maxbs"] else None)
        if first_frame is None:
            q.fail("no valid FLAC audio frame where the audio should start")
            return
        if seek_last and audio_start + seek_last[1] >= size:
            q.fail(f"the seek table points {_b(audio_start + seek_last[1] - size)} past the end of the file: "
                   "the file is truncated")
        # last good frame near the end
        win = max(audio_start, size - 262144)
        fixed_bs = si["maxbs"] if si["minbs"] == si["maxbs"] else None
        best = None
        p = win
        while True:
            p = buf.find(b"\xff", p, size - 8)
            if p < 0:
                break
            fr = _flac_frame(buf, p, size, fixed_bs)
            if fr:
                best = (p, fr)
            p += 1
        if best is None:
            q.fail("no valid FLAC frame found near the end of the file")
            return
        reached = (best[1][0] + best[1][1]) / sr
        q.walked_seconds = reached
        if declared and reached < declared - _tol(declared):
            q.fail(_early_msg(reached, declared))
        # metadata sanity via mutagen
        try:
            from mutagen.flac import FLAC
            FLAC(path)
        except Exception as e:
            q.warn(f"the tag/metadata blocks do not parse cleanly ({type(e).__name__}: {e})")


# ---------------------------------------------------------------- MP4 / M4A

def _atoms(f, start, end, size):
    """Yield (type, data_start, atom_end_declared, header_len) for atoms between start and end."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        h = f.read(16)
        if len(h) < 8:
            return
        asz, typ = struct.unpack(">I4s", h[:8])
        hl = 8
        if asz == 1:
            if len(h) < 16:
                return
            asz = struct.unpack(">Q", h[8:16])[0]
            hl = 16
        elif asz == 0:
            asz = end - pos
        if asz < hl:
            yield typ, pos + hl, pos + hl, hl, True   # corrupt size
            return
        yield typ, pos + hl, pos + asz, hl, False
        pos += asz


def _quick_mp4(path, size, q: _Q):
    if size < MIN_AUDIO_BYTES:
        q.fail(f"file is only {size} bytes: too small to hold audio", fatal=True)
        return
    with open(path, "rb") as f:
        tops = {}
        order = []
        for typ, ds, ae, hl, bad in _atoms(f, 0, size, size):
            name = typ.decode("latin-1")
            if not order and name != "ftyp":
                q.fail("no 'ftyp' header at the start: this does not look like an MP4/M4A file", fatal=True)
                return
            if bad:
                q.fail(f"a '{name}' atom has an impossible size: the file is damaged")
                break
            if ae > size:
                have, want = size - ds, ae - ds
                if name == "mdat":
                    q.fail(f"the container says {_b(want)} of audio but only {_b(have)} is there")
                else:
                    q.fail(f"the '{name}' section runs {_b(ae - size)} past the end of the file")
            tops.setdefault(name, (ds, min(ae, size)))
            order.append(name)
        if not order:
            q.fail("no readable MP4 atoms", fatal=True)
            return
        if "moov" not in tops:
            q.fail("the file has no 'moov' index: the recording was cut off or never finished")
            return
        if "mdat" not in tops:
            q.fail("the file has no 'mdat' audio data")
            return
        ms, me = tops["moov"]
        if me - ms > 256 << 20 or me > size:
            return
        f.seek(ms)
        moov = f.read(me - ms)
    _mp4_tables(moov, tops["mdat"], size, q)


def _boxes(data, start=0, end=None):
    end = len(data) if end is None else end
    pos = start
    while pos + 8 <= end:
        sz, typ = struct.unpack(">I4s", data[pos:pos + 8])
        hl = 8
        if sz == 1 and pos + 16 <= end:
            sz = struct.unpack(">Q", data[pos + 8:pos + 16])[0]
            hl = 16
        elif sz == 0:
            sz = end - pos
        if sz < hl or pos + sz > end:
            return
        yield typ, pos + hl, pos + sz
        pos += sz


def _find(data, path, start=0, end=None):
    cur = [(start, len(data) if end is None else end)]
    for name in path:
        nxt = []
        for s, e in cur:
            for typ, ds, de in _boxes(data, s, e):
                if typ == name:
                    nxt.append((ds, de))
        cur = nxt
    return cur


def _mp4_tables(moov, mdat, size, q: _Q):
    mdat_payload = mdat[1] - mdat[0]
    for ts, te in _find(moov, [b"trak"]):
        hdlr = _find(moov, [b"mdia", b"hdlr"], ts, te)
        if hdlr and moov[hdlr[0][0] + 8:hdlr[0][0] + 12] != b"soun":
            continue
        mdhd = _find(moov, [b"mdia", b"mdhd"], ts, te)
        stbl = _find(moov, [b"mdia", b"minf", b"stbl"], ts, te)
        if not mdhd or not stbl:
            q.warn("an audio track has no duration or sample table")
            continue
        s = mdhd[0][0]
        if moov[s] == 1:
            timescale, dur = struct.unpack(">IQ", moov[s + 20:s + 32])
        else:
            timescale, dur = struct.unpack(">II", moov[s + 12:s + 20])
        declared = dur / timescale if timescale and dur != 0xFFFFFFFF else None
        a, b = stbl[0]
        stts = _find(moov, [b"stts"], a, b)
        stsz = _find(moov, [b"stsz"], a, b)
        stco = _find(moov, [b"stco"], a, b) or _find(moov, [b"co64"], a, b)
        wide = bool(stco) and not _find(moov, [b"stco"], a, b)
        if declared is not None:
            q.header_seconds = declared
        if stts and timescale:
            s = stts[0][0]
            n = struct.unpack(">I", moov[s + 4:s + 8])[0]
            ticks = sum(struct.unpack(">II", moov[s + 8 + i * 8:s + 16 + i * 8])[0] *
                        struct.unpack(">II", moov[s + 8 + i * 8:s + 16 + i * 8])[1] for i in range(n))
            walked = ticks / timescale
            q.walked_seconds = walked
            if declared and walked < declared - _tol(declared):
                q.fail(_early_msg(walked, declared))
            elif declared and walked > declared + _tol(declared):
                q.warn(f"the sample table covers {_t(walked)} but the header duration is {_t(declared)}")
        if stsz:
            s = stsz[0][0]
            fixed, count = struct.unpack(">II", moov[s + 4:s + 12])
            tot = fixed * count if fixed else sum(struct.unpack(f">{count}I", moov[s + 12:s + 12 + 4 * count])) \
                if s + 12 + 4 * count <= stsz[0][1] else None
            if tot is not None and tot > mdat_payload:
                q.fail(f"the sample table lists {_b(tot)} of audio but the audio section holds only {_b(mdat_payload)}")
        if stco:
            s = stco[0][0]
            n = struct.unpack(">I", moov[s + 4:s + 8])[0]
            if n and s + 8 + n * (8 if wide else 4) <= stco[0][1]:
                last = struct.unpack(">Q" if wide else ">I", moov[s + 8 + (n - 1) * (8 if wide else 4):
                                                                   s + 8 + n * (8 if wide else 4)])[0]
                if last >= size:
                    q.fail("the chunk index points past the end of the file: the audio is cut off")


# ---------------------------------------------------------------- WAV / AIFF / APE

def _quick_wav(path, size, q: _Q):
    if size < 44:
        q.fail(f"file is only {size} bytes: too small to be a WAV", fatal=True)
        return
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
            q.fail("no RIFF/WAVE header: this does not look like a WAV file", fatal=True)
            return
        riff = struct.unpack("<I", head[4:8])[0]
        if head[:4] == b"RIFF" and riff != 0xFFFFFFFF and riff + 8 > size:
            q.fail(f"the WAV header says the file is {_b(riff + 8)} but only {_b(size)} is there")
        pos, fmt, data = 12, None, None
        while pos + 8 <= size:
            f.seek(pos)
            cid, csz = struct.unpack("<4sI", f.read(8))
            if cid == b"fmt ":
                body = f.read(min(csz, 40))
                if len(body) >= 16:
                    fmt = struct.unpack("<HHIIHH", body[:16])
            elif cid == b"data":
                data = (pos + 8, csz)
                break
            pos += 8 + csz + (csz & 1)
        if fmt is None:
            q.fail("the WAV has no 'fmt ' chunk")
            return
        tag, ch, sr, byterate, align, bits = fmt
        if ch < 1 or sr < 1 or byterate < 1 or align < 1:
            q.fail("the WAV format chunk holds nonsense values")
            return
        if data is None:
            q.fail("the WAV has no 'data' chunk: no audio")
            return
        ds, dsz = data
        remain = size - ds
        if dsz in (0xFFFFFFFF, 0) and remain > 0:
            dsz = remain  # streamed WAV
        if dsz > remain:
            q.fail(f"the container says {_b(dsz)} of audio but only {_b(remain)} is there")
            q.header_seconds = dsz / byterate
            q.walked_seconds = remain / byterate
            return
        q.header_seconds = dsz / byterate
        q.walked_seconds = dsz / byterate
        if dsz == 0:
            q.fail("the WAV has no audio samples")
        elif dsz % align:
            q.warn("the audio length is not a whole number of samples (cut off mid-sample)")
        if tag == 1 and align != ch * ((bits + 7) // 8):
            q.warn("the WAV block size does not match channels x bit depth")


def _ext80(b):
    exp = ((b[0] & 0x7F) << 8) | b[1]
    mant = int.from_bytes(b[2:10], "big")
    return 0.0 if exp == 0 and mant == 0 else mant * 2.0 ** (exp - 16383 - 63)


def _quick_aiff(path, size, q: _Q):
    if size < 54:
        q.fail(f"file is only {size} bytes: too small to be an AIFF", fatal=True)
        return
    with open(path, "rb") as f:
        head = f.read(12)
        if head[:4] != b"FORM" or head[8:12] not in (b"AIFF", b"AIFC"):
            q.fail("no FORM/AIFF header: this does not look like an AIFF file", fatal=True)
            return
        form = struct.unpack(">I", head[4:8])[0]
        if form + 8 > size:
            q.fail(f"the AIFF header says the file is {_b(form + 8)} but only {_b(size)} is there")
        pos, rate, frames, ssnd = 12, None, None, None
        while pos + 8 <= size:
            f.seek(pos)
            cid, csz = struct.unpack(">4sI", f.read(8))
            if cid == b"COMM":
                body = f.read(18)
                if len(body) == 18:
                    frames = struct.unpack(">I", body[2:6])[0]
                    rate = _ext80(body[8:18])
            elif cid == b"SSND":
                ssnd = (pos + 8, csz)
                break
            pos += 8 + csz + (csz & 1)
        if rate is None or ssnd is None:
            q.fail("the AIFF is missing its COMM or SSND chunk")
            return
        if ssnd[1] > size - ssnd[0]:
            q.fail(f"the container says {_b(ssnd[1])} of audio but only {_b(size - ssnd[0])} is there")
        if rate > 0 and frames:
            q.header_seconds = frames / rate


def _quick_ape(path, size, q: _Q):
    with open(path, "rb") as f:
        magic = f.read(4)
    if size < MIN_AUDIO_BYTES:
        q.fail(f"file is only {size} bytes: too small to hold audio", fatal=True)
    elif magic != b"MAC ":
        q.fail("no 'MAC ' marker: this does not look like a Monkey's Audio file", fatal=True)


# ---------------------------------------------------------------- OGG / OPUS

# Ogg's CRC-32 (poly 0x04C11DB7, MSB first, no inversion) is zlib's reflected CRC-32 run over
# bit-reversed bytes with the register preset to zero, bit-reversed on the way out: C speed instead
# of a Python loop per byte.
_BITREV8 = bytes(int(f"{i:08b}"[::-1], 2) for i in range(256))


def _ogg_crc(data: bytes) -> int:
    r = zlib.crc32(bytes(data).translate(_BITREV8), 0xFFFFFFFF) ^ 0xFFFFFFFF
    return int(f"{r:032b}"[::-1], 2)


def _ogg_page(buf, pos, size):
    """Return (page_len, header_type, granule, crc_ok) or None if no plausible page at pos."""
    if pos + 27 > size or buf[pos:pos + 4] != b"OggS" or buf[pos + 4] != 0:
        return None
    nseg = buf[pos + 26]
    if pos + 27 + nseg > size:
        return None
    plen = 27 + nseg + sum(buf[pos + 27:pos + 27 + nseg])
    if pos + plen > size:
        return plen, buf[pos + 5], None, False
    page = bytearray(buf[pos:pos + plen])
    stored = struct.unpack("<I", page[22:26])[0]
    page[22:26] = b"\0\0\0\0"
    return plen, buf[pos + 5], struct.unpack("<q", buf[pos + 6:pos + 14])[0], _ogg_crc(bytes(page)) == stored


def _quick_ogg(path, size, q: _Q):
    if size < MIN_AUDIO_BYTES:
        q.fail(f"file is only {size} bytes: too small to hold audio", fatal=True)
        return
    with open(path, "rb") as f, mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as buf:
        first = _ogg_page(buf, 0, size)
        if first is None:
            q.fail("no Ogg page at the start: this does not look like an Ogg/Opus file", fatal=True)
            return
        if not first[3]:
            q.fail("the first Ogg page fails its checksum: the start of the file is damaged")
        plen = first[0]
        body = bytes(buf[27 + buf[26]:plen])
        rate, preskip = None, 0
        if body.startswith(b"OpusHead") and len(body) >= 12:
            rate, preskip = 48000, struct.unpack("<H", body[10:12])[0]
        elif body.startswith(b"\x01vorbis") and len(body) >= 16:
            rate = struct.unpack("<I", body[12:16])[0]
        # walk back through the tail for valid pages
        win = max(0, size - 140000)
        pages, bad = [], 0
        p = win
        while True:
            p = buf.find(b"OggS", p, size)
            if p < 0:
                break
            pg = _ogg_page(buf, p, size)
            if pg and pg[3]:
                pages.append((p, pg))
                p += pg[0]
            else:
                bad += 1
                p += 4
        if not pages:
            q.fail("no intact Ogg page near the end of the file: the file is cut off or damaged")
            return
        lp, pg = pages[-1]
        if lp + pg[0] != size:
            q.fail(f"the file ends {_b(size - lp - pg[0])} after its last complete Ogg page: it is cut off")
        elif not pg[1] & 4:
            q.fail("the last Ogg page is not marked end-of-stream: the file was cut short")
        elif bad:
            q.warn(f"{bad} damaged Ogg page(s) near the end of the file")
        if rate and pg[2] is not None and pg[2] > 0:
            q.header_seconds = max(pg[2] - preskip, 0) / rate
            q.walked_seconds = q.header_seconds


# ---------------------------------------------------------------- quick dispatch

_QUICK = {".mp3": _quick_mp3, ".flac": _quick_flac, ".m4a": _quick_mp4, ".m4b": _quick_mp4,
          ".mp4": _quick_mp4, ".wav": _quick_wav, ".ogg": _quick_ogg, ".oga": _quick_ogg,
          ".opus": _quick_ogg, ".aif": _quick_aiff, ".aiff": _quick_aiff, ".aifc": _quick_aiff,
          ".ape": _quick_ape}


# ---------------------------------------------------------------- deep pass

_ffmpeg_cache = [False, None]


def have_ffmpeg():
    """Path of ffmpeg (on PATH or next to the exe / bundled), else None."""
    if _ffmpeg_cache[0]:
        return _ffmpeg_cache[1]
    import shutil
    found = shutil.which("ffmpeg")
    if not found:
        dirs = [os.path.dirname(os.path.abspath(sys.executable)), getattr(sys, "_MEIPASS", None),
                os.path.dirname(os.path.abspath(sys.argv[0])) if sys.argv and sys.argv[0] else None]
        for d in dirs:
            for name in ("ffmpeg.exe", "ffmpeg"):
                if d and os.path.isfile(os.path.join(d, name)):
                    found = os.path.join(d, name)
                    break
            if found:
                break
    _ffmpeg_cache[:] = [True, found]
    return found


def deep_supported(ext: str) -> bool:
    ext = ext.lower()
    if not ext.startswith("."):
        ext = "." + ext
    if ext in MINIAUDIO_EXTS and _miniaudio() is not None:
        return True
    return ext in FFMPEG_EXTS and have_ffmpeg() is not None


class _Deep:
    def __init__(self):
        self.reasons = []      # (severity, msg)
        self.engine = ""
        self.decoded = None
        self.error_at = None


def _deep_miniaudio(path, header_seconds, walked, d: _Deep):
    miniaudio = _miniaudio()
    d.engine = "miniaudio"
    info = miniaudio.get_file_info(path)
    sr, ch = info.sample_rate, max(info.nchannels, 1)
    own = info.num_frames / sr if info.num_frames and path.lower().endswith((".flac", ".wav", ".ogg")) else None
    declared = header_seconds if header_seconds is not None else own
    gen = miniaudio.stream_file(path, output_format=miniaudio.SampleFormat.SIGNED16, nchannels=ch,
                                sample_rate=sr, frames_to_read=16384)
    frames = 0
    nonzero = False
    tail_zero = 0   # trailing zero frames
    err = None
    while True:
        try:
            chunk = next(gen)
        except StopIteration:
            break
        except Exception as e:
            err = e
            break
        raw = chunk.tobytes()
        n = len(chunk) // ch
        frames += n
        if raw.strip(b"\x00\xff"):
            nonzero = True
        stripped = len(raw.rstrip(b"\x00"))
        if stripped == 0:
            tail_zero += n
        else:
            tail_zero = (len(raw) - stripped) // (2 * ch)
    d.decoded = frames / sr
    if err is not None:
        d.error_at = d.decoded
        d.reasons.append(("fail", f"decoder error at {_t(d.decoded)}: {err}"))
        return
    if frames == 0:
        d.reasons.append(("fail", "the decoder found no audio at all"))
        return
    if declared is not None and d.decoded < declared - _tol(declared):
        d.error_at = d.decoded
        d.reasons.append(("fail", _early_msg(d.decoded, declared)))
    elif declared is not None and d.decoded > declared + _tol(declared):
        d.reasons.append(("warn", f"the file decodes to {_t(d.decoded)} but its header says {_t(declared)}"))
    elif walked is not None and d.decoded < walked - _tol(walked):
        d.error_at = d.decoded
        d.reasons.append(("fail", f"the decoder stopped at {_t(d.decoded)} although the file holds audio "
                                  f"data up to {_t(walked)}"))
    if not nonzero:
        d.reasons.append(("warn", "silent file: every sample is zero"))
    elif tail_zero / sr > SILENCE_TAIL_WARN_S:
        d.reasons.append(("warn", f"{_t(tail_zero / sr)} of digital silence at the end"))


def _deep_ffmpeg(path, header_seconds, d: _Deep):
    d.engine = "ffmpeg"
    cmd = [have_ffmpeg(), "-v", "error", "-xerror", "-nostdin", "-nostats", "-progress", "pipe:1",
           "-i", path, "-f", "null", "-"]
    import subprocess
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=FFMPEG_TIMEOUT, **no_window_kwargs())
    except subprocess.TimeoutExpired:
        d.reasons.append(("warn", f"ffmpeg did not finish within {FFMPEG_TIMEOUT} s: file not fully checked"))
        return
    out = r.stdout.decode("utf-8", "replace")
    err = r.stderr.decode("utf-8", "replace").strip()
    pos = None
    for line in out.splitlines():
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            v = line.split("=", 1)[1].strip()
            if v.lstrip("-").isdigit():
                pos = max(int(v), 0) / 1_000_000
    d.decoded = pos
    if r.returncode != 0 or err:
        msg = err.splitlines()[0] if err else f"ffmpeg exited with code {r.returncode}"
        d.error_at = pos
        d.reasons.append(("fail", f"decoder error at {_t(pos)}: {msg}" if pos is not None else
                          f"decoder error: {msg}"))
        return
    if pos is not None and header_seconds is not None and pos < header_seconds - _tol(header_seconds):
        d.error_at = pos
        d.reasons.append(("fail", _early_msg(pos, header_seconds)))


# ---------------------------------------------------------------- public API

def check_file(path: str, deep: bool = False) -> Verdict:
    """Check one file. Never raises: any problem becomes a 'fail' verdict with a plain reason."""
    path = str(path)
    ext = os.path.splitext(path)[1].lower()
    v = Verdict(path=path, ext=ext)
    try:
        exists, is_file, v.size_bytes = is_regular_file(path)
        if not exists:
            v.level, v.reasons = "fail", ["file not found"]
            return v
        if not is_file:
            v.level, v.reasons = "fail", ["this is not a file"]
            return v
        if ext not in QUICK_EXTS and not (deep and deep_supported(ext)):   # deep via ffmpeg can still examine odd formats
            v.level, v.reasons = "unsupported", [f"{ext or 'this file type'} is not checked"]
            return v
        q = _Q()
        if v.size_bytes == 0:
            q.fail("the file is empty (0 bytes)", fatal=True)
        elif ext in _QUICK:
            _QUICK[ext](long_path(path), v.size_bytes, q)
        v.header_seconds = q.header_seconds
        v.decoded_seconds = q.walked_seconds
        items = list(q.items)
        if deep and not q.fatal:
            if deep_supported(ext):
                d = _Deep()
                try:
                    if ext in MINIAUDIO_EXTS and _miniaudio() is not None:
                        try:
                            _deep_miniaudio(path, q.header_seconds, q.walked_seconds, d)
                        except Exception as e:
                            if have_ffmpeg() and ext in FFMPEG_EXTS and not d.decoded:
                                d = _Deep()
                                _deep_ffmpeg(path, q.header_seconds, d)
                            else:
                                d.reasons.append(("fail", f"decoder error: {e}"))
                    else:
                        _deep_ffmpeg(path, q.header_seconds, d)
                except Exception as e:
                    d.reasons.append(("fail", f"decoder error: {e}"))
                v.engine = d.engine or "structure"
                v.decoded_seconds = d.decoded
                v.error_at_seconds = d.error_at
                # drop the structure "ends early" note if the decoder says the same thing
                if any("ends early" in m for _, m in d.reasons):
                    items = [(s, m) for s, m in items if "ends early" not in m]
                items += d.reasons
            else:
                items.append(("warn", f"deep check skipped: no decoder available for {ext} "
                                      "(install ffmpeg next to the app to check this format)"))
        sev = [s for s, _ in items]
        v.level = "fail" if "fail" in sev else "warn" if "warn" in sev else "ok"
        v.reasons = [m for _, m in items]
    except Exception as e:  # never raise
        v.level = "fail"
        v.reasons = list(v.reasons) + [f"could not be checked: {type(e).__name__}: {e}"]
    return v


def check_many(paths, deep: bool = False, progress=None, stop=None, workers: int = 1):
    """Check many files; results keep input order. Files not reached because `stop` was set are omitted.

    progress(done, total, current_name) is called from the worker threads when workers > 1, but
    never concurrently and with `done` strictly increasing (calls are serialised under a lock), so a
    callback need not be thread-safe against itself; it must still hand work to the GUI thread.
    An exception raised by `progress` is swallowed.
    """
    paths = list(paths)
    total = len(paths)
    results = [None] * total
    lock = threading.Lock()
    done = [0]

    def run(i):
        if stop is not None and stop.is_set():
            return
        results[i] = check_file(paths[i], deep)
        with lock:
            done[0] += 1
            if progress:
                try:
                    progress(done[0], total, os.path.basename(str(paths[i])))
                except Exception:   # a broken progress display must not abort the check
                    pass

    if workers <= 1:
        for i in range(total):
            if stop is not None and stop.is_set():
                break
            run(i)
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as ex:
            for f in [ex.submit(run, i) for i in range(total)]:
                f.result()
    return [r for r in results if r is not None]


def summarise(verdicts) -> dict:
    by_level = {"ok": 0, "warn": 0, "fail": 0, "unsupported": 0}
    by_ext = {}
    total_bytes = 0
    for v in verdicts:
        by_level[v.level] = by_level.get(v.level, 0) + 1
        e = by_ext.setdefault(v.ext or "(none)", {"ok": 0, "warn": 0, "fail": 0, "unsupported": 0})
        e[v.level] = e.get(v.level, 0) + 1
        total_bytes += v.size_bytes
    bad = [v for v in verdicts if v.level in ("fail", "warn")]
    bad.sort(key=lambda v: (v.level != "fail", -len(v.reasons), v.path))
    worst = [{"path": v.path, "level": v.level, "reasons": list(v.reasons)} for v in bad[:20]]
    return {"total": len(verdicts), "by_level": by_level, "by_ext": by_ext,
            "total_bytes": total_bytes, "worst": worst}


def write_report(verdicts, out_path):
    """Write CSV to out_path and a human summary beside it (.txt). Returns the .txt path."""
    import csv
    out_path = str(out_path)
    order = {"fail": 0, "warn": 1, "unsupported": 2, "ok": 3}
    rows = sorted(verdicts, key=lambda v: (order.get(v.level, 9), v.path))
    with open(out_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["level", "path", "reasons", "header_seconds", "decoded_seconds", "error_at_seconds", "engine"])
        for v in rows:
            def r(x):
                return "" if x is None else f"{x:.2f}"
            w.writerow([v.level, v.path, " | ".join(v.reasons), r(v.header_seconds), r(v.decoded_seconds),
                        r(v.error_at_seconds), v.engine])
    s = summarise(verdicts)
    lb = s["by_level"]
    lines = [f"Audio integrity check: {s['total']} files ({_b(s['total_bytes'])})",
             f"  OK {lb['ok']}   warnings {lb['warn']}   failed {lb['fail']}   not checked {lb['unsupported']}", ""]
    for ext, c in sorted(s["by_ext"].items()):
        lines.append(f"  {ext:8} ok {c['ok']}  warn {c['warn']}  fail {c['fail']}  unsupported {c['unsupported']}")
    if s["worst"]:
        lines += ["", "Worst offenders:"]
        for w_ in s["worst"]:
            lines.append(f"  [{w_['level']}] {w_['path']}")
            lines += [f"      - {m}" for m in w_["reasons"]]
    txt = os.path.splitext(out_path)[0] + ".txt"
    if txt == out_path:
        txt = out_path + ".txt"
    with open(txt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return txt
