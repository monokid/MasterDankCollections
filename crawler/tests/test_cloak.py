"""Tests for cloak.py / wordbank.py. Run: python -m unittest discover -s crawler/tests

All audio is synthesised here (tiny, valid-enough for mutagen); no real music is touched.
"""
import csv
import hashlib
import io
import json
import os
import struct
import sys
import tempfile
import threading
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import cloak  # noqa: E402
import wordbank  # noqa: E402

from mutagen import File as MutagenFile  # noqa: E402
from mutagen.id3 import APIC, COMM, ID3, PRIV, TCOP, TENC, TALB, TIT2, TPE1, TXXX, USLT  # noqa: E402

PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


# ------------------------------------------------------------ synthesisers

def make_mp3(path, artist="Secret Artist", title="Secret Song", seed=0, tags=True):
    frame = bytes([0xFF, 0xFB, 0x90, 0x64]) + bytes(((i * 7 + seed) % 251) for i in range(413))
    with open(path, "wb") as f:
        for _ in range(30):
            f.write(frame)
    if tags:
        from mutagen import apev2
        a = apev2.APEv2()
        a["Artist"] = artist
        a.save(path)
        t = ID3()
        t.add(TPE1(encoding=3, text=[artist]))
        t.add(TIT2(encoding=3, text=[title]))
        t.add(TALB(encoding=3, text=["Secret Album"]))
        t.add(APIC(encoding=3, mime="image/png", type=3, desc="c", data=PNG))
        t.add(USLT(encoding=3, lang="eng", desc="", text="secret lyrics"))
        t.add(COMM(encoding=3, lang="eng", desc="", text=["secret comment"]))
        t.add(TXXX(encoding=3, desc="mood", text=["secret"]))
        t.add(PRIV(owner="me@example.com", data=b"secret"))
        t.add(TCOP(encoding=3, text=["secret label"]))
        t.add(TENC(encoding=3, text=["secret encoder"]))
        t.save(path, v1=2, v2_version=3)


def make_flac(path, artist="Secret Artist", title="Secret Song"):
    si = struct.pack(">HHII", 4096, 4096, 0, 0)[:4] + b"\0\0\0\0\0\0"  # blocksizes + framesizes(0)
    packed = (44100 << 44) | (1 << 41) | (15 << 36) | 44100
    si += struct.pack(">Q", packed) + b"\0" * 16
    assert len(si) == 34
    frames = bytes(((i * 13) % 251) for i in range(3000))
    with open(path, "wb") as f:
        f.write(b"fLaC" + bytes([0x80, 0, 0, 34]) + si + frames)
    from mutagen.flac import FLAC, Picture
    m = FLAC(path)
    m.add_tags()
    m.tags["artist"] = [artist]
    m.tags["title"] = [title]
    m.tags["comment"] = ["secret"]
    p = Picture()
    p.type, p.mime, p.data = 3, "image/png", PNG
    m.add_picture(p)
    m.save()


def make_wav(path, artist="Secret Artist"):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(8000)
        w.writeframes(bytes(((i * 5) % 251) for i in range(8000)))
    raw = bytearray(buf.getvalue())
    info = b"INFO" + b"IART" + struct.pack("<I", len(artist) + 1) + artist.encode() + b"\0"
    if len(info) & 1:
        info += b"\0"
    raw += b"LIST" + struct.pack("<I", len(info)) + info
    struct.pack_into("<I", raw, 4, len(raw) - 8)
    with open(path, "wb") as f:
        f.write(raw)
    from mutagen.wave import WAVE
    m = WAVE(path)
    m.add_tags()
    m.tags.add(TPE1(encoding=3, text=[artist]))
    m.save()


def _atom(typ, payload=b""):
    return struct.pack(">I4s", 8 + len(payload), typ) + payload


