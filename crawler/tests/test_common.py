"""Tests for common.py (the helpers the engines share) and for the engines' import cost.
Run: python -m unittest discover -s crawler/tests
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
CRAWLER = os.path.dirname(HERE)
sys.path.insert(0, CRAWLER)
import common  # noqa: E402


def make_tree(root, spec):
    """spec: {relative path: bytes}; a trailing '/' makes an empty folder."""
    for rel, data in spec.items():
        p = os.path.join(root, *rel.split("/"))
        if rel.endswith("/"):
            os.makedirs(p, exist_ok=True)
        else:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "wb") as f:
                f.write(data)


def slurp(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="dc-common-")
        self.addCleanup(shutil.rmtree, self.tmp, True)


class NaturalKey(unittest.TestCase):
    def test_numbers_sort_numerically_and_case_is_ignored(self):
        names = ["Track 10", "track 2", "Track 1", "Track 02a"]
        self.assertEqual(sorted(names, key=common.natural_key),
                         ["Track 1", "track 2", "Track 02a", "Track 10"])

    def test_leading_digits_do_not_compare_str_with_int(self):
        sorted(["1a", "a1", "", "10", "9"], key=common.natural_key)


@unittest.skipUnless(os.name == "nt", "extended-length paths are a Windows thing")
class LongPaths(unittest.TestCase):
    def test_long_path_and_plain_path_round_trip(self):
        for p in ("C:\\a\\b.mp3", "\\\\server\\share\\x.mp3"):
            lp = common.long_path(p)
            self.assertTrue(lp.startswith("\\\\?\\"), lp)
            self.assertEqual(common.plain_path(lp), p)
            self.assertEqual(common.long_path(lp), lp)   # idempotent

    def test_unc_form(self):
        self.assertEqual(common.long_path("\\\\srv\\sh\\x"), "\\\\?\\UNC\\srv\\sh\\x")


class IsRegularFile(Tmp):
    def test_file_dir_and_missing(self):
        make_tree(self.tmp, {"a.bin": b"12345"})
        self.assertEqual(common.is_regular_file(os.path.join(self.tmp, "a.bin")), (True, True, 5))
        self.assertEqual(common.is_regular_file(self.tmp)[:2], (True, False))
        self.assertEqual(common.is_regular_file(os.path.join(self.tmp, "nope")), (False, False, 0))

    def test_uses_a_single_stat_call(self):
        make_tree(self.tmp, {"a.bin": b"1"})
        with mock.patch("os.stat", wraps=os.stat) as st:
            common.is_regular_file(os.path.join(self.tmp, "a.bin"))
        self.assertEqual(st.call_count, 1)


class AtomicWrite(Tmp):
    def test_replaces_content_and_leaves_no_tmp(self):
        p = os.path.join(self.tmp, "f.json")
        common.atomic_write(p, lambda f: f.write("one"), encoding="utf-8")
        common.atomic_write(p, lambda f: f.write("two"), encoding="utf-8")
        self.assertEqual(slurp(p), "two")
        self.assertEqual(os.listdir(self.tmp), ["f.json"])

    def test_writer_failure_keeps_the_old_file_and_removes_the_tmp(self):
        p = os.path.join(self.tmp, "f.json")
        common.atomic_write(p, lambda f: f.write("good"))

        def boom(f):
            f.write("half")
            raise RuntimeError("disk full")

        with self.assertRaises(RuntimeError):
            common.atomic_write(p, boom)
        self.assertEqual(slurp(p), "good")
        self.assertEqual(os.listdir(self.tmp), ["f.json"])

    def test_failed_rename_removes_the_tmp(self):
        """Bug: scanner.save_cache / SpotifyLink._save left '<name>.tmp' behind when the rename failed."""
        p = os.path.join(self.tmp, "f.json")
        with mock.patch("os.replace", side_effect=PermissionError("locked")):
            with self.assertRaises(PermissionError):
                common.atomic_write(p, lambda f: f.write("x"))
        self.assertEqual(os.listdir(self.tmp), [])


class WalkEntries(Tmp):
    TREE = {"b/two.mp3": b"2", "b/deep/x.txt": b"x", "a/one.mp3": b"1", "root.mp3": b"r",
            "empty/": b"", "c/inner/leaf.mp3": b"l"}

    def test_same_visiting_order_as_os_walk(self):
        make_tree(self.tmp, self.TREE)
        want = [(d, list(dn), list(fn)) for d, dn, fn in os.walk(self.tmp)]
        got = [(d, [e.name for e in dn], [e.name for e in fn]) for d, dn, fn in common.walk_entries(self.tmp)]
        self.assertEqual(got, want)

    def test_pruning_dirs_in_place_skips_them(self):
        make_tree(self.tmp, self.TREE)
        seen = []
        for d, dirs, files in common.walk_entries(self.tmp):
            dirs[:] = [e for e in dirs if e.name != "b"]
            seen.append(os.path.relpath(d, self.tmp))
        self.assertNotIn("b", seen)
        self.assertNotIn(os.path.join("b", "deep"), seen)
        self.assertIn(os.path.join("c", "inner"), seen)

    def test_missing_folder_yields_nothing(self):
        self.assertEqual(list(common.walk_entries(os.path.join(self.tmp, "nope"))), [])

    def test_symlinked_folder_is_listed_but_not_entered(self):
        make_tree(self.tmp, {"real/x.mp3": b"x"})
        link = os.path.join(self.tmp, "link")
        try:
            os.symlink(os.path.join(self.tmp, "real"), link, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest("cannot create symlinks without privilege")
        visited = [d for d, _, _ in common.walk_entries(self.tmp)]
        self.assertNotIn(link, visited)

    @unittest.skipUnless(os.name == "nt", "junctions are a Windows thing")
    def test_junction_pointing_at_an_ancestor_does_not_loop(self):
        """Bug: os.walk follows junctions, so a junction back to its own parent walked ~255 levels
        deep (until the path got too long), listing every file hundreds of times."""
        make_tree(self.tmp, {"music/song.mp3": b"s"})
        r = subprocess.run(["cmd", "/c", "mklink", "/J", os.path.join(self.tmp, "music", "back"), self.tmp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            self.skipTest("mklink /J unavailable: " + r.stderr.strip())
        self.addCleanup(lambda: os.rmdir(os.path.join(self.tmp, "music", "back")))
        files = [e.path for _, _, fs in common.walk_entries(self.tmp) for e in fs]
        self.assertEqual(len(files), 1, files)


class SplitHms(unittest.TestCase):
    def test_rounds_and_clamps(self):
        self.assertEqual(common.split_hms(3725.4), (1, 2, 5))
        self.assertEqual(common.split_hms(-3), (0, 0, 0))
        self.assertEqual(common.split_hms(59.6), (0, 1, 0))


class ImportCost(unittest.TestCase):
    """The GUI imports every engine at start-up: the heavy, rarely used modules must stay out of it."""

    def run_py(self, code):
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=CRAWLER)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_heavy_modules_are_not_imported_at_start(self):
        out = self.run_py(
            "import sys; sys.path.insert(0, '.'); import cloak, integrity, spotify_link, workflow, scanner\n"
            "heavy = ['miniaudio', 'numpy', 'difflib', 'http.server', 'webbrowser', 'urllib.request',\n"
            "         'concurrent.futures', 'csv', 'shutil', 'subprocess']\n"
            "print(','.join(m for m in heavy if m in sys.modules))")
        self.assertEqual(out, "", "imported eagerly: " + out)

    def test_deep_pass_pulls_in_miniaudio_on_first_use(self):
        out = self.run_py(
            "import sys; sys.path.insert(0, '.'); import integrity\n"
            "before = 'miniaudio' in sys.modules\n"
            "ok = integrity.deep_supported('.mp3')\n"
            "print(before, ok, 'miniaudio' in sys.modules)")
        self.assertEqual(out, "False True True")


if __name__ == "__main__":
    unittest.main()
