"""GUI-free rules the tabs rely on (gui/logic.py, gui/app.tab_text). No Tk window is created."""
import _isolate  # noqa: F401  (first: keeps tests away from the real %APPDATA%)
import os
import sys
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from gui import logic  # noqa: E402
from gui.app import TAB_SPECS, tab_text  # noqa: E402


class MoveOrder(unittest.TestCase):
    def test_moves_a_single_item_up_and_down(self):
        self.assertEqual(logic.move_order(list("abcd"), ["c"], -1), list("acbd"))
        self.assertEqual(logic.move_order(list("abcd"), ["b"], 1), list("acbd"))

    def test_block_at_the_edge_stays_put(self):
        self.assertEqual(logic.move_order(list("abcd"), ["a", "b"], -1), list("abcd"))
        self.assertEqual(logic.move_order(list("abcd"), ["c", "d"], 1), list("abcd"))

    def test_contiguous_block_moves_together_without_reordering_itself(self):
        # Guards the classic bug where moving a block swaps its own members.
        self.assertEqual(logic.move_order(list("abcde"), ["c", "d"], -1), list("acdbe"))
        self.assertEqual(logic.move_order(list("abcde"), ["b", "c"], 1), list("adbce"))

    def test_scattered_selection_moves_each_item_one_place(self):
        self.assertEqual(logic.move_order(list("abcdef"), ["b", "e"], 1), list("acbdfe"))

    def test_input_is_not_mutated(self):
        order = list("abc")
        logic.move_order(order, ["b"], 1)
        self.assertEqual(order, list("abc"))


class Sorting(unittest.TestCase):
    def test_sort_by_name_is_natural_not_alphabetical(self):
        names = {"p1": "10 b.mp3", "p2": "2 a.mp3", "p3": "1 c.mp3"}
        self.assertEqual(logic.sorted_by_name(["p1", "p2", "p3"], names), ["p3", "p2", "p1"])
        self.assertEqual(logic.sorted_by_name(["p1", "p2", "p3"], names, True), ["p1", "p2", "p3"])


class Wording(unittest.TestCase):
    def test_plural(self):
        self.assertEqual(logic.plural(1, "file"), "1 file")
        self.assertEqual(logic.plural(2, "file"), "2 files")
        self.assertEqual(logic.plural(0, "copy", "copies"), "0 copies")

    def test_check_line_counts_warnings_and_failures_as_problems(self):
        self.assertEqual(logic.check_line({"ok": 37, "warn": 1, "fail": 1, "unsupported": 0}),
                         "37 ok \u00b7 2 problems")
        self.assertEqual(logic.check_line({"ok": 3, "warn": 0, "fail": 1, "unsupported": 0}),
                         "3 ok \u00b7 1 problem")
        self.assertIn("2 not checked", logic.check_line({"ok": 1, "warn": 0, "fail": 0, "unsupported": 2}))

    def test_human_time(self):
        self.assertEqual(logic.human_time(None), "--")
        self.assertEqual(logic.human_time(75), "1m 15s")
        self.assertEqual(logic.human_time(3700), "1h 01m")

    def test_shorten_path_keeps_both_ends(self):
        p = "C:\\Users\\someone\\very\\long\\path\\to\\a\\folder\\DankCloak 2026-11-13"
        short = logic.shorten_path(p, 40)
        self.assertLessEqual(len(short), 40)
        self.assertTrue(short.startswith("C:\\"))
        self.assertTrue(short.endswith("2026-11-13"))
        self.assertEqual(logic.shorten_path("short", 40), "short")

    def test_batches(self):
        self.assertEqual([list(b) for b in logic.batches(list(range(5)), 2)], [[0, 1], [2, 3], [4]])


class Workers(unittest.TestCase):
    def test_workers_are_bounded_and_deep_leaves_a_core_free(self):
        self.assertEqual(logic.auto_workers(False, 1), 2)
        self.assertEqual(logic.auto_workers(False, 64), 8)
        self.assertEqual(logic.auto_workers(True, 8), 4)
        self.assertLessEqual(logic.auto_workers(True, 4), logic.auto_workers(False, 4))


