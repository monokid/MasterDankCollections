"""Tests for workflow.py (the GUI-free glue). Run: python -m unittest discover -s crawler/tests

Audio is synthesised or faked in temp dirs; no real music, no network.
"""
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cloak  # noqa: E402
import workflow as wf  # noqa: E402

TODAY = date(2026, 11, 13)


def touch(path, data=b"x" * 2048):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


class Tmp(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.addCleanup(self._td.cleanup)
        self.root = os.path.join(self._td.name, "My Playlist")
        os.makedirs(self.root)


class TestHelpers(unittest.TestCase):
    def test_natural_key_orders_numbers_numerically(self):
        names = ["Track 10.mp3", "track 2.mp3", "Track 1.mp3", "Track 02b.mp3"]
        self.assertEqual(sorted(names, key=wf.natural_key),
                         ["Track 1.mp3", "track 2.mp3", "Track 02b.mp3", "Track 10.mp3"])

    def test_natural_key_never_compares_str_with_int(self):
        sorted(["a1", "1a", "", "10", "a", "1"], key=wf.natural_key)

    def test_human_duration(self):
        self.assertEqual(wf.human_duration(None), "--")
        self.assertEqual(wf.human_duration(45), "45s")
        self.assertEqual(wf.human_duration(125), "2m05s")
        self.assertEqual(wf.human_duration(3 * 3600 + 12 * 60 + 5), "3h12m")
        self.assertEqual(wf.human_duration(59.6), "1m00s")

    def test_client_id_validation(self):
        self.assertTrue(wf.valid_client_id("0123456789abcdef0123456789ABCDEF"))
        self.assertTrue(wf.valid_client_id("  0123456789abcdef0123456789abcdef \n"))
        for bad in ("", None, "short", "g" * 32, "0123456789abcdef0123456789abcde",
                    "0123456789abcdef0123456789abcdef0"):
            self.assertFalse(wf.valid_client_id(bad), bad)

    def test_write_client_id_roundtrip(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "spotify_client.json")
            wf.write_client_id(p, " 0123456789abcdef0123456789abcdef ")
            with open(p, encoding="utf-8") as f:
                self.assertEqual(json.load(f), {"client_id": "0123456789abcdef0123456789abcdef"})

    def test_default_playlist_name(self):
        self.assertEqual(wf.default_playlist_name("Sam", r"C:\x\Mix", TODAY), "Sam \u2013 2026-11-13")
        self.assertEqual(wf.default_playlist_name("  ", r"C:\x\Friday Mix", TODAY),
                         "Friday Mix \u2013 2026-11-13")
        self.assertEqual(wf.default_playlist_name(None, "", TODAY), "DankCrawl \u2013 2026-11-13")

    def test_parse_seed(self):
        self.assertIsNone(wf.parse_seed(""))
        self.assertIsNone(wf.parse_seed(" Random "))
        self.assertEqual(wf.parse_seed("42"), 42)
        with self.assertRaises(ValueError):
            wf.parse_seed("4x2")
        with self.assertRaises(ValueError):
            wf.parse_seed("-3")

    def test_example_names(self):
        self.assertEqual(wf.example_name("true", ext=".flac"), "anon_482913.flac")
        self.assertEqual(wf.example_name("kinda", ext=".mp3", from_folders=True), "anon_Sam_Peak_03.mp3")
        self.assertEqual(wf.example_name("kinda", "Pat", "Warm up", ".mp3"), "anon_Pat_Warm up_03.mp3")
        self.assertEqual(wf.example_name("kinda", "Pat", "", "mp3"), "anon_Pat_03.mp3")
        self.assertEqual(wf.example_name("switcheroo"), "Carousel Satyr - Griffin the Gecko.mp3")

    def test_summary_formatting(self):
        es = [wf.FileEntry("a", "a", "", True, 3600.0), wf.FileEntry("b", "b", "P1", True, 600.0),
              wf.FileEntry("c", "c", "P2", False, 60.0)]
        self.assertEqual(wf.summary_text(es), "2 audio files \u00b7 2 folders \u00b7 1h10m  (1 left out)")
        es[1].duration = None
        self.assertEqual(wf.summary_text(es[:2]), "2 audio files \u00b7 2 folders \u00b7 1h00m+")
        self.assertEqual(wf.summary_text([]), "0 audio files \u00b7 0 folders \u00b7 --")
        self.assertEqual(wf.summary_text(es[:1]), "1 audio file \u00b7 1 folder \u00b7 1h00m")

    def test_format_cloak_summary(self):
        r = cloak.CloakResult(copied=5, verified=4, failed=[("x", "boom")], unstrippable=["y"])
        run = wf.CloakRun(result=r, left_out=[("z", ["bad"])], seed=7)
        txt = wf.format_cloak_summary(run)
        self.assertIn("Copied 5", txt)
        self.assertIn("verified 4", txt)
        self.assertIn("failed 1", txt)
        self.assertIn("unstrippable 1", txt)
        self.assertIn("Left out", txt)
        self.assertIn("Seed 7", txt)
        self.assertIn("Stopped", wf.format_cloak_summary(wf.CloakRun()))

    def test_format_check_counts(self):
        s = {"by_level": {"ok": 40, "warn": 2, "fail": 1, "unsupported": 3}}
        self.assertEqual(wf.format_check_counts(s),
                         "OK 40  \u00b7  warnings 2  \u00b7  failed 1  \u00b7  not checked 3")


class TestScanSelection(Tmp):
    def names(self, sel):
        return [os.path.relpath(e.path, self.root).replace("\\", "/") for e in sel.entries]

    def test_natural_order_and_non_audio_ignored(self):
        for n in ("Track 10.mp3", "Track 2.mp3", "Track 1.flac", "cover.jpg", "notes.txt", "list.m3u"):
            touch(os.path.join(self.root, n))
        sel = wf.scan_selection(self.root)
        self.assertEqual(self.names(sel), ["Track 1.flac", "Track 2.mp3", "Track 10.mp3"])
        self.assertEqual(sel.non_audio, 3)
        self.assertFalse(sel.has_subfolders)
        self.assertEqual([e.fmt for e in sel.entries], ["FLAC", "MP3", "MP3"])
        self.assertTrue(all(e.include and e.subfolder == "" for e in sel.entries))

    def test_subfolders_are_phases_in_natural_alphabetical_order(self):
        touch(os.path.join(self.root, "intro.mp3"))
        for sub, n in (("Phase 10", "a.mp3"), ("Phase 2", "b.mp3"), ("Phase 2", "a10.mp3"),
                       ("Phase 2", "a9.mp3"), ("Apex", "z.mp3")):
            touch(os.path.join(self.root, sub, n))
        sel = wf.scan_selection(self.root)
        self.assertEqual(self.names(sel), ["intro.mp3", "Apex/z.mp3", "Phase 2/a9.mp3",
                                           "Phase 2/a10.mp3", "Phase 2/b.mp3", "Phase 10/a.mp3"])
        self.assertEqual(sel.subfolders, ["Apex", "Phase 2", "Phase 10"])
        self.assertTrue(sel.has_subfolders)
        self.assertEqual([e.subfolder for e in sel.entries][:2], ["", "Apex"])

    def test_nested_files_belong_to_the_top_level_subfolder(self):
        touch(os.path.join(self.root, "Peak", "disc 2", "t.mp3"))
        touch(os.path.join(self.root, "Peak", "disc 1", "t.mp3"))
        sel = wf.scan_selection(self.root)
        self.assertEqual(self.names(sel), ["Peak/disc 1/t.mp3", "Peak/disc 2/t.mp3"])
        self.assertEqual({e.subfolder for e in sel.entries}, {"Peak"})
        self.assertEqual(sel.subfolders, ["Peak"])

    def test_empty_and_audio_free_folders(self):
        sel = wf.scan_selection(self.root)
        self.assertEqual(sel.entries, [])
        self.assertEqual(wf.summary_text(sel.entries), "0 audio files \u00b7 0 folders \u00b7 --")
        touch(os.path.join(self.root, "only", "pic.jpg"))
        sel = wf.scan_selection(self.root)
        self.assertEqual(sel.entries, [])
        self.assertEqual(sel.subfolders, [])
        self.assertEqual(sel.non_audio, 1)

    def test_hidden_folders_skipped(self):
        touch(os.path.join(self.root, ".hidden", "x.mp3"))
        touch(os.path.join(self.root, "a.mp3"))
        self.assertEqual(self.names(wf.scan_selection(self.root)), ["a.mp3"])

    def test_extension_case_insensitive(self):
        touch(os.path.join(self.root, "LOUD.MP3"))
        self.assertEqual(self.names(wf.scan_selection(self.root)), ["LOUD.MP3"])

    def test_dedupe_paths_same_file_different_spelling(self):
        p = touch(os.path.join(self.root, "a.mp3"))
        spelled = os.path.join(self.root, "sub", "..", "a.mp3")
        kept, removed = wf.dedupe_paths([p, spelled, p, touch(os.path.join(self.root, "b.mp3"))])
        self.assertEqual((len(kept), removed), (2, 2))
        self.assertEqual(kept[0], p)

    def test_duplicate_groups_flags_same_name_and_size(self):
        touch(os.path.join(self.root, "A", "song.mp3"), b"1" * 3000)
        touch(os.path.join(self.root, "B", "Song.mp3"), b"2" * 3000)
        touch(os.path.join(self.root, "B", "other.mp3"), b"2" * 3000)
        touch(os.path.join(self.root, "B", "big.mp3"), b"2" * 5000)
        sel = wf.scan_selection(self.root)
        groups = wf.duplicate_groups(sel.entries)
        self.assertEqual(len(groups), 1)
        self.assertEqual(sorted(e.subfolder for e in groups[0]), ["A", "B"])
        for e in groups[0]:
            e.include = False
        self.assertEqual(wf.duplicate_groups(sel.entries), [])


class TestPlanArgs(Tmp):
    def setUp(self):
        super().setUp()
        for sub, n in (("", "intro.mp3"), ("Warm", "a.mp3"), ("Warm", "b.mp3"), ("Peak", "c.mp3")):
            touch(os.path.join(self.root, sub, n))
        self.sel = wf.scan_selection(self.root)

    def test_phases_dict_from_subfolders(self):
        kw = wf.plan_args(self.sel.entries, "kinda", " Pat ", "ignored", 5, use_phases=True)
        self.assertEqual(kw["mode"], "kinda")
        self.assertEqual(kw["person"], "Pat")
        self.assertIsNone(kw["phase"])           # the Phase field is ignored when folders are phases
        self.assertEqual(kw["seed"], 5)
        self.assertEqual(len(kw["files"]), 4)
        self.assertEqual(sorted(set(kw["phases"].values())), ["Peak", "Warm"])
        self.assertNotIn(self.sel.entries[0].path, kw["phases"])   # root file has no phase
        self.assertEqual(kw["files"][0], self.sel.entries[0].path)

    def test_free_text_phase_when_not_using_folders(self):
        kw = wf.plan_args(self.sel.entries, "kinda", "Pat", " Warm up ", None, use_phases=False)
        self.assertIsNone(kw["phases"])
        self.assertEqual(kw["phase"], "Warm up")

    def test_free_text_phase_used_when_flag_on_but_no_subfolders(self):
        flat = [e for e in self.sel.entries if not e.subfolder]
        kw = wf.plan_args(flat, "kinda", None, "Solo", None, use_phases=True)
        self.assertEqual(kw["phase"], "Solo")
        self.assertIsNone(kw["person"])

    def test_excluded_files_and_user_order_respected(self):
        es = list(self.sel.entries)
        es[1].include = False
        es.reverse()
        kw = wf.plan_args(es, "true")
        self.assertEqual(kw["files"], [e.path for e in es if e.include])
        self.assertNotIn(self.sel.entries[1].path, kw["files"])

    def test_feeds_build_plan_with_phase_numbering(self):
        kw = wf.plan_args(self.sel.entries, "kinda", "Pat", None, 1, use_phases=True)
        plan = cloak.build_plan(**kw)
        names = [p.dst_rel for p in plan]
        self.assertEqual(sorted(names), ["anon_Pat_01.mp3", "anon_Pat_Peak_01.mp3",
                                         "anon_Pat_Warm_01.mp3", "anon_Pat_Warm_02.mp3"])
        self.assertIn("anon_Pat_Warm_02.mp3", names)
        self.assertIn("anon_Pat_Peak_01.mp3", names)
        self.assertIn("anon_Pat_01.mp3", names)     # the un-phased root file


class TestOutputFolder(Tmp):
    def test_default_is_a_sibling_never_inside(self):
        out = wf.default_output_dir(self.root, TODAY)
        self.assertEqual(os.path.dirname(out), os.path.dirname(self.root))
        self.assertEqual(os.path.basename(out), "DankCloak 2026-11-13")
        self.assertIsNone(wf.output_problem(out, [self.root]))

    def test_existing_default_gets_a_counter(self):
        first = wf.default_output_dir(self.root, TODAY)
        os.makedirs(first)
        second = wf.default_output_dir(self.root, TODAY)
        self.assertEqual(os.path.basename(second), "DankCloak 2026-11-13 (2)")

    def test_drive_root_falls_back_to_home_not_inside(self):
        drive = os.path.abspath(os.sep)
        out = wf.default_output_dir(drive, TODAY, exists=lambda p: False)
        self.assertEqual(os.path.dirname(out), os.path.expanduser("~"))

    def test_inside_source_is_a_problem(self):
        msg = wf.output_problem(os.path.join(self.root, "out"), [self.root])
        self.assertIn("inside the playlist folder", msg)
        self.assertIn("inside", wf.output_problem(self.root, [self.root]))
        self.assertIn("Choose", wf.output_problem("  ", [self.root]))


class TestRecordCsv(Tmp):
    def write(self, text, name="record.csv", enc="utf-8-sig"):
        p = os.path.join(self.root, name)
        with open(p, "w", encoding=enc, newline="") as f:
            f.write(text)
        return p

    def test_full_columns_unicode_and_bom(self):
        p = self.write("number,new_name,artist,title,album,duration_sec,person\n"
                       "1,anon_1.mp3,Bj\u00f6rk,Hyperballad,Post,321.5,Pat\n"
                       "2,anon_2.mp3,\u5742\u672c\u9f8d\u4e00,\u8a18\u61b6,,,\n")
        qs, skipped = wf.load_record_csv(p)
        self.assertEqual(skipped, 0)
        self.assertEqual((qs[0].artist, qs[0].title, qs[0].album, qs[0].duration_sec, qs[0].ref),
                         ("Bj\u00f6rk", "Hyperballad", "Post", 321.5, "anon_1.mp3"))
        self.assertEqual((qs[1].artist, qs[1].title), ("\u5742\u672c\u9f8d\u4e00", "\u8a18\u61b6"))
        self.assertIsNone(qs[1].album)
        self.assertIsNone(qs[1].duration_sec)

    def test_missing_columns_and_header_case(self):
        p = self.write("Title,ARTIST\nSong A,\n,Artist B\n")
        qs, skipped = wf.load_record_csv(p)
        self.assertEqual(skipped, 0)
        self.assertEqual((qs[0].artist, qs[0].title), (None, "Song A"))
        self.assertEqual((qs[1].artist, qs[1].title), ("Artist B", None))
        self.assertEqual(qs[0].ref, "row 2")
        qs, _ = wf.load_record_csv(self.write("title\nOnly Title\n"))
        self.assertEqual((qs[0].artist, qs[0].title), (None, "Only Title"))

    def test_empty_rows_and_bad_duration(self):
        p = self.write("artist,title,duration_sec\nA,B,not-a-number\n,,\n  ,  ,5\nC,D,12\n")
        qs, skipped = wf.load_record_csv(p)
        self.assertEqual(skipped, 2)
        self.assertEqual([(q.artist, q.title, q.duration_sec) for q in qs],
                         [("A", "B", None), ("C", "D", 12.0)])

    def test_short_rows_do_not_crash(self):
        qs, _ = wf.load_record_csv(self.write("number,artist,title,album\n1,Solo\n"))
        self.assertEqual((qs[0].artist, qs[0].title), ("Solo", None))

    def test_not_a_record_file(self):
        with self.assertRaises(ValueError):
            wf.load_record_csv(self.write("a,b,c\n1,2,3\n"))

    def test_reads_a_real_cloak_record(self):
        wav = os.path.join(self.root, "Wave Rider - Sine Song.wav")
        wf.synth_wav(wav)
        out = os.path.join(self._td.name, "out")
        sel = wf.scan_selection(self.root)
        sel.entries = [e for e in sel.entries if e.name.endswith(".wav")]
        run = wf.run_cloak(sel.entries, "true", out, check_first=False, source_root=self.root, seed=1)
        qs, _ = wf.load_record_csv(os.path.join(run.result.record_dir, "record.csv"))
        self.assertEqual((qs[0].artist, qs[0].title), ("Wave Rider", "Sine Song"))
        self.assertAlmostEqual(qs[0].duration_sec, 1.5, places=1)


class TestQueriesFromEntries(Tmp):
    def test_named_files_give_queries_anonymised_are_counted(self):
        a = touch(os.path.join(self.root, "01 Artist One - First Song.mp3"))
        b = touch(os.path.join(self.root, "anon_482913.mp3"))
        c = touch(os.path.join(self.root, "anon_Pat_Peak_03.mp3"))
        d = touch(os.path.join(self.root, "Artist Two - Anonymous Dreams.mp3"))
        es = [wf.FileEntry(p, os.path.basename(p)) for p in (a, b, c, d)]
        qs, anon = wf.queries_from_entries(es)
        self.assertEqual(anon, 2)
        self.assertEqual([(q.artist, q.title) for q in qs],
                         [("Artist One", "First Song"), ("Artist Two", "Anonymous Dreams")])
        es[0].include = False
        qs, _ = wf.queries_from_entries(es)
        self.assertEqual(len(qs), 1)


class TestRunCloak(Tmp):
    def setUp(self):
        super().setUp()
        self.out = wf.default_output_dir(self.root, TODAY)

    def make(self, sub, name, **kw):
        p = os.path.join(self.root, sub, name) if sub else os.path.join(self.root, name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        wf.synth_wav(p, **kw)
        return p

    def test_end_to_end_phases_originals_untouched(self):
        a = self.make("", "01 A - One.wav")
        b = self.make("Warm", "02 B - Two.wav")
        c = self.make("Peak", "03 C - Three.wav")
        before = {p: sha(p) for p in (a, b, c)}
        stages = []
        sel = wf.scan_selection(self.root)
        run = wf.run_cloak(sel.entries, "kinda", self.out, person="Pat", seed=3, check_first=True,
                           source_root=self.root,
                           progress=lambda st, d, t, n: stages.append(st))
        r = run.result
        self.assertEqual((r.copied, r.verified, len(r.failed), len(r.unstrippable)), (3, 3, 0, 0))
        self.assertEqual(sorted(os.listdir(os.path.join(self.out, "anonymised"))),
                         ["anon_Pat_01.wav", "anon_Pat_Peak_01.wav", "anon_Pat_Warm_01.wav"])
        self.assertTrue(os.path.isfile(os.path.join(self.out, "record", "record.csv")))
        self.assertEqual(before, {p: sha(p) for p in before})
        self.assertEqual(run.seed, 3)
        self.assertIn("check", stages)
        self.assertIn("cloak", stages)
        self.assertTrue(all(v.level == "ok" for v in run.verdicts))
        self.assertTrue(all(e.status == "ok" for e in sel.entries))

    def test_failing_file_is_left_out_when_asked(self):
        self.make("", "good.wav")
        touch(os.path.join(self.root, "empty.wav"), b"")
        sel = wf.scan_selection(self.root)
        run = wf.run_cloak(sel.entries, "true", self.out, seed=1, source_root=self.root,
                           check_first=True, drop_failed=True)
        self.assertEqual(run.result.copied, 1)
        self.assertEqual(len(run.left_out), 1)
        self.assertTrue(run.left_out[0][0].endswith("empty.wav"))
        self.assertTrue(run.left_out[0][1])
        self.assertEqual([e.status for e in sel.entries if e.name == "empty.wav"], ["fail"])

    def test_failing_file_kept_when_not_dropping(self):
        self.make("", "good.wav")
        touch(os.path.join(self.root, "empty.wav"), b"")
        sel = wf.scan_selection(self.root)
        run = wf.run_cloak(sel.entries, "true", self.out, seed=1, source_root=self.root,
                           check_first=True, drop_failed=False)
        self.assertEqual(run.left_out, [])
        self.assertEqual(run.result.copied + len(run.result.failed), 2)

    def test_everything_left_out_is_an_error_not_an_empty_run(self):
        touch(os.path.join(self.root, "empty.wav"), b"")
        sel = wf.scan_selection(self.root)
        with self.assertRaises(ValueError):
            wf.run_cloak(sel.entries, "true", self.out, source_root=self.root)
        self.assertFalse(os.path.exists(self.out))

    def test_refuses_output_inside_source(self):
        self.make("", "a.wav")
        sel = wf.scan_selection(self.root)
        with self.assertRaises(ValueError):
            wf.run_cloak(sel.entries, "true", os.path.join(self.root, "out"), source_root=self.root)
        self.assertFalse(os.path.exists(os.path.join(self.root, "out")))

    def test_stop_during_check_cloaks_nothing(self):
        self.make("", "a.wav")
        sel = wf.scan_selection(self.root)
        stop = threading.Event()
        stop.set()
        run = wf.run_cloak(sel.entries, "true", self.out, source_root=self.root, stop=stop)
        self.assertTrue(run.stopped)
        self.assertIsNone(run.result)
        self.assertFalse(os.path.exists(self.out))

    def test_excluded_files_are_not_copied(self):
        self.make("", "a.wav")
        self.make("", "b.wav")
        sel = wf.scan_selection(self.root)
        sel.entries[1].include = False
        run = wf.run_cloak(sel.entries, "true", self.out, source_root=self.root, check_first=False, seed=2)
        self.assertEqual(run.result.copied, 1)

    def test_unstrippable_copies_found_and_deleted_only_inside_anonymised(self):
        self.make("", "a.wav")
        touch(os.path.join(self.root, "odd - song.wma"), b"WMA?" * 600)
        sel = wf.scan_selection(self.root)
        run = wf.run_cloak(sel.entries, "true", self.out, source_root=self.root, check_first=False, seed=9)
        r = run.result
        self.assertEqual(len(r.unstrippable), 1)
        copies = wf.unstrippable_copies(r)
        self.assertEqual(len(copies), 1)
        self.assertTrue(copies[0].endswith(".wma"))
        self.assertTrue(os.path.isfile(copies[0]))
        anon = os.path.join(self.out, "anonymised")
        outsider = touch(os.path.join(self._td.name, "keep.wma"))
        self.assertEqual(wf.delete_copies(copies + [outsider, anon], anon), 1)
        self.assertFalse(os.path.exists(copies[0]))
        self.assertTrue(os.path.exists(outsider))
        self.assertTrue(os.path.isdir(anon))
        self.assertTrue(os.path.isfile(os.path.join(self.root, "odd - song.wma")))

    def test_no_unstrippable_means_empty_list(self):
        self.make("", "a.wav")
        sel = wf.scan_selection(self.root)
        run = wf.run_cloak(sel.entries, "true", self.out, source_root=self.root, check_first=False, seed=2)
        self.assertEqual(wf.unstrippable_copies(run.result), [])


class TestSelftest(unittest.TestCase):
    def test_selftest_passes_on_this_machine(self):
        lines = []
        self.assertTrue(wf.selftest(lines.append), "\n".join(lines))
        self.assertTrue(any(l.startswith("PASS") for l in lines))
        self.assertEqual(lines[-1], "ALL PASSED")


if __name__ == "__main__":
    unittest.main()
