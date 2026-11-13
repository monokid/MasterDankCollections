"""The wordmark and the animated strip under it. Both are stepped by the shared clock."""
from __future__ import annotations

import time
import tkinter as tk
from typing import Callable

from widgets import AnimStrip, FunkyTitle
from . import theme


class Header:
    def __init__(self, parent: tk.Misc, text: str, on_swarm: Callable[[], None] | None = None):
        self.frame = tk.Frame(parent, bg=theme.BG)
        self.title = FunkyTitle(self.frame, text, theme.BG, size=theme.TITLE_SIZE)
        self.title.pack(anchor="w")
        self.strip = AnimStrip(parent, theme.BG, 32)
        self._clicks: list[float] = []
        self.on_swarm = on_swarm
        self.title.bind("<Button-1>", self._on_click)

    def pack(self) -> None:
        self.frame.pack(fill="x", padx=theme.PAD_WINDOW, pady=(10, 0))
        self.strip.pack(fill="x", padx=theme.PAD_WINDOW, pady=(2, 6))

    def set_title(self, text: str) -> None:
        self.title.set_text(text)

    def set_busy(self, busy: bool) -> None:
        self.strip.set_busy(busy)

    def _on_click(self, _e: tk.Event) -> None:
        """Easter egg: seven quick clicks on the title release the amoeba swarm."""
        now = time.monotonic()
        self._clicks = [t for t in self._clicks if now - t < 3.0] + [now]
        if len(self._clicks) >= 7:
            self._clicks = []
            self.strip.swarm(5.0)
            if self.on_swarm:
                self.on_swarm()
