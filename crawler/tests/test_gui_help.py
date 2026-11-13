"""Tooltips, keyboard access and responsiveness of the real window (needs a display; skipped without).

The window is built in 'test mode' (DANKCRAWL_AUTOQUIT_MS set): no settings are read or
written, nothing is opened in Explorer, Spotify uses a scratch token file.
"""
import _isolate  # noqa: F401  (first: keeps tests away from the real %APPDATA%)
import os
import sys
import tempfile
import time
import tkinter as tk
import unittest
from tkinter import ttk

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from gui.help_texts import HELP  # noqa: E402

GUI_DIR = os.path.join(ROOT, "gui")


def gui_sources():
    for base, _dirs, files in os.walk(GUI_DIR):
        for f in files:
            if f.endswith(".py") and f != "help_texts.py":
                with open(os.path.join(base, f), encoding="utf-8") as fh:
                    yield f, fh.read()


class HelpTexts(unittest.TestCase):
    def test_every_text_is_used_by_the_code(self):
        source = "\n".join(s for _f, s in gui_sources())
        unused = [k for k in HELP if '"%s"' % k not in source]
        self.assertEqual(unused, [], "help texts nobody asks for: %s" % unused)

    def test_texts_are_short_plain_sentences(self):
        for key, text in HELP.items():
            self.assertLessEqual(len(text), 260, key)
            self.assertTrue(text.endswith((".", ")")), key)
            self.assertNotIn("  ", text, key)


def make_app():
    os.environ["DANKCRAWL_AUTOQUIT_MS"] = "600000"
    os.environ["DANKCRAWL_SPOTIFY_CLIENT_ID"] = "0123456789abcdef0123456789abcdef"
    from gui import app as appmod
    root = tk.Tk()
    return root, appmod.App(root)


def pump(root, seconds=0.0, until=None):
    end = time.time() + seconds
    while time.time() < end or (until and not until() and time.time() < end + 60):
        root.update()
        if until and until():
            return True
        time.sleep(0.005)
    return bool(until and until())


class WindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls.root, cls.app = make_app()
        except tk.TclError as e:
            raise unittest.SkipTest("no display: %s" % e)
        for key in ("cloak", "check", "spotify", "dig"):       # a missing help key raises here
            cls.app._ensure_tab(key)
        pump(cls.root, 0.3)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.app.close()
        except tk.TclError:
            pass

    def _walk(self, w):
        yield w
        for c in w.winfo_children():
            yield from self._walk(c)

    def test_every_actionable_control_has_a_tooltip(self):
        from gui.tooltip import REGISTRY
        kinds = (ttk.Button, tk.Checkbutton, tk.Radiobutton, ttk.Entry, ttk.Treeview)
        bare = [str(w) for w in self._walk(self.root)
                if isinstance(w, kinds) and str(w) not in REGISTRY]
        self.assertEqual(bare, [])

    def test_every_tree_column_heading_has_a_tooltip(self):
        trees = [w for w in self._walk(self.root) if isinstance(w, ttk.Treeview)]
        self.assertGreaterEqual(len(trees), 3)
        for t in trees:
            self.assertGreaterEqual(len(getattr(t, "_tip_keys", [])), len(t["columns"]), str(t))

    def test_every_tab_label_has_a_tooltip(self):
        from gui.tooltip import REGISTRY
        self.assertIn(str(self.app.nb), REGISTRY)
        self.assertEqual(len(self.app.nb._tip_keys), len(self.app.nb.tabs()))

    def test_tooltip_appears_after_the_delay_and_never_takes_focus(self):
        from gui import tooltip
        btn = self.app.tabs["cloak"].go_btn
        before = self.root.focus_get()
        btn.event_generate("<Enter>")
        pop = tooltip._popup(btn)
        self.assertIsNotNone(pop._job)
        # A real pointer or a busy machine can delay (or cancel) the popup: wait for it,
        # re-sending Enter if a stray Leave hid it, instead of trusting one fixed delay.
        for _ in range(6):
            pump(self.root, 0.8)
            if pop.win is not None:
                break
            btn.event_generate("<Enter>")
        self.assertIsNotNone(pop.win)
        self.assertEqual(pop.win.state(), "normal")
        self.assertIn("originals", pop.label.cget("text"))
        self.assertEqual(self.root.focus_get(), before)
        btn.event_generate("<ButtonPress-1>")
        self.assertEqual(pop.win.state(), "withdrawn")

    def test_tooltip_text_wraps_at_about_44_characters(self):
        from gui import tooltip
        for line in tooltip.wrap(HELP["cloak_go"]).splitlines():
            self.assertLessEqual(len(line), 44)

    def test_advanced_sections_start_collapsed(self):
        for key in ("cloak", "spotify", "dig"):
            self.assertFalse(self.app.tabs[key].adv.is_open, key)

    def test_cloak_person_and_phase_only_show_for_keep_who_and_where(self):
        ck = self.app.tabs["cloak"]
        ck.mode_var.set("true")
        pump(self.root, 0.05)
        self.assertEqual(ck.fields.winfo_manager(), "")
        ck.mode_var.set("kinda")
        pump(self.root, 0.05)
        self.assertEqual(ck.fields.winfo_manager(), "pack")
        ck.mode_var.set("true")

    def test_enter_runs_the_primary_button_of_the_open_tab(self):
        ck = self.app.tabs["cloak"]
        hits = []
        ck._go = lambda: hits.append(1)
        ck.go_btn.configure(command=ck._go, state="normal")
        self.app.nb.select(0)
        self.app._on_tab_changed()
        self.app._on_return(type("E", (), {"widget": self.root})())
        self.assertEqual(hits, [1])

    def test_log_is_capped_and_batched(self):
        con = self.app.console
        for i in range(5000):
            con.log("line %d" % i)
        self.assertIsNotNone(con._flush_job)           # nothing written yet: buffered
        self.assertLessEqual(con.line_count(), 2001)
        self.assertIn("line 4999", con.text.get("end-3l", "end"))


class BigSelection(unittest.TestCase):
    def test_4000_files_populate_in_slices_without_freezing_the_window(self):
        try:
            root, app = make_app()
        except tk.TclError as e:
            self.skipTest("no display: %s" % e)
        try:
            with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as td:
                for i in range(4000):
                    with open(os.path.join(td, "%04d Artist - Title.mp3" % i), "wb") as f:
                        f.write(b"x")
                gaps, last, running, job = [], [time.perf_counter()], [True], [None]

                def beat():
                    now = time.perf_counter()
                    gaps.append(now - last[0])
                    last[0] = now
                    if running[0]:
                        job[0] = root.after(10, beat)
                job[0] = root.after(10, beat)
                app.selection.var.set(td)
                app.selection.load()
                ok = pump(root, 0, until=lambda: len(app.selection.tree.get_children()) == 4000)
                self.assertTrue(ok)
                self.assertEqual(len(app.selection.entries), 4000)
                running[0] = False
                root.after_cancel(job[0])
                app.selection.cancel()              # stop the background length reader
                time.sleep(0.3)
                self.assertLess(max(gaps), 0.6, "the window froze for %.2fs" % max(gaps))
        finally:
            app.close()


if __name__ == "__main__":
    unittest.main()
