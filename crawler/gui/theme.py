"""Every colour, font, size and spacing the GUI uses lives here.

Change the look in this file only; nothing else in the package should contain a
hex colour or a literal font size.
"""
from __future__ import annotations

import tkinter as tk
from tkinter import ttk

# ---- palette (the cosmic one)
BG = "#0b0a1a"
PANEL = "#151233"
PANEL_HI = "#221f45"
PANEL_SEL = "#3a3270"
FG = "#e8e4ff"
DIM = "#8f88c4"
ACCENT = "#b388ff"
ACCENT_HI = "#cdb0ff"
OK = "#7cf5c4"
BAD = "#ff7b9c"
WARN = "#ffc46b"
GREY = "#7a74a8"
ART = "#5b4f9e"
TIP_BG = "#1c1842"
TIP_BORDER = "#5b4f9e"

# ---- fonts. Tk silently ignores a missing family, so these are plain names.
UI = "Segoe UI"
F_BASE = (UI, 9)
F_BOLD = (UI, 9, "bold")
F_HEAD = (UI, 10, "bold")
F_BIG = (UI, 13, "bold")
F_CARD = (UI, 11, "bold")
F_SMALL = (UI, 8)
TITLE_FONTS = ["Bauhaus 93", "Showcard Gothic", "Cooper Black", "Broadway",
               "Gill Sans Ultra Bold", "Arial Black", "Impact", "Trebuchet MS"]
MONO_FONTS = ["Cascadia Mono", "Consolas", "Lucida Console", "Courier New"]
# Block-letter art needs rows that stack with no seam. Cascadia and Consolas leave a
# gap above U+2588 that dashes every vertical stroke; Lucida Console fills the cell.
BANNER_FONTS = ["Lucida Console", "Courier New", "Consolas", "Cascadia Mono"]
TITLE_SIZE = 26

# ---- spacing
PAD_WINDOW = 20          # left/right margin of the whole window
PAD = 8                  # standard gap between controls
PAD_S = 4
PAD_L = 16

# ---- window and behaviour
DEFAULT_SIZE = (1040, 960)
MIN_SIZE = (860, 780)
SELECTION_ROWS = 5
LOG_MAX_LINES = 2000
LOG_FLUSH_MS = 50
TICK_MS = 50                 # the one animation/pump loop
BATCH_ROWS = 300             # rows inserted per `after` slice
PREVIEW_ROWS = 200
TIP_DELAY_MS = 500
TIP_WRAP = 44

KONAMI = ["Up", "Up", "Down", "Down", "Left", "Right", "Left", "Right", "b", "a"]


def apply_style(root: tk.Misc) -> None:
    """Theme ttk once. 'clam' is the only stock theme that honours these colours."""
    st = ttk.Style(root)
    try:
        st.theme_use("clam")
    except tk.TclError:
        pass
    st.configure(".", font=F_BASE)
    st.configure("TFrame", background=BG)
    st.configure("Panel.TFrame", background=PANEL)
    st.configure("TLabel", background=BG, foreground=FG)
    st.configure("Dim.TLabel", background=BG, foreground=DIM)
    st.configure("Head.TLabel", background=BG, foreground=ACCENT, font=F_HEAD)
    st.configure("Ok.TLabel", background=BG, foreground=OK)
    st.configure("Warn.TLabel", background=BG, foreground=WARN)
    st.configure("Bad.TLabel", background=BG, foreground=BAD)
    st.configure("TButton", background=PANEL_HI, foreground=FG, borderwidth=0,
                 focuscolor=ACCENT, padding=(14, 7))
    st.map("TButton", background=[("disabled", PANEL), ("active", ACCENT)],
           foreground=[("disabled", GREY), ("active", BG)])
    st.configure("Primary.TButton", background=ACCENT, foreground=BG, padding=(22, 9),
                 font=F_BOLD)
    st.map("Primary.TButton", background=[("disabled", PANEL_HI), ("active", ACCENT_HI)],
           foreground=[("disabled", GREY), ("active", BG)])
    st.configure("Small.TButton", padding=(8, 3))
    # A text-only button that looks like a link but stays focusable and Enter-able.
    st.configure("Link.TButton", background=BG, foreground=ACCENT, padding=(2, 2),
                 borderwidth=0, font=(UI, 9, "underline"))
    st.map("Link.TButton", background=[("active", BG), ("disabled", BG)],
           foreground=[("active", ACCENT_HI), ("disabled", GREY)])
    st.configure("TEntry", fieldbackground=PANEL, foreground=FG, insertcolor=FG, borderwidth=0)
    st.map("TEntry", fieldbackground=[("disabled", BG), ("readonly", PANEL)],
           foreground=[("disabled", DIM)])
    st.configure("TNotebook", background=BG, borderwidth=0, tabmargins=(0, 4, 0, 0),
                 lightcolor=BG, darkcolor=BG, bordercolor=BG)
    st.configure("TNotebook.Tab", background=PANEL, foreground=DIM, padding=(18, 8),
                 borderwidth=0, lightcolor=PANEL, bordercolor=BG)
    st.map("TNotebook.Tab", background=[("selected", ACCENT), ("active", PANEL_HI)],
           foreground=[("selected", BG), ("active", FG)])
    st.configure("Treeview", background=PANEL, fieldbackground=PANEL, foreground=FG,
                 borderwidth=0, rowheight=22, lightcolor=PANEL, darkcolor=PANEL)
    st.map("Treeview", background=[("selected", PANEL_SEL)], foreground=[("selected", "#ffffff")])
    st.configure("Treeview.Heading", background=PANEL_HI, foreground=ACCENT, relief="flat",
                 borderwidth=0, padding=(6, 4))
    st.map("Treeview.Heading", background=[("active", "#2d2960")])
    for name in ("Vertical.TScrollbar", "TScrollbar"):
        st.configure(name, background=PANEL_SEL, troughcolor=BG, arrowcolor=DIM, bordercolor=BG,
                     lightcolor=PANEL_SEL, darkcolor=PANEL_SEL, gripcount=0)
        st.map(name, background=[("active", ACCENT)])
    st.configure("TPanedwindow", background=BG)
    st.configure("Sash", sashthickness=8, gripcount=0, background=PANEL_HI)