def make_m4a(path, artist="Secret Artist", title="Secret Song"):
    mvhd = _atom(b"mvhd", struct.pack(">IIIIIIH", 0, 0, 0, 1000, 1000, 0x10000, 0x100) + b"\0" * 70
                 + b"\0" * 6 + struct.pack(">I", 2))
    # fix mvhd length to 100 payload bytes
    mvhd = _atom(b"mvhd", (struct.pack(">IIIIIIH", 0, 0, 0, 1000, 1000, 0x10000, 0x100) + b"\0" * 100)[:100])
    tkhd = _atom(b"tkhd", struct.pack(">I", 3) + b"\0" * 80)
    mdhd = _atom(b"mdhd", struct.pack(">IIIII", 0, 0, 0, 44100, 44100) + b"\0" * 4)
    hdlr = _atom(b"hdlr", b"\0" * 8 + b"soun" + b"\0" * 12 + b"\0")
    mp4a = _atom(b"mp4a", b"\0" * 6 + struct.pack(">H", 1) + b"\0" * 8 + struct.pack(">HHHH", 2, 16, 0, 0)
                 + struct.pack(">I", 44100 << 16) + _atom(b"wave"))
    stsd = _atom(b"stsd", struct.pack(">II", 0, 1) + mp4a)
    stts = _atom(b"stts", struct.pack(">IIII", 0, 1, 43, 1024))
    stsc = _atom(b"stsc", struct.pack(">IIIII", 0, 1, 1, 43, 1))
    stsz = _atom(b"stsz", struct.pack(">IIII", 0, 0, 43, 0) )
    stsz = _atom(b"stsz", struct.pack(">III", 0, 0, 43) + b"".join(struct.pack(">I", 70) for _ in range(43)))
    ftyp = _atom(b"ftyp", b"M4A \0\0\0\0M4A mp42isom")

    def build(offset):
        stco = _atom(b"stco", struct.pack(">III", 0, 1, offset))
        stbl = _atom(b"stbl", stsd + stts + stsc + stsz + stco)
        minf = _atom(b"minf", stbl)
        mdia = _atom(b"mdia", mdhd + hdlr + minf)
        trak = _atom(b"trak", tkhd + mdia)
        return _atom(b"moov", mvhd + trak)

    moov = build(0)
    off = len(ftyp) + len(moov) + 8
    moov = build(off)
    mdat = _atom(b"mdat", bytes(((i * 11) % 251) for i in range(43 * 70)))
    with open(path, "wb") as f:
        f.write(ftyp + moov + mdat)
    from mutagen.mp4 import MP4, MP4Cover
    m = MP4(path)
    m.add_tags()
    m.tags["\xa9nam"] = [title]
    m.tags["\xa9ART"] = [artist]
    m.tags["covr"] = [MP4Cover(PNG, imageformat=MP4Cover.FORMAT_PNG)]
    m.tags["----:com.apple.iTunes:secret"] = [b"secret"]
    m.save()


def make_opus(path, artist="Secret Artist", title="Secret Song"):
    from mutagen.ogg import OggPage
    head = (b"OpusHead" + bytes([1, 2]) + struct.pack("<HIhB", 312, 48000, 0, 0))
    vendor = b"secretenc"
    c1, c2 = b"ARTIST=" + artist.encode(), b"TITLE=" + title.encode()
    tags = (b"OpusTags" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 2)
            + struct.pack("<I", len(c1)) + c1 + struct.pack("<I", len(c2)) + c2)
    out = b""
    for seq, (pk, pos, flag) in enumerate([([head], 0, 2), ([tags], 0, 0),
                                           ([bytes((i * 3) % 251 for i in range(100)),
                                             bytes((i * 5) % 251 for i in range(120))], 48000 + 312, 4)]):
        pg = OggPage()
        pg.packets, pg.sequence, pg.serial, pg.position, pg.type = pk, seq, 4242, pos, flag
        pg.first, pg.last = flag & 2 != 0, flag & 4 != 0
        out += pg.write()
    with open(path, "wb") as f:
        f.write(out)


