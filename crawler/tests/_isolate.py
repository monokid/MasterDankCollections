"""Import this first in any test module that can reach the token store or settings.

The app keeps the real Spotify sign-in and UI settings under %APPDATA%\\DankCrawl.
Tests must never be able to read, overwrite or delete that, so every test process
gets a throwaway APPDATA / HOME before anything resolves a path."""
import atexit
import os
import shutil
import tempfile

if not os.environ.get("DANKCRAWL_TEST_HOME"):
    _home = tempfile.mkdtemp(prefix="dankcrawl-test-home-")
    os.environ["DANKCRAWL_TEST_HOME"] = _home
    os.environ["APPDATA"] = os.path.join(_home, "AppData")
    os.environ["USERPROFILE"] = _home
    os.environ["HOME"] = _home
    atexit.register(shutil.rmtree, _home, ignore_errors=True)