class SpotifyStage(unittest.TestCase):
    def test_stage_rules(self):
        self.assertEqual(logic.sp_stage(False, False, False), 0)
        self.assertEqual(logic.sp_stage(False, True, True), 0)      # no client id beats everything
        self.assertEqual(logic.sp_stage(True, False, False), 1)
        self.assertEqual(logic.sp_stage(True, False, True), 1)      # signed out: matches are stale
        self.assertEqual(logic.sp_stage(True, True, False), 2)
        self.assertEqual(logic.sp_stage(True, True, True), 3)

    @staticmethod
    def _match(status, chosen=None, best=None):
        q = SimpleNamespace(artist="A", title="T", ref="r")
        return SimpleNamespace(status=status, chosen=chosen, best=best, query=q)

    def test_row_icons(self):
        cand = SimpleNamespace(name="N", artists=["X"], album="Al", score=0.91)
        self.assertEqual(logic.sp_row(self._match("matched", cand, cand))[0][0], "\u2713")
        self.assertEqual(logic.sp_row(self._match("uncertain", None, cand))[0][0], "?")
        self.assertEqual(logic.sp_row(self._match("missing"))[0][0], "\u2717")
        vals, tag = logic.sp_row(self._match("matched", None, cand))      # skipped by the user
        self.assertEqual((vals[2], tag), ("(skipped)", "skipped"))

    def test_missing_only_counts_unresolved_tracks(self):
        cand = SimpleNamespace(name="N", artists=["X"], album="Al", score=0.6)
        self.assertFalse(logic.sp_has_missing([self._match("matched", cand, cand)]))
        self.assertTrue(logic.sp_has_missing([self._match("uncertain", None, cand)]))
        self.assertFalse(logic.sp_has_missing([self._match("uncertain", cand, cand)]))
        self.assertTrue(logic.sp_has_missing([self._match("missing")]))

    def test_tally(self):
        cand = SimpleNamespace(name="N", artists=["X"], album="Al", score=0.9)
        t = logic.sp_tally([self._match("matched", cand, cand), self._match("missing")])
        self.assertEqual((t["matched"], t["missing"], t["chosen"]), (1, 1, 1))


class CloakForm(unittest.TestCase):
    def test_kinda_needs_a_person(self):
        with self.assertRaises(logic.FormError):
            logic.check_cloak_form("kinda", "  ", "random", "C:\\somewhere\\out", "C:\\music")

    def test_bad_seed_and_inside_output_are_rejected(self):
        with self.assertRaises(logic.FormError):
            logic.check_cloak_form("true", "", "abc", "C:\\x\\out", "C:\\music")
        with self.assertRaises(logic.FormError) as cm:
            logic.check_cloak_form("true", "", "random", "C:\\music\\inside", "C:\\music")
        self.assertTrue(cm.exception.bad)

    def test_valid_form_returns_the_seed(self):
        self.assertEqual(logic.check_cloak_form("true", "", "42", "C:\\x\\out", "C:\\music"), 42)
        self.assertIsNone(logic.check_cloak_form("true", "", "random", "C:\\x\\out", "C:\\music"))


class TabLabels(unittest.TestCase):
    def test_cloak_is_first_and_dig_is_last(self):
        self.assertEqual([t.key for t in TAB_SPECS], ["cloak", "check", "spotify", "dig"])
        self.assertEqual(TAB_SPECS[-1].label, "Dig (library scan)")

    def test_underline_lands_on_the_mnemonic_letter_despite_the_emoji(self):
        # The icon is outside the BMP, which Tk counts as two characters; getting this
        # wrong underlines the wrong letter on every tab.
        for spec in TAB_SPECS:
            text, idx = tab_text(spec)
            utf16 = text.encode("utf-16-le")
            letter = utf16[idx * 2:idx * 2 + 2].decode("utf-16-le")
            self.assertEqual(letter, spec.mnemonic, spec.key)

    def test_mnemonics_are_unique(self):
        letters = [t.mnemonic.lower() for t in TAB_SPECS]
        self.assertEqual(len(letters), len(set(letters)))


if __name__ == "__main__":
    unittest.main()