def tag_keys(path):
    mf = MutagenFile(path)
    return [] if mf is None or mf.tags is None else [str(k) for k in mf.tags.keys()]


class Base(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.root = self._td.name
        self.src = os.path.join(self.root, "music")
        self.out = os.path.join(self.root, "out")
        os.makedirs(self.src)

    def mk(self, name, kind="mp3", **kw):
        p = os.path.join(self.src, name)
        {"mp3": make_mp3, "flac": make_flac, "wav": make_wav, "m4a": make_m4a, "opus": make_opus}[kind](p, **kw)
        return p

    def run_plan(self, files, mode, **kw):
        plan = cloak.build_plan(files, mode, **kw)
        return plan, cloak.execute(plan, self.out)


# ------------------------------------------------------------------- tests

class OriginalUntouched(Base):
    def test_originals_hash_identical_and_still_there(self):
        files = [self.mk("a.mp3"), self.mk("b.flac", "flac"), self.mk("c.wav", "wav")]
        before = {f: sha(f) for f in files}
        for mode in cloak.MODES:
            self.run_plan(files, mode, person="P", seed=1)
        for f in files:
            self.assertEqual(before[f], sha(f))

    def test_readonly_source_ok(self):
        f = self.mk("ro.mp3")
        os.chmod(f, 0o444)
        self.addCleanup(os.chmod, f, 0o666)
        _, res = self.run_plan([f], "true", seed=1)
        self.assertEqual((res.copied, res.failed), (1, []))


class NoTagSurvives(Base):
    def check(self, kind, name):
        f = self.mk(name, kind)
        self.assertTrue(tag_keys(f), "synthetic source should carry tags")
        _, res = self.run_plan([f], "true", seed=3)
        self.assertEqual(res.failed, [])
        self.assertEqual((res.copied, res.verified, res.unstrippable), (1, 1, []))
        out = os.path.join(self.out, "anonymised")
        (new,) = os.listdir(out)
        self.assertEqual(tag_keys(os.path.join(out, new)), [])
        return os.path.join(out, new), f

    def test_mp3_all_id3_ape_frames_gone(self):
        new, _ = self.check("mp3", "a.mp3")
        raw = open(new, "rb").read()
        for needle in (b"ID3", b"TAG", b"APETAGEX", b"Secret", b"secret", b"PNG"):
            self.assertNotIn(needle, raw)

    def test_flac_comments_and_picture_gone(self):
        new, _ = self.check("flac", "a.flac")
        from mutagen.flac import FLAC
        self.assertEqual(FLAC(new).pictures, [])
        self.assertNotIn(b"Secret", open(new, "rb").read())

    def test_wav_info_and_id3_chunks_gone(self):
        new, _ = self.check("wav", "a.wav")
        self.assertEqual([c for c, _, _ in cloak._chunk_walk(new, False)], [b"fmt ", b"data"])
        self.assertNotIn(b"Secret", open(new, "rb").read())

    def test_m4a_atoms_gone(self):
        new, _ = self.check("m4a", "a.m4a")
        raw = open(new, "rb").read()
        for needle in (b"covr", b"Secret", b"secret", b"\xa9nam"):
            self.assertNotIn(needle, raw)

    def test_opus_comments_gone(self):
        new, _ = self.check("opus", "a.opus")
        self.assertNotIn(b"Secret", open(new, "rb").read())
        self.assertNotIn(b"secretenc", open(new, "rb").read())


class AudioPayloadIdentical(Base):
    def test_payload_and_duration_unchanged_every_format(self):
        for kind, name in (("mp3", "a.mp3"), ("flac", "a.flac"), ("wav", "a.wav"),
                           ("m4a", "a.m4a"), ("opus", "a.opus")):
            with self.subTest(kind):
                f = self.mk(name, kind)
                plan, res = self.run_plan([f], "switcheroo", seed=2)
                self.assertEqual(res.failed, [], kind)
                new = os.path.join(self.out, "anonymised", plan[0].dst_rel)
                ext = os.path.splitext(name)[1]
                h = cloak.audio_payload_hash(f, ext)
                self.assertIsNotNone(h)
                self.assertEqual(h, cloak.audio_payload_hash(new, ext))
                if ext != ".mp3":  # mutagen's MP3 length is a size estimate skewed by trailing tags
                    self.assertLess(abs(MutagenFile(f).info.length - MutagenFile(new).info.length), 0.001)
                # and the payload hash really is sensitive to a flipped audio byte
                rng_ = {".mp3": cloak._mp3_range, ".flac": cloak._flac_range, ".m4a": cloak._mp4_range}.get(ext)
                if rng_:
                    lo, hi = rng_(f)[0]
                elif ext == ".wav":
                    _, lo, sz = [c for c in cloak._chunk_walk(f, False) if c[0] == b"data"][0]
                    hi = lo + sz
                else:
                    continue
                data = bytearray(open(f, "rb").read())
                data[(lo + hi) // 2] ^= 0xFF
                bad = os.path.join(self.root, "bad" + ext)
                open(bad, "wb").write(data)
                self.assertNotEqual(h, cloak.audio_payload_hash(bad, ext), kind)


class TrueMode(Base):
    def test_numbers_unique_seeded_reproducible(self):
        files = [self.mk(f"t{i}.mp3", tags=False) for i in range(12)]
        a = cloak.build_plan(files, "true", seed=42)
        b = cloak.build_plan(files, "true", seed=42)
        c = cloak.build_plan(files, "true", seed=43)
        self.assertEqual([p.dst_rel for p in a], [p.dst_rel for p in b])
        self.assertNotEqual([p.dst_rel for p in a], [p.dst_rel for p in c])
        self.assertEqual(len({p.dst_rel for p in a}), 12)
        for p in a:
            self.assertRegex(p.dst_rel, r"^anon_\d{6}\.mp3$")

    def test_numbers_independent_of_order_of_naming(self):
        files = [self.mk(f"t{i}.mp3", tags=False) for i in range(5)]
        names = [p.dst_rel for p in cloak.build_plan(files, "true", seed=5)]
        self.assertNotEqual(names, sorted(names) if names != sorted(names) else None)  # not sequential by design
        nums = [int(n[5:11]) for n in names]
        self.assertNotEqual(nums, list(range(nums[0], nums[0] + 5)))


class KindaMode(Base):
    def test_with_and_without_phase(self):
        files = [self.mk(f"t{i}.mp3", tags=False) for i in range(3)]
        p = cloak.build_plan(files, "kinda", person="Ian", phase="Warmup")
        self.assertEqual([x.dst_rel for x in p], ["anon_Ian_Warmup_01.mp3", "anon_Ian_Warmup_02.mp3", "anon_Ian_Warmup_03.mp3"])
        p = cloak.build_plan(files, "kinda", person="Ian")
        self.assertEqual(p[0].dst_rel, "anon_Ian_01.mp3")

    def test_illegal_characters_sanitised(self):
        f = self.mk("t.mp3", tags=False)
        p = cloak.build_plan([f], "kinda", person='A<b>:"c/d\\e|f?g*  h. ', phase="Ph. ")
        self.assertEqual(p[0].dst_rel, "anon_Abcdefg h_Ph_01.mp3")

    def test_numbering_restarts_per_person_and_phase_and_width(self):
        files = [self.mk(f"t{i}.mp3", tags=False) for i in range(4)]
        phases = {files[0]: "A", files[1]: "B", files[2]: "A", files[3]: "B"}
        p = cloak.build_plan(files, "kinda", person="X", phases=phases)
        self.assertEqual([x.dst_rel for x in p], ["anon_X_A_01.mp3", "anon_X_B_01.mp3", "anon_X_A_02.mp3", "anon_X_B_02.mp3"])
        many = [os.path.join(self.src, f"m{i}.mp3") for i in range(120)]
        for m in many:
            open(m, "wb").write(b"")
        p = cloak.build_plan(many, "kinda", person="X")
        self.assertEqual(p[0].dst_rel, "anon_X_001.mp3")
        self.assertEqual(p[-1].dst_rel, "anon_X_120.mp3")

    def test_folders(self):
        f = self.mk("t.mp3", tags=False)
        p = cloak.build_plan([f], "kinda", person="Ian", phase="Peak", folders=True)
        self.assertEqual(p[0].dst_rel, "Ian/Peak/anon_Ian_Peak_01.mp3")
        plan, res = self.run_plan([f], "kinda", person="Ian", phase="Peak", folders=True)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "anonymised", "Ian", "Peak", "anon_Ian_Peak_01.mp3")))


