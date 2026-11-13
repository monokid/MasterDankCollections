"""Spotify tab: three steps (sign in, find tracks, create playlist), one thing at a time."""
from __future__ import annotations

import os
import tkinter as tk
import webbrowser
from tkinter import filedialog

import spotify_link
import workflow
from .. import dialogs, logic, theme
from ..help_texts import HELP
from ..logic import plural
from ..tooltip import heading_resolver, tip, tip_regions
from ..ui import Collapsible, button, check, entry, heading, label, scrolled_tree
from .base import Tab

REDIRECT_URI = "http://127.0.0.1:%d/callback" % spotify_link.DEFAULT_PORTS[0]
STEPS = [("1  Sign in", "sp_step1"), ("2  Find tracks", "sp_step2"), ("3  Create playlist", "sp_step3")]
COLS = ("st", "src", "match", "score")
HEAD_KEYS = {"st": "col_sp_st", "src": "col_sp_src", "match": "col_sp_match", "score": "col_sp_score"}


class SpotifyTab(Tab):
    key = "spotify"

    def build(self, parent: tk.Frame) -> None:
        self.frame = parent
        self.sp = None
        self.matches: list = []
        self.queries: list | None = None        # from a record.csv; None = the selection
        self.playlist_url: str | None = None
        self.stage = 1
        self.name_user_set = False
        self._fill_job: str | None = None

        heading(parent, "Make a Spotify playlist", "info_spotify").pack(anchor="w")
        self._build_steps(parent)
        self.body = tk.Frame(parent, bg=theme.BG)
        self.body.pack(fill="both", expand=True, pady=(theme.PAD, 0))
        self._build_wizard()
        self._build_signin()
        self._build_work()
        self.ctx.selection.on_loaded.append(self._selection_loaded)

    # ------------------------------------------------------------ layout pieces
    def _build_steps(self, parent: tk.Frame) -> None:
        row = tk.Frame(parent, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD, 0))
        self.step_lbls: list[tk.Label] = []
        for i, (text, key) in enumerate(STEPS):
            if i:
                tk.Label(row, text="→", bg=theme.BG, fg=theme.GREY).pack(side="left", padx=theme.PAD_S)
            lbl = tk.Label(row, text=text, bg=theme.BG, fg=theme.GREY, font=theme.F_BASE, padx=10, pady=4)
            lbl.pack(side="left")
            tip(lbl, key)
            self.step_lbls.append(lbl)
        self.signout_btn = button(row, "Sign out", self._sign_out, "sp_signout", link=True)
        self.who_lbl = label(row, "", "Ok.TLabel")

    def _build_wizard(self) -> None:
        w = self.wizard = tk.Frame(self.body, bg=theme.BG)
        label(w, "One-time Spotify setup", "Head.TLabel").pack(anchor="w")
        label(w, "If someone sent you this app, ask them for the Client ID (or a ready-made "
                 "spotify_client.json to put next to the app).").pack(anchor="w")
        txt = tk.Text(w, height=8, bg=theme.PANEL, fg=theme.FG, borderwidth=0, wrap="word",
                      font=theme.F_BASE, padx=10, pady=8)
        txt.insert("1.0", spotify_link.setup_instructions(spotify_link.client_id_file()))
        txt.configure(state="disabled")
        txt.pack(fill="x", pady=(6, 6))
        row = tk.Frame(w, bg=theme.BG)
        row.pack(fill="x")
        button(row, "Copy redirect URI", self._copy_uri, "sp_copy_uri").pack(side="left")
        button(row, "Open Spotify dashboard",
               lambda: webbrowser.open("https://developer.spotify.com/dashboard"),
               "sp_dashboard").pack(side="left", padx=(theme.PAD, 0))
        row2 = tk.Frame(w, bg=theme.BG)
        row2.pack(fill="x", pady=(theme.PAD, 0))
        label(row2, "Client ID").pack(side="left", padx=(0, theme.PAD))
        self.cid_var = tk.StringVar()
        self.cid_entry = entry(row2, self.cid_var, "sp_cid", width=44)
        self.cid_entry.pack(side="left", ipady=3)
        self.cid_save = button(row2, "Save", self._save_cid, "sp_cid_save")
        self.cid_save.pack(side="left", padx=(theme.PAD, 0))
        self.cid_msg = label(w, "")
        self.cid_msg.pack(anchor="w", pady=(theme.PAD_S, 0))

    def _build_signin(self) -> None:
        s = self.signin = tk.Frame(self.body, bg=theme.BG)
        label(s, "Sign in with your own Spotify account. Your browser opens, you approve, and "
                 "you are done. This app never sees your password.", wraplength=760,
              justify="left").pack(anchor="w")
        row = tk.Frame(s, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD, 0))
        self.signin_btn = button(row, "Sign in with Spotify", self._sign_in, "sp_signin", primary=True)
        self.signin_btn.pack(side="left")
        self.cancel_btn = button(row, "Cancel", self.ctx.stop, "sp_cancel")
        self._cancel_packed = False
        self.signin_msg = label(s, "", wraplength=760, justify="left")
        self.signin_msg.pack(anchor="w", pady=(theme.PAD, 0))

    def _build_work(self) -> None:
        w = self.work = tk.Frame(self.body, bg=theme.BG)
        row = tk.Frame(w, bg=theme.BG)
        row.pack(fill="x")
        label(row, "Playlist name").pack(side="left", padx=(0, theme.PAD))
        self.name_var = tk.StringVar()
        self.name_entry = entry(row, self.name_var, "sp_name", width=36)
        self.name_entry.pack(side="left", ipady=3)
        self.name_entry.bind("<KeyRelease>", lambda _e: setattr(self, "name_user_set", True))
        self.find_btn = button(row, "Find tracks", self._find, "sp_find", primary=True)
        self.find_btn.pack(side="left", padx=(theme.PAD_L, 0))
        self.make_stop(row)
        src = tk.Frame(w, bg=theme.BG)
        src.pack(fill="x", pady=(theme.PAD_S, 0))
        self.src_lbl = label(src, "")
        self.src_lbl.pack(side="left")
        self.rec_btn = button(src, "Use a record.csv…", self._load_record, "sp_record", link=True)
        self.rec_btn.pack(side="left", padx=(theme.PAD_S, 0))
        self.use_sel_btn = button(src, "Use the selected files", self._use_selection, "sp_use_sel", link=True)

        self.review = tk.Frame(w, bg=theme.BG)
        wrap, self.tree = scrolled_tree(
            self.review, COLS, (44, 280, 420, 60),
            (("", "center"), ("Your track", "w"), ("Spotify match", "w"), ("Score", "e")), 4,
            stretch=("match",))
        wrap.pack(fill="both", expand=True)
        hit = heading_resolver(self.tree, HEAD_KEYS)
        tip_regions(self.tree, lambda e: hit(e) or ("body", HELP["sp_table"]),
                    list(HEAD_KEYS.values()) + ["sp_table"])
        self.tree.bind("<Double-1>", lambda _e: self._choose())
        self.tree.bind("<<TreeviewSelect>>", lambda _e: self.set_busy(self.ctx.busy))
        bar = tk.Frame(self.review, bg=theme.BG)
        bar.pack(fill="x", pady=(theme.PAD, 0))
        self.counts = label(bar, "")
        self.counts.pack(side="left")
        self.skip_btn = button(bar, "Skip", self._skip, "sp_skip", small=True)
        self.skip_btn.pack(side="right")
        self.choose_btn = button(bar, "Choose…", self._choose, "sp_choose", small=True)
        self.choose_btn.pack(side="right", padx=(0, theme.PAD_S))
        act = tk.Frame(self.review, bg=theme.BG)
        act.pack(fill="x", pady=(theme.PAD, 0))
        self.accept_btn = button(act, "Accept all best guesses", self._accept_all, "sp_accept")
        self.accept_btn.pack(side="left")
        self.create_btn = button(act, "Create playlist", self._create, "sp_create")
        self.create_btn.pack(side="left", padx=(theme.PAD, 0))
        self.open_btn = button(act, "Open playlist in Spotify",
                               lambda: webbrowser.open(self.playlist_url), "sp_open")
        self.missing_btn = button(act, "Save list of tracks not found…", self._save_missing,
                                  "sp_missing", link=True)
        self.adv = Collapsible(w, "Advanced", self.ctx.settings, "adv_spotify", self.ctx.relayout)
        self.adv.pack(anchor="w", pady=(theme.PAD, 0))
        self.public_var = tk.BooleanVar(value=False)
        check(self.adv.body, "Make the playlist public", self.public_var, "sp_public").pack(anchor="w")

    # ------------------------------------------------------------ stage handling
    def primary_button(self):
        if self.stage == 1:
            return self.signin_btn
        if self.stage == 2:
            return self.find_btn
        if self.stage == 3:
            return self.accept_btn if self._uncertain() else self.create_btn
        return self.cid_save

    def on_show(self) -> None:
        self.refresh_state()

    def _uncertain(self) -> int:
        return sum(1 for m in self.matches if m.status == "uncertain" and m.chosen is None)

    def refresh_state(self) -> None:
        """Re-derive the stage (no id -> setup, signed out -> sign in, else find/review)."""
        if self.frame is None:
            return
        if self.sp is None:
            self.sp = self.ctx.link_factory()
        try:
            spotify_link.resolve_client_id()
            has_cid = True
        except spotify_link.NeedsClientId:
            has_cid = False
        signed = has_cid and self.sp.is_signed_in()
        self.stage = logic.sp_stage(has_cid, signed, bool(self.matches))
        for fr in (self.wizard, self.signin, self.work):
            fr.pack_forget()
        {0: self.wizard, 1: self.signin, 2: self.work, 3: self.work}[self.stage].pack(fill="both", expand=True)
        if self.stage >= 2:
            self._prefill_name()
            self._update_review()
            if self.sp.display_name:
                self.who_lbl.configure(text="Signed in as " + self.sp.display_name)
            else:
                self.who_lbl.configure(text="Signed in")
                if not self.ctx.test_mode:
                    self._fetch_name()
            self.who_lbl.pack(side="right")
            self.signout_btn.pack(side="right", padx=(0, theme.PAD))
        else:
            self.who_lbl.pack_forget()
            self.signout_btn.pack_forget()
        self._paint_steps()
        self.set_busy(self.ctx.busy)
        self.ctx.relayout()

    def _paint_steps(self) -> None:
        for i, lbl in enumerate(self.step_lbls, 1):
            if self.stage == 0:
                lbl.configure(fg=theme.GREY, bg=theme.BG, font=theme.F_BASE)
            elif i == min(self.stage, 3):
                lbl.configure(fg=theme.BG, bg=theme.ACCENT, font=theme.F_BOLD)
            elif i < self.stage:
                lbl.configure(fg=theme.OK, bg=theme.BG, font=theme.F_BASE)
            else:
                lbl.configure(fg=theme.GREY, bg=theme.BG, font=theme.F_BASE)

    def _prefill_name(self) -> None:
        if not self.name_user_set or not self.name_var.get():
            self.name_var.set(workflow.default_playlist_name(None, self.ctx.selection.folder))

    def _selection_loaded(self) -> None:
        if self.frame is not None and self.stage >= 2:
            self._prefill_name()
        self.set_busy(self.ctx.busy)

    def _update_review(self) -> None:
        if self.matches:
            if self.review.winfo_manager() != "pack":
                self.review.pack(fill="both", expand=True, pady=(theme.PAD, 0), before=self.adv)
        else:
            self.review.pack_forget()
        if self.queries is not None:
            self.src_lbl.configure(text="Using record.csv (%s)." % plural(len(self.queries), "track"))
            self.use_sel_btn.pack(side="left")
        else:
            self.src_lbl.configure(text="Uses the real artist and title from your files, or from a record.csv.")
            self.use_sel_btn.pack_forget()
        self.find_btn.configure(text="Find tracks" if not self.matches else "Search again")

    def set_busy(self, busy: bool) -> None:
        if self.frame is None:
            return
        free = not busy
        sel = self.ctx.selection
        self.enable(self.cid_save, free)
        self.enable(self.signin_btn, free)
        self.enable(self.signout_btn, free)
        self.enable(self.rec_btn, free)
        self.enable(self.use_sel_btn, free)
        has_source = self.queries is not None or bool(sel.included())
        self.enable(self.find_btn, free and has_source)
        row = bool(self.tree.selection()) if self.matches else False
        self.enable(self.choose_btn, free and row)
        self.enable(self.skip_btn, free and row)
        unsure = self._uncertain()
        self.enable(self.accept_btn, free and unsure > 0)
        self.enable(self.create_btn, free and any(m.chosen for m in self.matches))
        self.accept_btn.configure(style="Primary.TButton" if unsure else "TButton")
        self.create_btn.configure(style="TButton" if unsure else "Primary.TButton")
        self.find_btn.configure(style="Primary.TButton" if not self.matches else "TButton")
        self._toggle(self.open_btn, bool(self.playlist_url), side="left", padx=(theme.PAD, 0))
        self._toggle(self.missing_btn, logic.sp_has_missing(self.matches), side="right")
        busy_signin = busy and self.ctx.job_kind == "orbit" and self.stage == 1
        if busy_signin and not self._cancel_packed:
            self.cancel_btn.pack(side="left", padx=(theme.PAD, 0))
            self._cancel_packed = True
        elif not busy_signin and self._cancel_packed:
            self.cancel_btn.pack_forget()
            self._cancel_packed = False
        if self.stage >= 2:
            self.show_stop(busy)

    @staticmethod
    def _toggle(widget: tk.Misc, show: bool, **pack) -> None:
        packed = widget.winfo_manager() == "pack"
        if show and not packed:
            widget.pack(**pack)
        elif not show and packed:
            widget.pack_forget()

    # ------------------------------------------------------------ setup wizard
    def _copy_uri(self) -> None:
        root = self.ctx.root
        root.clipboard_clear()
        root.clipboard_append(REDIRECT_URI)
        self.cid_msg.configure(text="Copied: " + REDIRECT_URI, style="Ok.TLabel")

    def _save_cid(self) -> None:
        cid = self.cid_var.get().strip()
        if not workflow.valid_client_id(cid):
            self.cid_msg.configure(style="Bad.TLabel", text="That does not look right. A Client ID is "
                                   "32 letters and numbers (0-9, a-f), no spaces.")
            return
        path = spotify_link.client_id_file()
        try:
            workflow.write_client_id(path, cid)
        except OSError as e:
            self.cid_msg.configure(style="Bad.TLabel", text="Could not write %s (%s). Is this folder "
                                   "read-only? Move the app somewhere you can save files." % (path, e))
            return
        self.ctx.console.log("  Client ID saved next to the app. Now sign in.", "ok")
        self.cid_var.set("")
        self.refresh_state()

    # ------------------------------------------------------------ sign in / out
    def _fetch_name(self) -> None:
        import threading

        def run() -> None:
            try:
                me = self.sp._api("GET", "/me")
                name = me.get("display_name") or me.get("id") or "Spotify user"
            except spotify_link.SpotifyError:
                self.ctx.ui(self.refresh_state)
                return
            self.sp.display_name = name
            self.ctx.ui(lambda: self.who_lbl.configure(text="Signed in as " + name))
        threading.Thread(target=run, daemon=True).start()

    def _sign_in(self) -> None:
        self.signin_msg.configure(text="Opening your browser...", style="Dim.TLabel")
        con = self.ctx.console
        con.log("", "dim")
        con.log("  Radioing the satellite. Your browser will open: approve it there.", "ok")
        self.ctx.run_job("orbit", self._sign_in_work)

    def _status(self, msg: str) -> None:
        self.signin_msg.configure(text=msg, style="Dim.TLabel")
        self.ctx.console.log("  " + msg, "dim")

    def _sign_in_work(self) -> None:
        ctx = self.ctx
        problems = (
            (spotify_link.NotAllowlisted, "not_allowed",
             "Spotify said this account is not on the allowed list yet.\n\nAsk the owner of "
             "DankCrawl to add the email address of YOUR Spotify account in their Spotify "
             "developer dashboard (User Management), then try again."),
            (spotify_link.NeedsClientId, "needs_id",
             "There is no Client ID yet. Finish the one-time setup first."),
        )
        try:
            name = self.sp.sign_in(stop=ctx.stop_flag, status=lambda m: ctx.ui(self._status, m))
        except spotify_link.AuthCancelled as e:
            ctx.ui(self._sign_in_problem, "cancelled", "Sign-in cancelled. (%s)" % e)
        except spotify_link.SpotifyError as e:
            for exc, kind, msg in problems:
                if isinstance(e, exc):
                    ctx.ui(self._sign_in_problem, kind, msg)
                    break
            else:
                ctx.ui(self._sign_in_problem, "error", str(e))
        else:
            ctx.ui(self._signed_in, name)

    def _sign_in_problem(self, kind: str, msg: str) -> None:
        ctx = self.ctx
        ctx.end()
        first = msg.splitlines()[0]
        self.signin_msg.configure(
            text="Not on the allowed list yet. Ask the owner to add your Spotify email."
            if kind == "not_allowed" else first, style="Warn.TLabel")
        ctx.console.log("  " + first, "warn")
        if kind in ("not_allowed", "error"):
            ctx.ask("Spotify would not let us in" if kind == "error" else "Not on the list yet",
                    msg, ("OK",), colour=theme.WARN)
        self.refresh_state()

    def _signed_in(self, name: str) -> None:
        self.ctx.end()
        self.ctx.console.log("  Signed in to Spotify as %s. Docking complete." % name, "ok")
        self.refresh_state()

    def _sign_out(self) -> None:
        if self.sp:
            self.sp.sign_out()
        self.matches = []
        self.tree.delete(*self.tree.get_children())
        self.playlist_url = None
        self.counts.configure(text="")
        self.ctx.console.log("  Signed out. The saved sign-in is gone from this PC.", "dim")
        self.refresh_state()

    # ------------------------------------------------------------ find
    def _load_record(self) -> None:
        p = filedialog.askopenfilename(title="Pick the record.csv from a cloak run",
                                       filetypes=[("record.csv", "*.csv"), ("All files", "*.*")])
        if p:
            self.load_record(p)

    def load_record(self, path: str) -> None:
        ctx = self.ctx
        try:
            qs, skipped = workflow.load_record_csv(path)
        except (OSError, ValueError) as e:
            ctx.tell("Could not use that file", str(e), theme.BAD)
            return
        if not qs:
            ctx.tell("Nothing in there", "That file has no rows with an artist or title.", theme.WARN)
            return
        self.queries = qs
        ctx.console.log("  Loaded %s from %s%s." % (
            plural(len(qs), "track"), os.path.basename(path),
            " (%d empty rows skipped)" % skipped if skipped else ""), "ok")
        self._update_review()
        self.set_busy(ctx.busy)

    def _use_selection(self) -> None:
        self.queries = None
        self._update_review()
        self.set_busy(self.ctx.busy)

    def _find(self) -> None:
        ctx = self.ctx
        if self.queries is None and not ctx.need_files():
            return
        ctx.console.log("", "dim")
        ctx.console.log("  Scanning the heavens for your tracks...", "ok")
        ctx.run_job("orbit", self._find_work, self.queries, list(ctx.selection.included()))

    def _find_work(self, queries: list | None, entries: list) -> None:
        ctx = self.ctx
        if queries is None:
            queries, anon = workflow.queries_from_entries(entries)
            if anon:
                ctx.say("  %s look already anonymised (anon_...); skipped." % plural(anon, "file"), "warn")
            if not queries:
                ctx.ui(self._no_identities)
                return
        total = len(queries)

        def progress(i: int, _t: int, q) -> None:
            if q is not None:
                ctx.post_progress(i, total, "Looking up " + logic.query_label(q))
        matches = self.sp.find(queries, progress=progress, stop=ctx.stop_flag)
        ctx.ui(self._found, matches, total)

    def _no_identities(self) -> None:
        self.ctx.end()
        self.ctx.ask("Nothing to look up",
                     "The selected files have no real artist or title I can use (they look "
                     "anonymised, or have no tags and no 'Artist - Title' file names).\n\n"
                     "Point the selection at the ORIGINAL, named files, or use 'Use a record.csv...' "
                     "to load the private record from a cloak run.", ("OK",), colour=theme.WARN)

    def _found(self, matches: list, total: int) -> None:
        ctx, con = self.ctx, self.ctx.console
        ctx.end()
        self.matches = matches
        self.playlist_url = None
        c = logic.sp_tally(matches)
        if len(matches) < total:
            con.log("  Stopped early: %d of %d looked up." % (len(matches), total), "warn")
        con.log("  Found %d, unsure about %d, nothing for %d." % (c["matched"], c["uncertain"], c["missing"]),
                "ok" if not c["missing"] else "warn")
        if c["uncertain"]:
            con.log("  The unsure ones wait for you: double-click a row to pick, or accept the guesses.", "dim")
        ctx.progress.finish("Looked up {:,} of {:,} tracks".format(len(matches), total),
                            len(matches) / max(total, 1))
        con.final_banner(c["matched"] + c["uncertain"] > 0)
        self._fill()
        self.refresh_state()

    # ------------------------------------------------------------ review table
    def _fill(self) -> None:
        if self._fill_job is not None:
            self.tree.after_cancel(self._fill_job)
            self._fill_job = None
        self.tree.delete(*self.tree.get_children())
        self._counts()
        self._fill_from(0)

    def _fill_from(self, start: int) -> None:
        end = min(start + theme.BATCH_ROWS, len(self.matches))
        for i in range(start, end):
            vals, tag = logic.sp_row(self.matches[i])
            self.tree.insert("", "end", iid=str(i), values=vals, tags=(tag,))
        self._fill_job = self.tree.after(1, self._fill_from, end) if end < len(self.matches) else None

    def _counts(self) -> None:
        self.counts.configure(text=logic.sp_counts_text(logic.sp_tally(self.matches)))

    def _redraw(self, idx: int) -> None:
        vals, tag = logic.sp_row(self.matches[idx])
        self.tree.item(str(idx), values=vals, tags=(tag,))
        self._counts()
        self.set_busy(self.ctx.busy)

    def _selected(self) -> int | None:
        sel = self.tree.selection()
        return int(sel[0]) if sel else None

    def _skip(self) -> None:
        i = self._selected()
        if i is not None:
            self.matches[i].chosen = None
            self._redraw(i)

    def _accept_all(self) -> None:
        for i, m in enumerate(self.matches):
            if m.status == "uncertain" and m.chosen is None and m.best:
                m.chosen = m.best
                self._redraw(i)

    def _choose(self) -> None:
        i = self._selected()
        if i is None or self.ctx.busy:
            return
        m = self.matches[i]
        if not m.candidates:
            self.ctx.tell("Nothing close", "Spotify has nothing near enough to offer for this one. "
                          "It will be left off and listed in the not-found file.", theme.WARN)
            return
        res = dialogs.choose_match(self.ctx.root, m)
        if res:
            m.chosen = res[1]
            self._redraw(i)

    # ------------------------------------------------------------ create
    def _create(self) -> None:
        ctx = self.ctx
        n = sum(1 for m in self.matches if m.chosen)
        name = self.name_var.get().strip() or workflow.default_playlist_name(None, "")
        public = self.public_var.get()
        if n == 0:
            ctx.tell("Nothing to add", "No track has a Spotify match chosen yet.", theme.WARN)
            return
        ok = ctx.ask("Create the playlist?",
                     "Add %s to a new %s playlist called:\n\n    %s\n\nin your Spotify account." % (
                         plural(n, "track"), "PUBLIC" if public else "private", name),
                     ("Create playlist", "Cancel"))
        if ok != "Create playlist":
            return
        ctx.console.log("  Launching: %d tracks into orbit as '%s'." % (n, name), "ok")
        ctx.run_job("orbit", self._create_work, name, public, list(self.matches))

    def _create_work(self, name: str, public: bool, matches: list) -> None:
        ctx = self.ctx
        info = self.sp.create_playlist(
            name, matches, description="Made with DankCrawl", public=public,
            progress=lambda added, total: ctx.post_progress(added, total, "tracks added", "tracks"),
            stop=ctx.stop_flag)
        ctx.ui(self._created, info, name)

    def _created(self, info: dict, name: str) -> None:
        ctx, con = self.ctx, self.ctx.console
        ctx.end()
        self.playlist_url = info["url"]
        ctx.progress.finish()
        con.log("  Playlist '%s' is live: %s added%s." % (
            name, plural(info["added"], "track"),
            ", %d skipped" % info["skipped"] if info["skipped"] else ""), "ok")
        if info.get("stopped"):
            con.log("  You stopped it part-way: the playlist has only the tracks added so far.", "warn")
        con.log("  " + info["url"], "accent")
        con.final_banner(not info.get("stopped"))
        self.set_busy(False)
        if ctx.ask("Playlist created", "'%s' is in your Spotify now with %s." % (
                name, plural(info["added"], "track")), ("Open in Spotify", "Close")) == "Open in Spotify":
            webbrowser.open(info["url"])

    def _save_missing(self) -> None:
        p = filedialog.asksaveasfilename(title="Save the list of tracks not found",
                                         defaultextension=".csv", initialfile="not-found-on-spotify.csv",
                                         filetypes=[("CSV", "*.csv"), ("All files", "*.*")])
        if not p:
            return
        try:
            spotify_link.save_missing(self.matches, p)
        except OSError as e:
            self.ctx.tell("Could not save that", str(e), theme.BAD)
            return
        self.ctx.console.log("  Not-found list saved: " + p, "ok")
