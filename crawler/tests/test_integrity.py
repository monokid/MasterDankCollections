"""Tests for integrity.py. All audio is synthesised here (no real music).
Run: python -m unittest discover -s crawler/tests
"""
import math
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import wave
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import integrity  # noqa: E402


# ------------------------------------------------------------------ synthesisers

def _pack(fields):
    v = n = 0
    for val, w in fields:
        v = (v << w) | (val & ((1 << w) - 1))
        n += w
    return v.to_bytes(n // 8, "big")


def make_mp3(seconds=5.0, noisy=True, xing=True, vbr=False, seed=1, wrong_count=None):
    """MPEG-1 Layer III mono 44.1 kHz. Noisy frames carry random main data (decodes to quiet noise);
    silent frames are all zero. vbr alternates 128/96 kbps and writes a 'Xing' tag, else 'Info'."""
    rng = random.Random(seed)
    nframes = int(seconds * 44100 / 1152)
    frames, acc = [], 0
    for i in range(nframes):
        bi, num = (9, 18432000) if not vbr or i % 2 == 0 else (7, 13824000)  # 128k / 96k
        acc += num % 44100
        pad = 0
        if acc >= 44100:
            acc -= 44100
            pad = 1
        length = num // 44100 + pad
        head = bytes([0xFF, 0xFB, (bi << 4) | (pad << 1), 0xC0])
        if noisy:
            side = [(0, 9), (0, 5), (0, 4)]
            for _ in range(2):
                side += [(1000, 12), (100, 9), (150, 8), (0, 4), (0, 1), (5, 5), (5, 5), (5, 5),
                         (4, 4), (3, 3), (0, 1), (0, 1), (0, 1)]
            body = _pack(side) + bytes(rng.getrandbits(8) for _ in range(length - 21))
        else:
            body = bytes(length - 4)
        frames.append(head + body)
    out = b""
    if xing:
        hdr = bytearray(frames[0])
        hdr[4:] = bytes(len(hdr) - 4)
        tag = b"Xing" if vbr else b"Info"
        cnt = nframes if wrong_count is None else wrong_count
        hdr[21:21 + 12] = tag + struct.pack(">II", 1, cnt)
        out += bytes(hdr)
    return out + b"".join(frames)


def _utf8_num(n):
    if n < 0x80:
        return bytes([n])
    if n < 0x800:
        return bytes([0xC0 | n >> 6, 0x80 | n & 0x3F])
    if n < 0x10000:
        return bytes([0xE0 | n >> 12, 0x80 | (n >> 6) & 0x3F, 0x80 | n & 0x3F])
    return bytes([0xF0 | n >> 18, 0x80 | (n >> 12) & 0x3F, 0x80 | (n >> 6) & 0x3F, 0x80 | n & 0x3F])


def _crc8(data):
    return integrity._crc8(data)


_CRC16 = []
for _i in range(256):
    _c = _i << 8
    for _ in range(8):
        _c = ((_c << 1) ^ 0x8005) & 0xFFFF if _c & 0x8000 else (_c << 1) & 0xFFFF
    _CRC16.append(_c)


def _crc16(data):
    c = 0
    for b in data:
        c = ((c << 8) & 0xFFFF) ^ _CRC16[(c >> 8) ^ b]
    return c


def make_flac(seconds=5.0, rate=8000, silent=False, bs=4096):
    """Mono 16-bit FLAC made of verbatim subframes."""
    total = int(seconds * rate)
    samples = [0] * total if silent else [int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(total)]
    frames = []
    for fn, start in enumerate(range(0, total, bs)):
        blk = samples[start:start + bs]
        n = len(blk)
        hdr = bytes([0xFF, 0xF8, 0x70, 0x08 | 0x00]) + _utf8_num(fn) + struct.pack(">H", n - 1)
        # byte2: blocksize code 7 (16-bit) <<4 | sr code 0 (from streaminfo); byte3: chan 0 (mono)<<4 | size 4 (16 bit)<<1
        hdr = bytes([0xFF, 0xF8, 0x70, 0x08]) + hdr[4:]
        hdr += bytes([_crc8(hdr)])
        sub = b"\x02" + struct.pack(f">{n}h", *blk)
        fr = hdr + sub
        frames.append(fr + struct.pack(">H", _crc16(fr)))
    maxfs = max(len(f) for f in frames)
    si = struct.pack(">HH", bs, bs) + (maxfs).to_bytes(3, "big") * 2 + \
        ((rate << 44) | (0 << 41) | (15 << 36) | total).to_bytes(8, "big") + bytes(16)
    return b"fLaC" + bytes([0x80, 0, 0, 34]) + si + b"".join(frames)


def make_wav(path, seconds=3.0, rate=8000, silent=False):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        n = int(seconds * rate)
        w.writeframes(struct.pack(f"<{n}h", *([0] * n if silent else
                                              [int(9000 * math.sin(i / 5)) for i in range(n)])))


def _box(typ, payload):
    return struct.pack(">I4s", 8 + len(payload), typ) + payload


def make_m4a(seconds=4.0, moov_first=False, timescale=8000, nsamp=40, sample_bytes=300):
    """Hand-built minimal M4A: ftyp, moov (one 'soun' track with real sample tables), mdat."""
    dur = int(seconds * timescale)
    payload = os.urandom(nsamp * sample_bytes)
    ftyp = _box(b"ftyp", b"M4A \0\0\0\0M4A mp42isom")

    def moov(offset):
        mdhd = _box(b"mdhd", struct.pack(">IIIIIHH", 0, 0, 0, timescale, dur, 0x55C4, 0))
        hdlr = _box(b"hdlr", struct.pack(">II4s", 0, 0, b"soun") + bytes(13))
        stts = _box(b"stts", struct.pack(">IIII", 0, 1, nsamp, dur // nsamp))
        stsz = _box(b"stsz", struct.pack(">IIII", 0, sample_bytes, nsamp, 0)[:12] + b"")
        stco = _box(b"stco", struct.pack(">III", 0, 1, offset))
        stbl = _box(b"stbl", stts + stsz + stco)
        trak = _box(b"trak", _box(b"mdia", mdhd + hdlr + _box(b"minf", stbl)))
        return _box(b"moov", _box(b"mvhd", bytes(100)) + trak)

    mdat = _box(b"mdat", payload)
    if moov_first:
        off = len(ftyp) + len(moov(0)) + 8
        return ftyp + moov(off) + mdat
    return ftyp + mdat + moov(len(ftyp) + 8)


def _ogg_page(htype, granule, seq, data):
    segs = []
    n = len(data)
    while n >= 255:
        segs.append(255)
        n -= 255
    segs.append(n)
    page = bytearray(b"OggS" + bytes([0, htype]) + struct.pack("<qIII", granule, 7, seq, 0) +
                     bytes([len(segs)]) + bytes(segs) + data)
    page[22:26] = struct.pack("<I", integrity._ogg_crc(bytes(page)))
    return bytes(page)


def make_opus(seconds=3.0, eos=True):
    head = b"OpusHead" + bytes([1, 1]) + struct.pack("<HIhB", 312, 48000, 0, 0)
    out = _ogg_page(2, 0, 0, head) + _ogg_page(0, 0, 1, b"OpusTags" + bytes(40))
    rng = random.Random(3)
    total = int(seconds * 48000)
    for i in range(4):
        last = i == 3
        out += _ogg_page(4 if (last and eos) else 0, total if last else (i + 1) * total // 4, 2 + i,
                         bytes(rng.getrandbits(8) for _ in range(3000)))
    return out


# ------------------------------------------------------------------ tests

class Base(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="integ_")
        self.addCleanup(shutil.rmtree, self.dir, True)

    def put(self, name, data):
        p = os.path.join(self.dir, name)
        with open(p, "wb") as f:
            f.write(data)
        return p

    def assertReason(self, v, text):
        self.assertTrue(any(text in r for r in v.reasons), f"{text!r} not in {v.reasons}")


class GoodFiles(Base):
    def test_good_mp3_passes_both_passes(self):
        p = self.put("a.mp3", make_mp3(5))
        for deep in (False, True):
            v = integrity.check_file(p, deep)
            self.assertEqual(v.level, "ok", v.reasons)
        self.assertEqual(v.engine, "miniaudio")
        self.assertAlmostEqual(v.decoded_seconds, 5.0, delta=0.2)

    def test_vbr_with_correct_xing_header_passes(self):
        p = self.put("v.mp3", make_mp3(5, vbr=True))
        for deep in (False, True):
            v = integrity.check_file(p, deep)
            self.assertEqual(v.level, "ok", v.reasons)
        self.assertAlmostEqual(v.header_seconds, 5.0, delta=0.1)

    def test_good_flac_passes_both_passes(self):
        p = self.put("a.flac", make_flac(5))
        for deep in (False, True):
            v = integrity.check_file(p, deep)
            self.assertEqual(v.level, "ok", v.reasons)

    def test_good_wav_passes_both_passes(self):
        p = os.path.join(self.dir, "a.wav")
        make_wav(p)
        for deep in (False, True):
            v = integrity.check_file(p, deep)
            self.assertEqual(v.level, "ok", v.reasons)

    def test_good_m4a_passes_quick_in_both_layouts(self):
        for first in (False, True):
            p = self.put(f"a{first}.m4a", make_m4a(moov_first=first))
            v = integrity.check_file(p)
            self.assertEqual(v.level, "ok", v.reasons)
            self.assertAlmostEqual(v.header_seconds, 4.0, delta=0.01)

    def test_good_opus_passes_quick(self):
        v = integrity.check_file(self.put("a.opus", make_opus()))
        self.assertEqual(v.level, "ok", v.reasons)
        self.assertAlmostEqual(v.header_seconds, 3 - 312 / 48000, delta=0.01)


class Truncation(Base):
    def test_truncated_mp3_fails_with_duration_mismatch(self):
        data = make_mp3(10)
        p = self.put("t.mp3", data[:len(data) // 2])
        v = integrity.check_file(p)
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "file ends early")
        self.assertReason(v, "header says 0:10")

    def test_truncated_mp3_fails_deep_too(self):
        data = make_mp3(10)
        v = integrity.check_file(self.put("t.mp3", data[:len(data) // 2]), deep=True)
        self.assertEqual(v.level, "fail")
        self.assertIsNotNone(v.error_at_seconds)
        self.assertAlmostEqual(v.error_at_seconds, 5.0, delta=0.5)

    def test_mp3_with_garbage_mid_file_reports_roughly_right_time(self):
        data = make_mp3(10)
        at = int(len(data) * 0.4)
        # land on a frame boundary: walk the real frames
        pos = 0
        while pos < at:
            pos += integrity._mp3_header(data, pos, len(data))[0]
        junk = bytes(random.Random(9).getrandbits(7) for _ in range(6000))  # no 0xFF bytes
        p = self.put("g.mp3", data[:pos] + junk + data[pos:])
        v = integrity.check_file(p)
        self.assertIn(v.level, ("warn", "fail"))
        self.assertReason(v, "lost sync at 0:04")
        self.assertReason(v, "6 KB of garbage")

    def test_truncated_flac_fails(self):
        data = make_flac(10)
        v = integrity.check_file(self.put("t.flac", data[:len(data) // 2]))
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "file ends early")

    def test_truncated_wav_data_chunk_too_big_fails(self):
        p = os.path.join(self.dir, "t.wav")
        make_wav(p, 4)
        with open(p, "rb") as fh:
            raw = fh.read()
        v = integrity.check_file(self.put("t2.wav", raw[:len(raw) // 2]))
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "of audio but only")
        # data chunk declares more than the file holds (RIFF size patched to match the file)
        bad = bytearray(raw)
        bad[40:44] = struct.pack("<I", len(raw) * 3)
        v = integrity.check_file(self.put("t3.wav", bytes(bad)))
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "of audio but only")

    def test_truncated_m4a_mdat_larger_than_file_fails(self):
        data = make_m4a(moov_first=True)
        v = integrity.check_file(self.put("t.m4a", data[:len(data) - 4000]))
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "of audio but only")

    def test_m4a_cut_before_moov_fails(self):
        data = make_m4a(moov_first=False)
        v = integrity.check_file(self.put("t.m4a", data[:len(data) // 2]))
        self.assertEqual(v.level, "fail")

    def test_truncated_opus_fails(self):
        data = make_opus()
        self.assertEqual(integrity.check_file(self.put("e.opus", data[:-1500])).level, "fail")
        self.assertEqual(integrity.check_file(self.put("n.opus", make_opus(eos=False))).level, "fail")

    def test_mp3_whose_xing_count_is_too_high_fails(self):
        p = self.put("x.mp3", make_mp3(5, wrong_count=int(10 * 44100 / 1152)))
        v = integrity.check_file(p)
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "file ends early")


class NotAudio(Base):
    def test_zero_byte_and_100_byte_files_fail(self):
        for name, data in (("z.mp3", b""), ("s.mp3", bytes(100)), ("z.flac", b""), ("s.m4a", bytes(100)),
                           ("s.wav", bytes(100))):
            v = integrity.check_file(self.put(name, data), deep=True)
            self.assertEqual(v.level, "fail", name)

    def test_text_file_named_mp3_fails(self):
        v = integrity.check_file(self.put("t.mp3", b"hello this is not music\n" * 500), deep=True)
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "does not look like an MP3")

    def test_unsupported_extension_is_unsupported(self):
        v = integrity.check_file(self.put("notes.txt", b"hi"))
        self.assertEqual(v.level, "unsupported")

    def test_check_file_never_raises_on_directory_or_missing(self):
        v = integrity.check_file(self.dir)
        self.assertEqual(v.level, "fail")
        v = integrity.check_file(os.path.join(self.dir, "nope.mp3"), deep=True)
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "not found")


class DeepPass(Base):
    def test_all_zero_audio_warns_silent(self):
        p = os.path.join(self.dir, "s.wav")
        make_wav(p, silent=True)
        v = integrity.check_file(p, deep=True)
        self.assertEqual(v.level, "warn")
        self.assertReason(v, "silent")
        self.assertEqual(integrity.check_file(self.put("s.flac", make_flac(3, silent=True)), True).level, "warn")

    def test_long_digital_silence_at_end_warns(self):
        p = os.path.join(self.dir, "tail.wav")
        with wave.open(p, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(8000)
            w.writeframes(struct.pack("<8000h", *[int(9000 * math.sin(i / 5)) for i in range(8000)]))
            w.writeframes(bytes(2 * 8000 * 12))
        v = integrity.check_file(p, deep=True)
        self.assertEqual(v.level, "warn")
        self.assertReason(v, "digital silence at the end")

    def test_deep_skipped_gracefully_when_no_decoder(self):
        p = self.put("a.m4a", make_m4a())
        with mock.patch.object(integrity, "have_ffmpeg", return_value=None):
            self.assertFalse(integrity.deep_supported(".m4a"))
            v = integrity.check_file(p, deep=True)
        self.assertEqual(v.engine, "structure")
        self.assertEqual(v.level, "warn")
        self.assertReason(v, "deep check skipped")

    def test_deep_supported_matches_available_decoders(self):
        with mock.patch.object(integrity, "have_ffmpeg", return_value=None):
            self.assertTrue(integrity.deep_supported(".mp3"))
            self.assertTrue(integrity.deep_supported("FLAC"))
            self.assertFalse(integrity.deep_supported(".opus"))
        with mock.patch.object(integrity, "have_ffmpeg", return_value="x"):
            self.assertTrue(integrity.deep_supported(".opus"))

    def test_ffmpeg_stderr_and_progress_are_parsed(self):
        win = os.name == "nt"
        fake = os.path.join(self.dir, "ffmpeg" + (".bat" if win else ""))
        if win:
            body = "@echo off\r\necho out_time_us=130000000\r\necho Invalid data found 1>&2\r\nexit /b 1\r\n"
        else:
            body = "#!/bin/sh\necho out_time_us=130000000\necho 'Invalid data found' >&2\nexit 1\n"
        with open(fake, "w", newline="") as f:
            f.write(body)
        os.chmod(fake, 0o755)
        p = self.put("a.m4a", make_m4a())
        with mock.patch.object(integrity, "have_ffmpeg", return_value=fake):
            v = integrity.check_file(p, deep=True)
        self.assertEqual(v.engine, "ffmpeg")
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "decoder error at 2:10: Invalid data found")
        self.assertAlmostEqual(v.error_at_seconds, 130, delta=0.01)


class Many(Base):
    def test_check_many_keeps_order_and_reports_progress(self):
        paths = [self.put(f"{i}.mp3", make_mp3(1, seed=i) if i % 2 else b"junk") for i in range(8)]
        seen = []
        for workers in (1, 4):
            seen.clear()
            res = integrity.check_many(paths, progress=lambda d, t, n: seen.append((d, t)), workers=workers)
            self.assertEqual([r.path for r in res], paths)
            self.assertEqual([r.level for r in res], ["fail", "ok"] * 4)
            self.assertEqual(len(seen), 8)
            self.assertEqual(max(seen)[1], 8)

    def test_check_many_honours_stop_event(self):
        paths = [self.put(f"{i}.mp3", make_mp3(1, seed=i)) for i in range(6)]
        stop = threading.Event()

        def prog(done, total, name):
            if done >= 2:
                stop.set()
        res = integrity.check_many(paths, progress=prog, stop=stop)
        self.assertEqual(len(res), 2)
        self.assertEqual([r.path for r in res], paths[:2])

    def test_summary_and_report(self):
        vs = [integrity.check_file(self.put("ok.mp3", make_mp3(1))),
              integrity.check_file(self.put("bad.mp3", b"x" * 2000)),
              integrity.check_file(self.put("n.txt", b"x"))]
        s = integrity.summarise(vs)
        self.assertEqual(s["by_level"], {"ok": 1, "warn": 0, "fail": 1, "unsupported": 1})
        self.assertEqual(s["worst"][0]["level"], "fail")
        out = os.path.join(self.dir, "rep.csv")
        txt = integrity.write_report(vs, out)
        self.assertTrue(os.path.getsize(out) > 0 and os.path.getsize(txt) > 0)
        with open(txt, encoding="utf-8") as fh:
            self.assertIn("bad.mp3", fh.read())


def _ref_crc8(data):
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0x07) & 0xFF if crc & 0x80 else (crc << 1) & 0xFF
    return crc


def _ref_ogg_crc(data):
    crc = 0
    for b in data:
        crc ^= b << 24
        for _ in range(8):
            crc = ((crc << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if crc & 0x80000000 else (crc << 1) & 0xFFFFFFFF
    return crc


def _ref_mp3_header(buf, pos, end):
    """The original, uncached frame-header parser (what _mp3_header must keep returning)."""
    if pos + 4 > end:
        return None
    b0, b1, b2, b3 = buf[pos], buf[pos + 1], buf[pos + 2], buf[pos + 3]
    if b0 != 0xFF or (b1 & 0xE0) != 0xE0:
        return None
    ver, layer_bits = (b1 >> 3) & 3, (b1 >> 1) & 3
    if ver == 1 or layer_bits == 0:
        return None
    layer = 4 - layer_bits
    bi, si = b2 >> 4, (b2 >> 2) & 3
    if bi == 15 or si == 3:
        return None
    sr = integrity._SR[ver][si]
    if bi == 0:
        return "free"
    br = (integrity._BR_V1 if ver == 3 else integrity._BR_V2)[layer][bi]
    pad = (b2 >> 1) & 1
    if layer == 1:
        length, spf = (12 * br * 1000 // sr + pad) * 4, 384
    elif layer == 2 or ver == 3:
        length, spf = 144 * br * 1000 // sr + pad, 1152
    else:
        length, spf = 72 * br * 1000 // sr + pad, 576
    return length, spf, sr, ver, layer, br, (b3 >> 6) == 3, (b1 & 1) == 0


class FastPaths(Base):
    def test_table_crcs_equal_the_bitwise_definitions(self):
        rng = random.Random(4)
        for n in (0, 1, 2, 5, 17, 300, 40000):
            data = bytes(rng.getrandbits(8) for _ in range(n))
            self.assertEqual(integrity._crc8(data), _ref_crc8(data), n)
            self.assertEqual(integrity._ogg_crc(data), _ref_ogg_crc(data), n)
            self.assertEqual(integrity._ogg_crc(bytearray(data)), _ref_ogg_crc(data), n)

    def test_header_parse_with_cache_equals_the_original_parser(self):
        rng = random.Random(11)
        for i in range(30000):
            h = bytearray(rng.getrandbits(8) for _ in range(4))
            if i % 3:
                h[0], h[1] = 0xFF, 0xE0 | (h[1] & 0x1F)   # force the sync bits so most parse
            buf = bytes(h) + b"\0" * 8
            want = _ref_mp3_header(buf, 0, len(buf))
            for _ in range(2):   # second time comes from the cache
                got = integrity._mp3_header(buf, 0, len(buf))
                if isinstance(want, tuple):
                    self.assertEqual(got[:8], want, bytes(h))
                elif want == "free":
                    self.assertIs(got, integrity._FREE)
                else:
                    self.assertIsNone(got)
        self.assertIsNone(integrity._mp3_header(b"\xff\xfb\x90", 0, 3))

    def test_walk_counts_every_frame_with_padding_and_cached_headers(self):
        for seconds in (1, 5):
            data = make_mp3(seconds, noisy=False, xing=False)
            nframes = int(seconds * 44100 / 1152)
            v = integrity.check_file(self.put("w.mp3", data))
            self.assertEqual(v.level, "ok", v.reasons)
            self.assertAlmostEqual(v.decoded_seconds, nframes * 1152 / 44100, places=6)

    def test_walk_still_sees_a_break_after_a_long_run_of_frames(self):
        data = make_mp3(10, noisy=False, xing=False)
        pos = 0
        while pos < len(data) // 2:
            pos += integrity._mp3_header(data, pos, len(data))[0]
        junk = bytes([1, 2, 3, 4, 5]) * 300
        v = integrity.check_file(self.put("brk.mp3", data[:pos] + junk + data[pos:]))
        self.assertIn(v.level, ("warn", "fail"))
        self.assertReason(v, "lost sync at 0:0")
        self.assertAlmostEqual(v.decoded_seconds, 10, delta=0.2)

    def test_one_stat_call_per_file_in_the_quick_pass(self):
        p = self.put("s.mp3", make_mp3(1, noisy=False))
        with mock.patch("os.stat", wraps=os.stat) as st:
            v = integrity.check_file(p)
        self.assertEqual(v.level, "ok", v.reasons)
        self.assertEqual(st.call_count, 1)

    def test_unicode_and_very_long_paths_are_checked(self):
        d = os.path.join(self.dir, "Björk 日本語 🎵", *["d" * 60] * 5)
        lp = integrity.long_path(d)
        os.makedirs(lp)
        p = os.path.join(d, "é" * 40 + ".wav")
        self.assertGreater(len(p), 260)
        make_wav(integrity.long_path(p), 1.0)
        v = integrity.check_file(p)
        self.assertEqual(v.level, "ok", v.reasons)
        self.assertGreater(v.size_bytes, 0)

    def test_directory_and_missing_file_are_reported_not_raised(self):
        self.assertEqual(integrity.check_file(self.dir).reasons, ["this is not a file"])
        self.assertEqual(integrity.check_file(os.path.join(self.dir, "x.mp3")).reasons, ["file not found"])

    def test_locked_file_is_a_failed_verdict_not_a_crash(self):
        if os.name != "nt":
            self.skipTest("exclusive file locks are a Windows thing")
        import ctypes
        k32 = ctypes.windll.kernel32
        k32.CreateFileW.restype = ctypes.c_void_p
        p = self.put("l.mp3", make_mp3(1))
        h = k32.CreateFileW(integrity.long_path(p), 0x80000000, 0, None, 3, 0x80, None)
        try:
            v = integrity.check_file(p)
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
        self.assertEqual(v.level, "fail")
        self.assertReason(v, "could not be checked")


class ProgressAndProcesses(Base):
    def test_progress_is_serialised_and_strictly_increasing_with_workers(self):
        """Bug: `done` was counted under the lock but the callback ran outside it, so worker threads
        could deliver 7 before 6, or run two callbacks at once."""
        paths = [os.path.join(self.dir, f"{i}.mp3") for i in range(300)]
        seen, inside, overlap = [], [0], []

        def prog(done, total, name):
            inside[0] += 1
            if inside[0] > 1:
                overlap.append(done)
            seen.append(done)
            if done % 7 == 0:
                time.sleep(0.001)
            inside[0] -= 1

        with mock.patch.object(integrity, "check_file", lambda p, deep=False: integrity.Verdict(p, ".mp3")):
            res = integrity.check_many(paths, progress=prog, workers=8)
        self.assertEqual(len(res), 300)
        self.assertEqual(seen, list(range(1, 301)))
        self.assertEqual(overlap, [])

    def test_a_raising_progress_callback_does_not_abort_the_check(self):
        paths = [self.put(f"{i}.mp3", make_mp3(1, seed=i)) for i in range(3)]

        def boom(*a):
            raise RuntimeError("GUI went away")
        for workers in (1, 3):
            self.assertEqual(len(integrity.check_many(paths, progress=boom, workers=workers)), 3)

    def test_ffmpeg_runs_without_a_console_window(self):
        calls = []

        def fake_run(cmd, **kw):
            calls.append(kw)
            return subprocess.CompletedProcess(cmd, 0, b"out_time_us=1000000\n", b"")

        d = integrity._Deep()
        with mock.patch.object(integrity, "have_ffmpeg", return_value="ffmpeg-here"), \
                mock.patch("subprocess.run", fake_run):
            integrity._deep_ffmpeg(self.put("a.opus", b"x"), None, d)
        self.assertEqual(calls[0].get("creationflags", 0), 0x08000000 if os.name == "nt" else 0)
        self.assertEqual(d.reasons, [])


if __name__ == "__main__":
    unittest.main()