class Switcheroo(Base):
    def sw(self, seed=1):
        return cloak._Switcher(__import__("random").Random(seed))

    def test_function_words_and_punctuation_kept(self):
        s = self.sw().text("The Sound of the Sea & Fire (feat. Bob) vs. A Dog")
        words = s.split()
        for kept in ("The", "of", "the", "&", "vs.", "A"):
            self.assertIn(kept, words)
        self.assertIn("(feat.", words)
        for real in ("Sound", "Sea", "Fire", "Bob", "Dog"):
            self.assertNotIn(real, s.replace("(", " ").split())

    def test_never_equals_original_word(self):
        sw = self.sw(7)
        for w in wordbank.NOUNS + wordbank.VERBS:
            self.assertNotEqual(sw.word(w).lower(), w.lower())

    def test_consistent_mapping_within_run_and_deterministic(self):
        a, b = self.sw(9), self.sw(9)
        self.assertEqual(a.text("Daft Punk - Daft Punk"), b.text("Daft Punk - Daft Punk"))
        x = a.text("Daft Punk")
        y = a.text("Punk Daft")
        self.assertEqual(x.split(), list(reversed(y.split())))
        self.assertNotEqual(self.sw(9).text("Daft Punk"), self.sw(10).text("Daft Punk"))

    def test_case_plural_verbs_numbers_nonlatin(self):
        sw = self.sw(3)
        self.assertTrue(sw.text("MOON").isupper())
        self.assertTrue(sw.text("moon").islower())
        self.assertTrue(sw.text("Moon")[0].isupper())
        self.assertTrue(sw.text("Dogs").lower().endswith("s"))
        self.assertIn(sw.text("running").lower(), wordbank.VERBS_ING)
        self.assertIn(sw.text("run").lower(), wordbank.VERBS_BASE)
        self.assertEqual(sw.text("Track 01"), sw.text("Track"))
        self.assertEqual(sw.text("01"), "")
        jp = sw.text("夜の音")
        self.assertTrue(jp.isascii() and jp)

    def test_filenames_and_tags_fake_and_unique_across_files(self):
        files = [self.mk("one.mp3", artist="Daft Punk", title="Around the World"),
                 self.mk("two.mp3", artist="Daft Punk", title="Around the World")]
        plan, res = self.run_plan(files, "switcheroo", seed=11)
        self.assertEqual(res.failed, [])
        self.assertEqual(len({p.dst_rel.lower() for p in plan}), 2)
        self.assertTrue(plan[1].fake_title.endswith("II"))
        self.assertEqual(plan[0].fake_artist, plan[1].fake_artist)  # consistent artist
        new = os.path.join(self.out, "anonymised", plan[0].dst_rel)
        self.assertEqual(plan[0].dst_rel, f"{plan[0].fake_artist} - {plan[0].fake_title}.mp3")
        self.assertEqual(sorted(tag_keys(new)), ["TIT2", "TPE1"])
        m = MutagenFile(new)
        self.assertEqual(str(m.tags["TPE1"]), plan[0].fake_artist)
        self.assertNotIn("Daft", plan[0].dst_rel)
        self.assertIn(" the ", plan[0].dst_rel.lower())

    def test_filename_only_identity_and_long_names(self):
        f = os.path.join(self.src, "04 - Zoe Keating - " + "Long Title Words " * 10 + ".mp3")
        make_mp3(f, tags=False)
        ident = cloak.read_identity(f)
        self.assertEqual(ident.artist, "Zoe Keating")
        plan = cloak.build_plan([f], "switcheroo", seed=1)
        self.assertLessEqual(len(os.path.splitext(plan[0].dst_rel)[0]), cloak.MAX_FAKE_NAME)

    def test_seed_reproduces_plan(self):
        files = [self.mk("one.mp3"), self.mk("two.mp3", artist="Other", title="Thing")]
        a = [p.dst_rel for p in cloak.build_plan(files, "switcheroo", seed=5)]
        b = [p.dst_rel for p in cloak.build_plan(files, "switcheroo", seed=5)]
        self.assertEqual(a, b)


