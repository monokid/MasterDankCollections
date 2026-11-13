"""Operating-system helpers."""
from __future__ import annotations

import os
import subprocess
import sys


def app_dir() -> str:
    """Where the exe (or the script) lives: the default library root and Dig's output."""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def open_path(path: str) -> None:
    """Show a folder or file in the OS file manager."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa: S606 - the user asked to open it
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
    except Exception:  # noqa: BLE001 - failing to open a window is not worth a crash
        pass
