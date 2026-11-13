"""Remembered UI state (window, divider, last tab, which Advanced sections are open).

Stored through workflow.load_settings/save_settings (ui.json in the DankCrawl folder under %APPDATA%).
In test mode nothing is read or written, so scripted runs never touch the real file.
"""
from __future__ import annotations

from typing import Any

import workflow


class Settings:
    def __init__(self, persist: bool = True):
        self.persist = persist
        self.data: dict[str, Any] = workflow.load_settings() if persist else {}

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, default)

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value

    def save(self) -> None:
        if self.persist:
            workflow.save_settings(self.data)