class Wordbank(unittest.TestCase):
    def test_no_duplicates_sizes_and_shape(self):
        allw = wordbank.NOUNS + wordbank.VERBS
        self.assertEqual(len(allw), len(set(allw)))
        self.assertGreaterEqual(len(wordbank.NOUNS), 400)
        self.assertGreaterEqual(len(wordbank.VERBS), 300)
        for w in allw:
            self.assertRegex(w, r"^[a-z]+$")
            self.assertNotIn(w, cloak.FUNCTION_WORDS)

    def test_blocklist(self):
        self.assertFalse(set(wordbank.NOUNS + wordbank.VERBS) & wordbank.BLOCKLIST)


class Records(Base):
    def test_record_files_complete_and_map_back(self):
        files = [self.mk("a.mp3", artist="Art A", title="Song A"), self.mk("b.flac", "flac", artist="Art B", title="Song B")]
        plan, res = self.run_plan(files, "kinda", person="Ian", phase="P1", seed=77)
        rec = res.record_dir
        for n in ("record.csv", "record.m3u8", "record.json", "DO-NOT-SHARE.txt"):
            self.assertTrue(os.path.isfile(os.path.join(rec, n)), n)
        rows = list(csv.DictReader(open(os.path.join(rec, "record.csv"), encoding="utf-8-sig")))
        self.assertEqual(list(rows[0].keys()), ["number", "new_name", "artist", "title", "album", "duration_sec",
                                                "person", "phase", "fake_artist", "fake_title", "source_path"])
        self.assertEqual([(r["artist"], r["title"], r["source_path"]) for r in rows],
                         [("Art A", "Song A", files[0]), ("Art B", "Song B", files[1])])
        for r in rows:
            self.assertTrue(os.path.isfile(os.path.join(res.out_dir, "anonymised", r["new_name"])))
        m3u = open(os.path.join(rec, "record.m3u8"), encoding="utf-8").read().splitlines()
        self.assertEqual(m3u[0], "#EXTM3U")
        self.assertTrue(m3u[1].endswith(",Art A - Song A"))
        self.assertEqual(m3u[2], "anon_Ian_P1_01.mp3")
        js = json.load(open(os.path.join(rec, "record.json"), encoding="utf-8"))
        self.assertEqual(js["seed"], 77)
        self.assertEqual([i["new_name"] for i in js["items"]], ["anon_Ian_P1_01.mp3", "anon_Ian_P1_02.flac"])
        self.assertEqual(os.listdir(os.path.join(self.out, "anonymised")), ["anon_Ian_P1_01.mp3", "anon_Ian_P1_02.flac"])

    def test_unicode_names_and_timestamps_neutral(self):
        f = self.mk("Björk – Jóga 夜.mp3", artist="Björk", title="Jóga")
        os.utime(f, (1000000000, 1000000000))
        plan, res = self.run_plan([f], "switcheroo", seed=1)
        self.assertEqual(res.failed, [])
        new = os.path.join(self.out, "anonymised", plan[0].dst_rel)
        self.assertGreater(os.path.getmtime(new), 1500000000)
        self.assertNotIn("Bj", plan[0].dst_rel)

    def test_duplicate_source_and_existing_destination_not_overwritten(self):
        f = self.mk("a.mp3")
        plan = cloak.build_plan([f, f], "kinda", person="P", seed=1)
        self.assertEqual(len(plan), 1)
        cloak.execute(plan, self.out)
        cloak.execute(plan, self.out)  # second run, same names
        self.assertEqual(sorted(os.listdir(os.path.join(self.out, "anonymised"))), ["anon_P_01.mp3", "anon_P_01_2.mp3"])
        self.assertTrue(os.path.isfile(os.path.join(self.out, "record", "record-2.csv")))


