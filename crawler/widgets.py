"""Custom Tk widgets for the crawler: a funky title and a cosmic progress bar.

Both exist because ttk cannot do what was wanted. A themed Progressbar takes a
single flat colour, and a Label takes a single flat font colour -- so each of
these is a small Canvas that paints the gradient itself.
"""
from __future__ import annotations

import colorsys
import tkinter as tk
import tkinter.font as tkfont

# Tk does no font fallback of its own: naming a missing family silently gives
# you the default. So the family is resolved against what is actually installed.
TITLE_FONTS = [
    "Bauhaus 93", "Showcard Gothic", "Cooper Black", "Broadway",
    "Gill Sans Ultra Bold", "Arial Black", "Impact", "Trebuchet MS",
]
MONO_FONTS = ["Cascadia Mono", "Consolas", "Lucida Console", "Courier New"]

# The block-letter banner needs rows that stack with no seam between them.
# Measured on Windows: Cascadia Mono and Consolas leave a gap between the line
# box and the top of U+2588, which dashes every vertical stroke. Lucida Console
# fills the cell exactly, so the art is drawn in that whatever the log uses.
BANNER_FONTS = ["Lucida Console", "Courier New", "Consolas", "Cascadia Mono"]


def pick_font(candidates: list, fallback: str = "TkDefaultFont") -> str:
    """First installed family from `candidates`."""
    try:
        available = set(tkfont.families())
    except tk.TclError:
        return fallback
    for name in candidates:
        if name in available:
            return name
    return fallback


def hsv_hex(h: float, s: float, v: float) -> str:
    r, g, b = colorsys.hsv_to_rgb(h % 1.0, s, v)
    return "#%02x%02x%02x" % (int(r * 255), int(g * 255), int(b * 255))


class FunkyTitle(tk.Canvas):
    """The wordmark, one letter at a time, each its own colour.

    The hue drifts slowly so the title reads as alive without ever being the
    thing that catches your eye while you are trying to read the log.
    """

    def __init__(self, parent, text: str, bg: str, size: int = 30):
        self.family = pick_font(TITLE_FONTS)
        self.font = tkfont.Font(family=self.family, size=size, weight="bold")
        height = self.font.metrics("linespace") + 10
        super().__init__(parent, height=height, bg=bg, highlightthickness=0, bd=0)
        self.text = text
        self.offset = 0.0
        self._items = []
        # A Canvas does not size itself to what is drawn on it, so ask the font
        # how wide the word is -- otherwise the last letters are simply clipped.
        self.configure(width=self.font.measure(text) + 4)
        self._layout()
        self._animate()

    def _layout(self):
        self.delete("all")
        self._items = []
        x = 0
        y = self.winfo_reqheight() / 2
        for i, ch in enumerate(self.text):
            item = self.create_text(x, y, text=ch, anchor="w", font=self.font)
            self._items.append((item, i))
            x += self.font.measure(ch)
        self._paint()

    def _paint(self):
        n = max(len(self._items), 1)
        for item, i in self._items:
            # Spread roughly two thirds of the wheel across the word, then
            # rotate the whole thing.
            hue = (i / n) * 0.62 + 0.63 + self.offset
            self.itemconfigure(item, fill=hsv_hex(hue, 0.55, 1.0))

    def _animate(self):
        self.offset += 0.0035
        self._paint()
        self.after(90, self._animate)


class CosmicBar(tk.Canvas):
    """Progress bar painted as a horizontal spectrum.

    The gradient belongs to the *bar*, not to the fill: as progress grows you
    reveal more of a fixed spectrum rather than stretching a two-colour ramp,
    so the colour at any point means the same thing all the way through.
    """

    STEP = 3          # px per gradient band; small enough to look continuous

    def __init__(self, parent, trough: str, height: int = 18):
        super().__init__(parent, height=height, bg=trough, highlightthickness=0, bd=0)
        self.trough = trough
        self.value = 0.0          # 0..1
        self.indeterminate = False
        self.phase = 0.0
        self._job = None
        self.bind("<Configure>", lambda _e: self._redraw())

    def set_value(self, fraction: float):
        self.value = max(0.0, min(1.0, fraction))
        if not self.indeterminate:
            self._redraw()

    def start(self):
        if self.indeterminate:
            return
        self.indeterminate = True
        self._tick()

    def stop(self):
        self.indeterminate = False
        if self._job:
            self.after_cancel(self._job)
            self._job = None
        self._redraw()

    def _tick(self):
        if not self.indeterminate:
            return
        self.phase = (self.phase + 0.016) % 1.0
        self._redraw()
        self._job = self.after(28, self._tick)

    # Hue runs *down* the wheel: magenta -> violet -> blue -> cyan -> mint.
    # Going up instead wraps through red and orange, which reads as a sunset
    # rather than anything cosmic, and matches nothing else in the project.
    HUE_FROM, HUE_SPAN = 0.88, 0.46

    def _band_colour(self, t: float) -> str:
        """t in 0..1 across the full bar."""
        return hsv_hex(self.HUE_FROM - t * self.HUE_SPAN, 0.62, 1.0)

    def _redraw(self):
        self.delete("all")
        w = self.winfo_width()
        h = self.winfo_height()
        if w <= 1:
            return

        self.create_rectangle(0, 0, w, h, fill=self.trough, outline="")

        if self.indeterminate:
            # A comet of light sweeping the trough, with a soft tail.
            band = max(w * 0.26, 60)
            head = -band + self.phase * (w + band * 2)
            x = 0
            while x < w:
                d = (head - x) / band
                if 0.0 <= d <= 1.0:
                    glow = 1.0 - d
                    self.create_rectangle(
                        x, 0, x + self.STEP, h,
                        fill=hsv_hex(self.HUE_FROM - (x / w) * self.HUE_SPAN,
                                     0.62, 0.35 + glow * 0.65),
                        outline="")
                x += self.STEP
            return

        filled = int(w * self.value)
        x = 0
        while x < filled:
            self.create_rectangle(x, 0, min(x + self.STEP, filled), h,
                                  fill=self._band_colour(x / max(w, 1)), outline="")
            x += self.STEP

        # A brighter cap on the leading edge, so the bar has a nose.
        if 0 < filled < w:
            self.create_rectangle(max(filled - 3, 0), 0, filled, h,
                                  fill="#ffffff", outline="")
