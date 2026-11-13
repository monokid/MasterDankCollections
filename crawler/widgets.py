"""Custom Tk widgets for the crawler: funky title, cosmic progress bar, header strip, ticker.

ttk cannot paint a per-letter gradient or a spectrum bar, so each of these is a small
Canvas/Text that draws it itself. None of them runs its own timer: `gui.clock.Clock`
calls their `step()` (one `after` loop for the window), and every item is created once
and only moved or recoloured afterwards, so a frame allocates nothing.

The palette and fonts live in `gui.theme`; they are re-exported here because
`workflow.selftest` and older code import them from this module.
"""
from __future__ import annotations

import colorsys
import math
import random
import time
import tkinter as tk
import tkinter.font as tkfont

from gui.theme import (ACCENT, ART, BAD, BANNER_FONTS, BG, DIM, FG, GREY, MONO_FONTS, OK,  # noqa: F401
                       PANEL, PANEL_HI, TITLE_FONTS, WARN)

__all__ = ["ACCENT", "ART", "BAD", "BANNER_FONTS", "BG", "DIM", "FG", "GREY", "MONO_FONTS", "OK",
           "PANEL", "PANEL_HI", "WARN", "AnimStrip", "CosmicBar", "FunkyTitle", "Ticker",
           "hsv_hex", "pick_font"]

_LUT_SIZE = 72


def pick_font(candidates: list, fallback: str = "TkDefaultFont") -> str:
    """First installed family from `candidates` (Tk would silently substitute a missing one)."""
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


def _wheel(s: float, v: float, n: int = _LUT_SIZE) -> list[str]:
    """A full hue wheel as a lookup table, so animation never calls colorsys per frame."""
    return [hsv_hex(i / n, s, v) for i in range(n)]


def _at(lut: list[str], hue: float) -> str:
    return lut[int((hue % 1.0) * len(lut)) % len(lut)]


class FunkyTitle(tk.Canvas):
    """The wordmark, one letter at a time, each its own colour, drifting very slowly."""

    def __init__(self, parent: tk.Misc, text: str, bg: str, size: int = 30):
        self.family = pick_font(TITLE_FONTS)
        self.font = tkfont.Font(family=self.family, size=size, weight="bold")
        super().__init__(parent, height=self.font.metrics("linespace") + 10, bg=bg,
                         highlightthickness=0, bd=0)
        self.text = text
        self.offset = 0.0
        self._items: list[int] = []
        self._lut = _wheel(0.55, 1.0)
        self._layout()

    def _layout(self) -> None:
        self.delete("all")
        self.configure(width=self.font.measure(self.text) + 4)
        x, y = 0, self.winfo_reqheight() / 2
        self._items = []
        for ch in self.text:
            self._items.append(self.create_text(x, y, text=ch, anchor="w", font=self.font))
            x += self.font.measure(ch)
        self._paint()

    def set_text(self, text: str) -> None:
        """Swap the wordmark (one per tab) without rebuilding the widget."""
        if text != self.text:
            self.text = text
            self._layout()

    def _paint(self) -> None:
        n = max(len(self._items), 1)
        for i, item in enumerate(self._items):
            self.itemconfigure(item, fill=_at(self._lut, i / n * 0.62 + 0.63 + self.offset))

    def step(self) -> None:
        self.offset += 0.006
        self._paint()


