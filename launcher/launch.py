"""MasterDankCollections launcher.

One double-click: check the machine, install what's missing, rebuild the
catalogue if it has gone stale, start the dev server on a port nothing else is
using, wait until it genuinely answers, and open it.

Every step reports pass or fail on screen, and a failure says what to do rather
than only what happened. Nothing is assumed to have worked because it was
started.
"""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import threading
import webbrowser
from pathlib import Path

import tkinter as tk
from tkinter import ttk

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "crawler"))

import steps
from steps import StepError
from widgets import MONO_FONTS, CosmicBar, FunkyTitle, pick_font

APP_TITLE = "MasterDankCollections"

BG = "#0b0a1a"
PANEL = "#151233"
FG = "#e8e4ff"
DIM = "#8f88c4"
ACCENT = "#b388ff"
OK = "#7cf5c4"
BAD = "#ff7b9c"
WARN = "#ffc46b"

STEPS = [
    ("project", "Find the project"),
    ("node", "Check Node.js"),
    ("deps", "Check dependencies"),
    ("data", "Check the catalogue"),
    ("port", "Find a free port"),
    ("serve", "Start the server"),
    ("open", "Open in the browser"),
]


class Launcher:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.q: queue.Queue = queue.Queue()
        self.worker: threading.Thread | None = None
        self.server: subprocess.Popen | None = None
        self.url: str | None = None
        self.rows: dict = {}

        # Distinct from the app's own window title, so the two are tellable
        # apart in the taskbar once the browser is open.
        root.title(f"{APP_TITLE} — Launcher")
        root.configure(bg=BG)
        root.geometry("880x660")
        root.minsize(680, 560)
        root.protocol("WM_DELETE_WINDOW", self._close)

        self._style()
        self._build()
        self.root.after(80, self._drain)
        # Start on its own so the window is already up if anything goes wrong.
        self.root.after(350, self.start)

    # ------------------------------------------------------------------ ui

    def _style(self):
        st = ttk.Style()
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure("TFrame", background=BG)
        st.configure("TLabel", background=BG, foreground=FG)
        st.configure("Dim.TLabel", background=BG, foreground=DIM)
        st.configure("TButton", background=PANEL, foreground=FG, borderwidth=0,
                     focuscolor=BG, padding=(14, 7))
        st.map("TButton",
               background=[("active", ACCENT), ("disabled", "#221f45")],
               foreground=[("active", BG), ("disabled", DIM)])

    def _build(self):
        pad = {"padx": 22}
        FunkyTitle(self.root, "MasterDankCollections", BG, size=26).pack(
            anchor="w", pady=(14, 2), **pad)
        ttk.Label(self.root, text="a decade of event playlists",
                  style="Dim.TLabel").pack(anchor="w", pady=(0, 14), **pad)

        box = tk.Frame(self.root, bg=PANEL, highlightthickness=0)
        box.pack(fill="x", **pad)
        for key, label in STEPS:
            row = tk.Frame(box, bg=PANEL)
            row.pack(fill="x", padx=14, pady=2)
            icon = tk.Label(row, text="·", bg=PANEL, fg=DIM, width=2,
                            font=("Consolas", 11))
            icon.pack(side="left")
            name = tk.Label(row, text=label, bg=PANEL, fg=DIM, anchor="w", width=24)
            name.pack(side="left")
            note = tk.Label(row, text="", bg=PANEL, fg=DIM, anchor="w",
                            justify="left")
            note.pack(side="left", fill="x", expand=True)
            self.rows[key] = (icon, name, note)

        self.bar = CosmicBar(self.root, trough=PANEL, height=14)
        self.bar.pack(fill="x", pady=(14, 4), **pad)

        ctl = ttk.Frame(self.root)
        ctl.pack(fill="x", pady=(8, 0), **pad)
        self.go_btn = ttk.Button(ctl, text="Launch", command=self.start)
        self.go_btn.pack(side="left")
        self.open_btn = ttk.Button(ctl, text="Open in browser",
                                   command=self._open, state="disabled")
        self.open_btn.pack(side="left", padx=(8, 0))
        self.stop_btn = ttk.Button(ctl, text="Stop server", command=self._stop,
                                   state="disabled")
        self.stop_btn.pack(side="left", padx=(8, 0))
        self.status = ttk.Label(ctl, text="", style="Dim.TLabel")
        self.status.pack(side="left", padx=(16, 0))

        wrap = tk.Frame(self.root, bg=PANEL, highlightthickness=0)
        wrap.pack(fill="both", expand=True, pady=(14, 18), **pad)
        mono = pick_font(MONO_FONTS, "Courier")
        self.log = tk.Text(wrap, bg=PANEL, fg=FG, insertbackground=FG,
                           borderwidth=0, font=(mono, 9), wrap="none",
                           height=10, state="disabled")
        sb = ttk.Scrollbar(wrap, command=self.log.yview)
        self.log.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.log.pack(side="left", fill="both", expand=True, padx=8, pady=8)
        for tag, col in (("ok", OK), ("bad", BAD), ("dim", DIM), ("warn", WARN)):
            self.log.tag_configure(tag, foreground=col)

    def _log(self, msg, tag="dim"):
        self.log.configure(state="normal")
        self.log.insert("end", msg + "\n", tag)
        self.log.see("end")
        self.log.configure(state="disabled")

    def _mark(self, key, state, note=""):
        icon, name, label = self.rows[key]
        glyph, colour = {
            "run": ("•", ACCENT), "ok": ("✓", OK), "bad": ("✗", BAD),
            "skip": ("–", DIM), "warn": ("!", WARN),
        }[state]
        icon.configure(text=glyph, fg=colour)
        name.configure(fg=FG if state in ("ok", "run") else DIM)
        label.configure(text=note, fg=colour if state in ("bad", "warn") else DIM)

    # ------------------------------------------------------------- plumbing

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        self._stop(quiet=True)
        for key, _ in STEPS:
            self._mark(key, "skip", "")
        self.go_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.status.configure(text="working…")
        self.bar.start()
        self.worker = threading.Thread(target=self._run, daemon=True)
        self.worker.start()

    def _emit(self, *msg):
        self.q.put(msg)

    def _run(self):
        try:
            self._sequence()
        except StepError as e:
            self._emit("fail", e.message, e.hint)
        except Exception as e:                      # never die silently
            self._emit("fail", f"{type(e).__name__}: {e}", "")

    def _sequence(self):
        step = self._emit

        step("step", "project", "run", "")
        root = steps.find_root()
        step("step", "project", "ok", str(root))
        step("log", f"project  {root}", "dim")

        step("step", "node", "run", "")
        node = steps.node_exe()
        _, version = steps.node_version(node)
        step("step", "node", "ok", f"{version}  ({node})")

        step("step", "deps", "run", "")
        if steps.deps_installed(root):
            step("step", "deps", "ok", "already installed")
        else:
            step("step", "deps", "run", "installing — this takes a minute…")
            step("log", "npm install …", "dim")
            code = steps.run_once([steps.npm_exe(), "install"], root,
                                  on_line=lambda l: step("log", "  " + l, "dim"))
            if code != 0 or not steps.deps_installed(root):
                raise StepError(f"npm install failed (exit code {code}).",
                                "Check the log above — usually it's no internet.")
            step("step", "deps", "ok", "installed")

        step("step", "data", "run", "")
        found = steps.crawls(root)
        if not found:
            raise StepError("There are no crawl files in data\\.",
                            "Put an mdc-crawl-*.json from DankCrawl into the "
                            "data\\ folder and launch again.")
        stale, why = steps.catalog_stale(root)
        if stale:
            step("step", "data", "run", f"rebuilding — {why}")
            step("log", f"distilling ({why}) …", "dim")
            code = steps.run_once(
                [node, str(steps.tsx_entry(root)), "tools/distill.ts"], root,
                on_line=lambda l: step("log", "  " + l, "dim"))
            if code != 0:
                raise StepError(f"Rebuilding the catalogue failed (exit {code}).",
                                "The log above should say which file upset it.")
            again, _ = steps.catalog_stale(root)
            if again:
                raise StepError("The catalogue still looks wrong after rebuilding.",
                                "Try `npm run distill` in a terminal to see why.")
        summary = steps.catalog_summary(root)
        step("step", "data", "ok",
             f"{len(found)} crawl{'s' if len(found) != 1 else ''}" +
             (f" · {summary}" if summary else ""))

        step("step", "port", "run", "")
        port = steps.pick_port()
        step("step", "port", "ok", str(port))

        step("step", "serve", "run", "starting…")
        proc = subprocess.Popen(
            [node, str(steps.vite_entry(root)),
             "--port", str(port), "--strictPort", "--host", "127.0.0.1"],
            cwd=str(root), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            creationflags=steps.NO_WINDOW)
        self._emit("server", proc)
        threading.Thread(target=self._pump, args=(proc,), daemon=True).start()

        steps.wait_until_serving(port, proc)
        url = f"http://127.0.0.1:{port}/"
        step("step", "serve", "ok", url)

        step("step", "open", "run", "")
        opened = webbrowser.open(url)
        step("step", "open", "ok" if opened else "warn",
             url if opened else "couldn't open a browser — copy the URL above")
        step("ready", url)

    def _pump(self, proc):
        """Relay the server's own output, so a crash is visible not silent."""
        if not proc.stdout:
            return
        for line in proc.stdout:
            self.q.put(("log", "  " + line.rstrip(), "dim"))
        self.q.put(("server-exit", proc.returncode))

    # ------------------------------------------------------------- draining

    def _drain(self):
        try:
            while True:
                msg = self.q.get_nowait()
                kind = msg[0]
                if kind == "step":
                    self._mark(msg[1], msg[2], msg[3])
                elif kind == "log":
                    self._log(msg[1], msg[2])
                elif kind == "server":
                    self.server = msg[1]
                    self.stop_btn.configure(state="normal")
                elif kind == "server-exit":
                    self._on_server_exit(msg[1])
                elif kind == "ready":
                    self._on_ready(msg[1])
                elif kind == "fail":
                    self._on_fail(msg[1], msg[2])
        except queue.Empty:
            pass
        self.root.after(80, self._drain)

    def _on_ready(self, url):
        self.url = url
        self.bar.stop()
        self.bar.set_value(1.0)
        self.go_btn.configure(state="normal", text="Relaunch")
        self.open_btn.configure(state="normal")
        self.status.configure(text="running")
        self._log("", "dim")
        self._log(f"  Ready at {url}", "ok")
        self._log("  Leave this window open — closing it stops the server.", "dim")

    def _on_fail(self, message, hint):
        self.bar.stop()
        self.bar.set_value(0)
        for key, _ in STEPS:
            icon, _n, _l = self.rows[key]
            if icon.cget("text") == "•":
                self._mark(key, "bad", "")
        self.go_btn.configure(state="normal", text="Try again")
        self.status.configure(text="stopped")
        self._log("", "dim")
        self._log("  " + message, "bad")
        if hint:
            self._log("  " + hint, "warn")

    def _on_server_exit(self, code):
        if self.server is None:
            return
        self.server = None
        self.url = None
        self.stop_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.go_btn.configure(state="normal", text="Launch")
        self.status.configure(text="stopped")
        if code not in (0, None):
            self._log(f"  Server exited with code {code}.", "bad")

    # --------------------------------------------------------------- actions

    def _open(self):
        if self.url:
            webbrowser.open(self.url)

    def _stop(self, quiet=False):
        proc, self.server = self.server, None
        if proc is not None:
            steps.kill_tree(proc)
            if not quiet:
                self._log("  Server stopped.", "dim")
        self.stop_btn.configure(state="disabled")
        self.open_btn.configure(state="disabled")
        self.url = None
        if not quiet:
            self.status.configure(text="stopped")

    def _close(self):
        self._stop(quiet=True)
        self.root.destroy()


def main():
    root = tk.Tk()
    Launcher(root)
    root.mainloop()


if __name__ == "__main__":
    main()