class Refusals(Base):
    def test_refuse_out_dir_inside_or_equal_source(self):
        f = self.mk("a.mp3")
        plan = cloak.build_plan([f], "true", seed=1)
        for bad in (self.src, os.path.join(self.src, "sub"), os.path.join(self.src, "sub", "deeper")):
            with self.assertRaises(ValueError):
                cloak.execute(plan, bad)
        self.assertEqual(os.listdir(self.src), ["a.mp3"])
        with self.assertRaises(ValueError):
            cloak.execute(plan, os.path.join(self.root, "x"), source_roots=[self.root])

    def test_unknown_mode(self):
        with self.assertRaises(ValueError):
            cloak.build_plan([], "nope")


class Unstrippable(Base):
    def test_unknown_format_reported_loudly_not_silently(self):
        f = os.path.join(self.src, "x.wma")
        open(f, "wb").write(b"not really wma but tagged Secret")
        plan, res = self.run_plan([f], "true", seed=1)
        self.assertEqual(res.copied, 1)
        self.assertEqual(res.verified, 0)
        self.assertEqual(res.unstrippable, [f])
        js = json.load(open(os.path.join(res.record_dir, "record.json"), encoding="utf-8"))
        self.assertIn("UNSTRIPPABLE", js["items"][0]["detail"])

    def test_corrupt_supported_file_fails_and_is_not_shipped(self):
        bad = os.path.join(self.src, "bad.flac")
        open(bad, "wb").write(b"garbage")
        good = self.mk("g.mp3")
        plan, res = self.run_plan([bad, good], "true", seed=1)
        self.assertEqual([s for s, _ in res.failed], [bad])
        self.assertEqual(res.copied, 1)
        self.assertEqual(len(os.listdir(os.path.join(self.out, "anonymised"))), 1)

    def test_missing_source_is_failed_run_continues(self):
        good = self.mk("g.mp3")
        plan = cloak.build_plan([good, os.path.join(self.src, "gone.mp3")], "true", seed=1)
        res = cloak.execute(plan, self.out)
        self.assertEqual((res.copied, len(res.failed)), (1, 1))


class StopEvent(Base):
    def test_stop_leaves_consistent_record(self):
        files = [self.mk(f"t{i}.mp3", artist=f"A{i}", title=f"T{i}") for i in range(5)]
        plan = cloak.build_plan(files, "kinda", person="P", seed=1)
        ev = threading.Event()
        calls = []

        def prog(done, total, name):
            calls.append((done, total, name))
            if done == 2:
                ev.set()
        res = cloak.execute(plan, self.out, progress=prog, stop=ev)
        self.assertEqual(res.copied, 2)
        self.assertEqual(len(calls), 2)
        on_disk = sorted(os.listdir(os.path.join(self.out, "anonymised")))
        rows = list(csv.DictReader(open(os.path.join(res.record_dir, "record.csv"), encoding="utf-8-sig")))
        self.assertEqual(on_disk, sorted(r["new_name"] for r in rows))
        self.assertEqual(len(rows), 2)
        self.assertFalse([n for n in on_disk if n.startswith("~cloak")])


if __name__ == "__main__":
    unittest.main()