class CosmicBar(tk.Canvas):
    """Progress bar painted as a horizontal spectrum.

    The spectrum belongs to the bar, not to the fill, so the colour at any point means
    the same thing all the way along. It is rendered once into a PhotoImage (re-rendered
    only when the width changes); progress just moves a mask rectangle, and the busy
    comet is a pre-rendered sprite slid along with one `coords` call.
    """

    HUE_FROM, HUE_SPAN = 0.88, 0.46       # magenta -> violet -> blue -> cyan -> mint

    def __init__(self, parent: tk.Misc, trough: str, height: int = 18):
        super().__init__(parent, height=height, bg=trough, highlightthickness=0, bd=0)
        self.trough = trough
        self.value = 0.0
        self.indeterminate = False
        self.phase = 0.0
        self._spin_end = 0.0
        self._bw = 0
        self._spectrum: tk.PhotoImage | None = None
        self._spin_img: tk.PhotoImage | None = None
        self._comet_img: tk.PhotoImage | None = None
        self._resize_job: str | None = None
        self._spec_item = self.create_image(0, 0, anchor="nw")
        self._mask = self.create_rectangle(0, 0, 0, 0, fill=trough, outline="")
        self._cap = self.create_rectangle(0, 0, 0, 0, fill="#ffffff", outline="", state="hidden")
        self._comet = self.create_image(0, 0, anchor="nw", state="hidden")
        self.bind("<Configure>", self._on_configure)

    # -- rendering
    def _on_configure(self, _e: tk.Event) -> None:
        if self._resize_job is None:
            self._resize_job = self.after(120, self._rebuild)

    def _colour(self, t: float) -> str:
        return hsv_hex(self.HUE_FROM - t * self.HUE_SPAN, 0.62, 1.0)

    def _row_image(self, colours: list[str], height: int) -> tk.PhotoImage:
        img = tk.PhotoImage(master=self, width=len(colours), height=1)
        img.put("{" + " ".join(colours) + "}", to=(0, 0))
        return img.zoom(1, height)

    def _rebuild(self) -> None:
        self._resize_job = None
        w, h = self.winfo_width(), self.winfo_height()
        if w <= 1:
            return
        self._bw = w
        self._spectrum = self._row_image([self._colour(x / w) for x in range(w)], h)
        self.itemconfigure(self._spec_item, image=self._spectrum)
        self._spin_img = None
        band = max(int(w * 0.26), 60)
        glow = []
        for x in range(band):
            g = x / band
            glow.append(hsv_hex(self.HUE_FROM - g * self.HUE_SPAN, 0.62, 0.2 + 0.8 * g))
        self._comet_img = self._row_image(glow, h)
        self.itemconfigure(self._comet, image=self._comet_img)
        self._layout()

    def _layout(self) -> None:
        w, h = self._bw, self.winfo_height()
        if w <= 1:
            return
        if self._spin_end:
            self.itemconfigure(self._comet, state="hidden")
            self.itemconfigure(self._cap, state="hidden")
            self.coords(self._mask, 0, 0, 0, h)
            return
        if self.indeterminate:
            self.coords(self._mask, 0, 0, w, h)
            self.itemconfigure(self._cap, state="hidden")
            self.itemconfigure(self._comet, state="normal")
            self._place_comet()
            return
        self.itemconfigure(self._comet, state="hidden")
        self.coords(self._spec_item, 0, 0)
        self.itemconfigure(self._spec_item, image=self._spectrum)
        filled = int(w * self.value)
        self.coords(self._mask, filled, 0, w, h)
        if 0 < filled < w:
            self.coords(self._cap, max(filled - 3, 0), 0, filled, h)
            self.itemconfigure(self._cap, state="normal")
        else:
            self.itemconfigure(self._cap, state="hidden")

    def _place_comet(self) -> None:
        w = self._bw
        band = self._comet_img.width() if self._comet_img else 60
        self.coords(self._comet, -band + self.phase * (w + band), 0)

    def _spin_image(self) -> tk.PhotoImage:
        """A spectrum twice the bar's width that wraps; sliding it gives the rotating rainbow."""
        w, h = self._bw, self.winfo_height()
        cols = []
        for x in range(2 * w):
            tri = 1.0 - abs(2.0 * ((x / w) % 1.0) - 1.0)
            cols.append(hsv_hex(self.HUE_FROM - tri * self.HUE_SPAN, 0.7, 1.0))
        return self._row_image(cols, h)

    # -- public
    def set_value(self, fraction: float) -> None:
        self.value = max(0.0, min(1.0, fraction))
        if not self.indeterminate and not self._spin_end:
            self._layout()

    def start(self) -> None:
        if not self.indeterminate:
            self.indeterminate = True
            self._layout()

    def stop(self) -> None:
        if self.indeterminate:
            self.indeterminate = False
            self._layout()

    def spin(self, seconds: float = 4.0) -> None:
        """Easter egg: the spectrum rotates through the bar for a moment."""
        if self._spin_end or self._bw <= 1:
            return
        if self._spin_img is None:
            self._spin_img = self._spin_image()
        self._spin_end = time.monotonic() + seconds
        self.itemconfigure(self._spec_item, image=self._spin_img)
        self._layout()

    @property
    def animating(self) -> bool:
        return self.indeterminate or bool(self._spin_end)

    def step(self) -> None:
        """One frame (called by the clock only while `animating`)."""
        if self._spin_end:
            if time.monotonic() >= self._spin_end:
                self._spin_end = 0.0
                self.itemconfigure(self._spec_item, image=self._spectrum)
                self._layout()
                return
            off = (time.monotonic() * 1.4) % 1.0
            self.coords(self._spec_item, -off * self._bw, 0)
        elif self.indeterminate:
            self.phase = (self.phase + 0.03) % 1.0
            self._place_comet()


