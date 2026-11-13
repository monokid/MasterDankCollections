"""gui/flows.py: the Cloak job body (quick check always, failures always left out)."""
import _isolate  # noqa: F401  (first: keeps tests away from the real %APPDATA%)
import hashlib
import os
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import integrity  # noqa: E402
import workflow  # noqa: E402
from gui import flows  # noqa: E402


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


class CloakWithCheck(unittest.TestCase):
    def setUp(self):
        td = tempfile.TemporaryDirectory()
        self.addCleanup(td.cleanup)
        self.src = os.path.join(td.name, "Mix")
        self.out = os.path.join(td.name, "out")
        os.makedirs(self.src)
        workflow.synth_mp3(os.path.join(self.src, "01 Good - One.mp3"), "Good", "One")
        workflow.synth_wav(os.path.join(self.src, "02 Fine - Two.wav"))
        with open(os.path.join(self.src, "03 Broken - Three.mp3"), "wb") as f:
            f.write(b"this is not audio at all" * 40)
        self.sel = workflow.scan_selection(self.src)

    def _run(self, **kw):
        return flows.cloak_with_check(self.sel.entries, "true", self.out, source_root=self.src,
                                      use_phases=False, **kw)

    def test_failed_file_is_left_out_without_the_deep_check(self):
        run = self._run(deep=False)
        self.assertEqual([os.path.basename(p) for p, _ in run.left_out], ["03 Broken - Three.mp3"])
        self.assertEqual(run.result.copied, 2)
        self.assertEqual(len(os.listdir(os.path.join(self.out, "anonymised"))), 2)

    def test_quick_check_is_the_default_and_deep_only_when_asked(self):
        calls = []
        real = integrity.check_many

        def spy(paths, deep=False, **kw):
            calls.append(deep)
            return real(paths, deep=deep, **kw)
        with mock.patch.object(integrity, "check_many", spy):
            self._run(deep=False)
        self.assertEqual(calls, [False])

    def test_originals_are_untouched(self):
        before = {e.path: sha(e.path) for e in self.sel.entries}
        self._run(deep=False)
        self.assertEqual(before, {e.path: sha(e.path) for e in self.sel.entries})

    def test_check_results_mark_the_selection_entries(self):
        self._run(deep=False)
        status = {e.name: e.status for e in self.sel.entries}
        self.assertEqual(status["03 Broken - Three.mp3"], "fail")
        self.assertEqual(status["01 Good - One.mp3"], "ok")

    def test_stop_during_the_check_cloaks_nothing(self):
        stop = threading.Event()
        stop.set()
        run = self._run(deep=False, stop=stop)
        self.assertTrue(run.stopped)
        self.assertIsNone(run.result)
        self.assertFalse(os.path.exists(os.path.join(self.out, "anonymised")))

    def test_everything_failing_is_a_clear_error(self):
        for e in self.sel.entries:
            if not e.name.startswith("03"):
                e.include = False
        with self.assertRaises(ValueError) as cm:
            self._run(deep=False)
        self.assertIn("Nothing left", str(cm.exception))

    def test_output_inside_the_playlist_is_refused_before_anything_runs(self):
        with self.assertRaises(ValueError):
            flows.cloak_with_check(self.sel.entries, "true", os.path.join(self.src, "inside"),
                                   source_root=self.src)


if __name__ == "__main__":
    unittest.main()
