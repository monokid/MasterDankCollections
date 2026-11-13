"""Tests for scanner.py. All audio is synthesised here (no real music).
Run: python -m unittest discover -s crawler/tests
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import scanner  # noqa: E402

from mutagen import File as MutagenFile  # noqa: E402
from mutagen.id3 import COMM, ID3, TALB, TCON, TDRC, TIT2, TPE1, TPE2, TXXX  # noqa: E402

FRAME = bytes([0xFF, 0xFB, 0x90, 0x64]) + bytes(((i * 7) % 251) for i in range(413))


def make_mp3(path, frames=(), v2_version=3, **kw):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(FRAME * 30)
    if frames:
        t = ID3()
        for fr in frames:
            t.add(fr)
        t.save(path, v2_version=v2_version)


def tagged(artist="An Artist", title="A Title"):
    return [TPE1(encoding=3, text=[artist]), TIT2(encoding=3, text=[title])]


def doc_without_clock(d):
    d = dict(d)
    for k in ("elapsed_sec", "scanned_at", "machine"):
        d.pop(k)
    return d


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-scan-")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def p(self, *parts):
        return os.path.join(self.tmp, *parts)

    def write(self, rel, data=b"x"):
        path = self.p(*rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        return path


class DocumentShape(Tmp):
    def test_counts_records_and_exclusions(self):
        make_mp3(self.p("A", "01 One.mp3"), tagged())
        make_mp3(self.p("A", "02 Two.mp3"))
        self.write("A/cover.jpg")
        self.write("B/clip.mp4", b"x" * 40)
        self.write("junk.flac", os.urandom(3000))
        os.makedirs(self.p("empty"))
        d = scanner.scan(self.tmp, use_cache=False)
        self.assertEqual(d["schema"], "mdc-crawl/2")
        c = d["counts"]
        self.assertEqual((c["media"], c["excluded"], c["seen"], c["dirs"]), (4, 1, 5, 3))
        self.assertEqual(c["with_tags"], 1)
        self.assertEqual(c["by_ext"], {".mp3": 2, ".mp4": 1, ".flac": 1})
        self.assertEqual(c["excluded_by_ext"], {".jpg": 1})
        self.assertEqual(d["excluded_sample"], ["A/cover.jpg"])
        self.assertEqual(sorted(map(tuple, d["dirs"])), [("A",), ("B",), ("empty",)])
        by_path = {"/".join(f["p"]): f for f in d["files"]}
        one = by_path["A/01 One.mp3"]
        self.assertEqual(one["ext"], ".mp3")
        self.assertEqual(one["t"]["TPE1"], ["An Artist"])
        self.assertEqual(one["e"], {"artist": "An Artist", "title": "A Title"})
        self.assertEqual(one["sz"], os.path.getsize(self.p("A", "01 One.mp3")))
        self.assertIn("err", by_path["junk.flac"])
        self.assertEqual(c["errors"], len(d["errors"]))

    def test_binary_frames_are_marked_not_dumped(self):
        from mutagen.id3 import APIC
        make_mp3(self.p("a.mp3"), tagged() + [APIC(encoding=3, mime="image/png", type=3, desc="c", data=b"\x89PNG" * 50)])
        d = scanner.scan(self.tmp, use_cache=False)
        self.assertEqual(d["files"][0]["t"]["APIC:c"], ["<binary>"])

    def test_the_crawlers_own_files_are_not_listed(self):
        make_mp3(self.p("a.mp3"), tagged())
        self.write(scanner.CACHE_NAME, b"{}")
        self.write("mdc-crawl-x-20260101-0000.json", b"{}")
        d = scanner.scan(self.tmp, use_cache=False)
        self.assertEqual(["/".join(f["p"]) for f in d["files"]], ["a.mp3"])
        self.assertEqual(d["counts"]["excluded"], 0)

    def test_unicode_and_very_long_names(self):
        names = ["Björk – Ünïcödé ☃ 日本語 🎵.mp3", "école.mp3", "h" * 200 + ".mp3"]
        for n in names:
            make_mp3(self.p(n), tagged())
        d = scanner.scan(self.tmp, use_cache=False)
        self.assertEqual(sorted(f["p"][0] for f in d["files"]), sorted(names))
        self.assertTrue(all(f["t"] for f in d["files"]))

    def test_zero_byte_file_is_an_error_record_not_a_crash(self):
        self.write("zero.mp3", b"")
        d = scanner.scan(self.tmp, use_cache=False)
        rec = d["files"][0]
        self.assertEqual(rec["sz"], 0)
        self.assertTrue(rec["err"])
        self.assertEqual(d["counts"]["errors"], 1)

    def test_missing_root_gives_an_empty_document(self):
        d = scanner.scan(self.p("nope"), use_cache=False)
        self.assertEqual((d["counts"]["files"], d["counts"]["dirs"]), (0, 0))

    def test_output_filename_is_safe(self):
        name = scanner.output_filename("My: Mix/ 2026*")
        self.assertRegex(name, r"^mdc-crawl-MyMix2026-\d{8}-\d{4}\.json$")


class EasyView(Tmp):
    def slow_easy(self, path):
        """The pre-optimisation way: parse the file a second time with easy=True."""
        out = {}
        mf2 = MutagenFile(path, easy=True)
        if mf2 is not None and mf2.tags:
            for k, v in mf2.tags.items():
                val = v[0] if isinstance(v, list) and v else v
                if val:
                    out[str(k)] = str(val)[:scanner.MAX_TAG_VALUE]
        return out

    def test_easy_tags_taken_from_the_parsed_id3_match_a_second_easy_parse(self):
        cases = {
            "v23.mp3": (3, tagged("Ünï/cödé", "Täg") + [TALB(encoding=1, text=["Alb"]), TCON(encoding=3, text=["Rock"])]),
            "v24.mp3": (4, tagged() + [TDRC(encoding=3, text=["2001-02-03"]), TPE2(encoding=3, text=["AA"]),
                                       TXXX(encoding=3, desc="MOOD", text=["calm"]),
                                       COMM(encoding=3, lang="eng", desc="d", text=["hi"])]),
            "long.mp3": (3, [TIT2(encoding=3, text=["t" * 900])]),
        }
        for name, (ver, frames) in cases.items():
            path = self.p(name)
            make_mp3(path, frames, v2_version=ver)
            audio, raw, easy, err = scanner.read_metadata(path)
            self.assertIsNone(err, name)
            self.assertEqual(easy, self.slow_easy(path), name)
            self.assertTrue(raw, name)

    def test_mp3_without_any_tag_has_no_easy_view(self):
        make_mp3(self.p("bare.mp3"))
        audio, raw, easy, err = scanner.read_metadata(self.p("bare.mp3"))
        self.assertEqual((raw, easy, err), ({}, {}, None))
        self.assertIn("dur", audio)

    def test_mp3_is_parsed_only_once(self):
        make_mp3(self.p("a.mp3"), tagged())
        import mutagen
        with mock.patch.object(mutagen, "File", wraps=mutagen.File) as f:
            scanner.read_metadata(self.p("a.mp3"))
        self.assertEqual(f.call_count, 1)

    def test_unreadable_garbage_reports_the_error(self):
        self.write("x.flac", b"not flac at all" * 10)
        audio, raw, easy, err = scanner.read_metadata(self.p("x.flac"))
        self.assertTrue(err)
        self.assertEqual((audio, raw, easy), ({}, {}, {}))


class CacheAndCancel(Tmp):
    def test_cache_hit_skips_reading_and_gives_the_same_document(self):
        for i in range(4):
            make_mp3(self.p("m%d.mp3" % i), tagged("A%d" % i, "T%d" % i))
        first = scanner.scan(self.tmp)
        with mock.patch.object(scanner, "read_metadata", side_effect=AssertionError("must come from cache")):
            second = scanner.scan(self.tmp)
        self.assertEqual(second["counts"]["cache_hits"], 4)
        a, b = doc_without_clock(first), doc_without_clock(second)
        for d in (a, b):
            d["counts"].pop("cache_hits")
        self.assertEqual(a, b)

    def test_changed_file_is_read_again(self):
        make_mp3(self.p("a.mp3"), tagged("Old", "T"))
        scanner.scan(self.tmp)
        make_mp3(self.p("a.mp3"), tagged("New", "T") + [TALB(encoding=3, text=["more bytes"])])
        d = scanner.scan(self.tmp)
        self.assertEqual(d["counts"]["cache_hits"], 0)
        self.assertEqual(d["files"][0]["e"]["artist"], "New")

    def test_stopping_marks_the_document_partial_and_does_not_write_the_cache(self):
        for i in range(6):
            make_mp3(self.p("m%d.mp3" % i), tagged())
        calls = []

        def stop():
            calls.append(1)
            return len(calls) > 2

        d = scanner.scan(self.tmp, should_stop=stop)
        self.assertTrue(d["partial"])
        self.assertEqual(d["counts"]["files"], 2)
        self.assertFalse(os.path.exists(self.p(scanner.CACHE_NAME)))

    def test_a_bad_cache_file_is_ignored(self):
        make_mp3(self.p("a.mp3"), tagged())
        for junk in (b"not json", b"[1,2]", b'{"schema": "other"}', b""):
            self.write(scanner.CACHE_NAME, junk)
            self.assertEqual(scanner.scan(self.tmp)["counts"]["cache_hits"], 0)

    def test_failed_cache_save_leaves_no_tmp_and_does_not_fail_the_scan(self):
        make_mp3(self.p("a.mp3"), tagged())
        with mock.patch("os.replace", side_effect=PermissionError("locked")):
            d = scanner.scan(self.tmp)
        self.assertEqual(d["counts"]["files"], 1)
        self.assertEqual(os.listdir(self.tmp), ["a.mp3"])

    def test_progress_runs_to_total_and_starts_with_a_counting_message(self):
        for i in range(3):
            make_mp3(self.p("m%d.mp3" % i), tagged())
        seen = []
        scanner.scan(self.tmp, progress=lambda d, t, n: seen.append((d, t)), use_cache=False)
        self.assertEqual(seen[0], (0, 0))
        self.assertEqual(seen[1:], [(1, 3), (2, 3), (3, 3)])


class FilesChangingUnderneath(Tmp):
    def test_file_that_vanishes_mid_scan_is_recorded_as_an_error(self):
        for i in range(5):
            make_mp3(self.p("m%d.mp3" % i), tagged())
        names = sorted(os.listdir(self.tmp))
        victim = self.p(names[3])

        def progress(done, total, name):
            if done == 1 and os.path.exists(victim):
                os.remove(victim)

        d = scanner.scan(self.tmp, progress=progress, use_cache=False)
        self.assertEqual(d["counts"]["files"], 5)
        errs = [f for f in d["files"] if "err" in f]
        self.assertEqual([f["p"] for f in errs], [[names[3]]])

    @unittest.skipUnless(os.name == "nt", "junctions are a Windows thing")
    def test_junction_back_to_the_root_does_not_multiply_the_files(self):
        """Bug: the walk followed a junction pointing at its own parent ~255 levels deep, so a
        library with 10 files reported 320 files, 255 folders and dozens of 'path too long' errors."""
        make_mp3(self.p("music", "a.mp3"), tagged())
        r = subprocess.run(["cmd", "/c", "mklink", "/J", self.p("music", "back"), self.tmp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            self.skipTest("mklink /J unavailable: " + r.stderr.strip())
        self.addCleanup(lambda: os.rmdir(self.p("music", "back")))
        d = scanner.scan(self.tmp, use_cache=False)
        self.assertEqual(d["counts"]["files"], 1)
        self.assertEqual(d["counts"]["errors"], 0)


if __name__ == "__main__":
    unittest.main()