class AnimStrip(tk.Canvas):
    """A thin header strip: drifting stars and a slowly pulsing amoeba.

    All canvas items are created once (on the first real size) and then only moved or
    recoloured from lookup tables, so a frame does no allocation. The blob pulses faster
    while `busy`. The clock simply stops calling `step()` when the window is not in use.
    """

    NSTARS, NPTS, SWARM = 28, 20, 9

    def __init__(self, parent: tk.Misc, bg: str = BG, height: int = 40):
        super().__init__(parent, height=height, bg=bg, highlightthickness=0, bd=0)
        self.busy = False
        rng = random.Random(5)
        self.stars = [[rng.random(), rng.random(), 0.05 + rng.random() * 0.25,
                       rng.choice((1, 1, 2)), rng.random() * 6.28] for _ in range(self.NSTARS)]
        self.t = 0.0
        self.drift = 0.0
        self._last = time.monotonic()
        self._swarm_start = 0.0
        self._swarm_len = 0.0
        self._star_items: list[int] = []
        self._blobs: list[tuple[int, int]] = []     # (polygon, nucleus); [0] is the main one
        self._star_lut = [hsv_hex(0.68 + 0.1 * i / 11, 0.35, 0.35 + 0.5 * i / 11) for i in range(12)]
        self._fill = _wheel(0.55, 0.5)
        self._edge = _wheel(0.45, 1.0)
        self._core = _wheel(0.7, 0.95)
        self._frame = 0

    def set_busy(self, busy: bool) -> None:
        self.busy = busy

    def swarm(self, seconds: float = 5.0) -> None:
        """Easter egg: the amoeba splits into a swarm, then pulls itself together."""
        self._swarm_start = time.monotonic()
        self._swarm_len = seconds

    def _build(self) -> None:
        self._star_items = [self.create_rectangle(0, 0, 1, 1, outline="") for _ in self.stars]
        for _ in range(1 + self.SWARM):
            poly = self.create_polygon([0, 0] * self.NPTS, smooth=True, width=1)
            core = self.create_oval(0, 0, 1, 1, outline="")
            self._blobs.append((poly, core))
        for poly, core in self._blobs[1:]:
            self.itemconfigure(poly, state="hidden")
            self.itemconfigure(core, state="hidden")

    def _blob(self, idx: int, cx: float, cy: float, radius: float, hue: float, wob: float) -> None:
        poly, core = self._blobs[idx]
        pts = []
        for i in range(self.NPTS):
            a = i / self.NPTS * 2 * math.pi
            r = radius * (1 + 0.13 * math.sin(3 * a + wob * 1.3) + 0.08 * math.sin(5 * a - wob * 0.9))
            pts.append(cx + math.cos(a) * r * 1.35)
            pts.append(cy + math.sin(a) * r * 0.9)
        self.coords(poly, *pts)
        self.itemconfigure(poly, fill=_at(self._fill, hue), outline=_at(self._edge, hue))
        nx = cx + math.cos(wob * 0.7) * radius * 0.25
        ny = cy + math.sin(wob * 0.9) * radius * 0.18
        nr = radius * 0.32
        self.coords(core, nx - nr, ny - nr, nx + nr, ny + nr)
        self.itemconfigure(core, fill=_at(self._core, hue + 0.05))

    def _show_swarm(self, on: bool) -> None:
        state = "normal" if on else "hidden"
        for poly, core in self._blobs[1:]:
            self.itemconfigure(poly, state=state)
            self.itemconfigure(core, state=state)

    def step(self) -> None:
        w, h = self.winfo_width(), self.winfo_height()
        if w <= 1:
            return
        if not self._star_items:
            self._build()
        now = time.monotonic()
        dt = min(now - self._last, 0.25)
        self._last = now
        rate = 3.0 if self.busy else 1.0
        self.t += dt * rate
        self.drift += dt * rate
        self._frame += 1
        recolour = self._frame % 3 == 0
        for item, st in zip(self._star_items, self.stars):
            st[0] = (st[0] - st[2] * dt * rate * 0.06) % 1.0
            x, y = st[0] * w, 3 + st[1] * (h - 6)
            self.coords(item, x, y, x + st[3], y + st[3])
            if recolour:
                tw = 0.5 + 0.5 * math.sin(self.t * 1.6 + st[4])
                self.itemconfigure(item, fill=self._star_lut[int(tw * 11)])
        cy = h / 2
        cx = 80 + (0.5 + 0.5 * math.sin(self.drift * 0.14)) * max(w - 160, 10)
        radius = 11 + 2.0 * math.sin(self.t * 1.4)
        hue = 0.74 + 0.1 * math.sin(self.t * (0.4 if not self.busy else 1.4))
        sw = 0.0
        if self._swarm_len:
            el = now - self._swarm_start
            if el >= self._swarm_len:
                self._swarm_len = 0.0
            else:
                sw = max(0.0, min(1.0, el / 0.8, (self._swarm_len - el) / 0.8))
        self._show_swarm(sw > 0)
        if sw > 0:
            for k in range(self.SWARM):
                a = self.t * (0.8 + k * 0.07) + k * 0.7
                self._blob(1 + k, cx + math.cos(a) * (30 + 22 * (k % 3)) * sw * 1.4,
                           cy + math.sin(a * 1.3) * h * 0.32 * sw,
                           5 + 1.2 * math.sin(self.t * 2 + k), hue + k * 0.06, self.t + k)
            self._blob(0, cx, cy, radius * (1 - 0.5 * sw), hue, self.t)
        else:
            self._blob(0, cx, cy, radius, hue, self.t)


class Ticker(tk.Text):
    """A one-line status strip whose letters cycle through the spectrum.

    The line is rewritten only when the flavour text changes (every few seconds); the
    animation just recolours 16 tags from a lookup table.
    """

    NTAGS = 16
    SPARKS = ["✦", "✧", "⋆", "✶", "✷"]
    SWAP_EVERY = 20        # steps between flavour lines

    def __init__(self, parent: tk.Misc, bg: str, font: tuple):
        super().__init__(parent, height=1, bg=bg, fg=DIM, bd=0, highlightthickness=0, font=font,
                         wrap="none", state="disabled", cursor="arrow", takefocus=0, insertwidth=0)
        for k in range(self.NTAGS):
            self.tag_configure("rb%d" % k)
        self.running = False
        self.frame = 0
        self.flavours: list[str] = []
        self._idx = 0
        self._lut = _wheel(0.55, 1.0)

    def _write(self, text: str) -> None:
        self.configure(state="normal")
        self.delete("1.0", "end")
        for i, ch in enumerate(text):
            self.insert("end", ch, "rb%d" % (i % self.NTAGS))
        self.configure(state="disabled")

    def start(self, flavours: list) -> None:
        self.flavours = list(flavours) or ["working"]
        self._idx = random.randrange(len(self.flavours))
        self.frame = 0
        self.running = True
        self._compose()

    def stop(self) -> None:
        self.running = False
        self._write("")

    def _compose(self) -> None:
        spark = " ".join(self.SPARKS)
        self._write("%s  %s...  %s" % (spark, self.flavours[self._idx % len(self.flavours)], spark))

    def step(self) -> None:
        if not self.running:
            return
        self.frame += 1
        if self.frame % self.SWAP_EVERY == 0:
            self._idx += 1
            self._compose()
        base = self.frame * 0.045
        for k in range(self.NTAGS):
            self.tag_configure("rb%d" % k, foreground=_at(self._lut, base + k / self.NTAGS))
