"""Cloak tab: pick how anonymous, press one button, get a shareable copy."""
from __future__ import annotations

import os
import threading
import tkinter as tk
from tkinter import filedialog

import cloak
import workflow
from widgets import pick_font
from .. import dialogs, flows, logic, theme
from ..logic import FormError, plural, shorten_path
from ..tooltip import tip
from ..ui import Collapsible, button, check, entry, heading, label
from .base import Tab

# value, card title, one-line description, help key
MODES = [
    ("true", "Completely anonymous", "Every file becomes anon_ and a random number. "
     "Nothing but the audio survives.", "card_true"),
    ("kinda", "Keep who & where", "Names say who it is for and which phase it sits in, "
     "never what the song is.", "card_kinda"),
    ("switcheroo", "Switcheroo", "Real names swapped for believable fakes, so the list "
     "still reads like a playlist.", "card_switch"),
]
MODE_TITLE = {m[0]: m[1] for m in MODES}
NO_OUT = "(pick a playlist folder first)"


class CloakTab(Tab):
    key = "cloak"

    def build(self, parent: tk.Frame) -> None:
        self.frame = parent
        ctx = self.ctx
        self.form = tk.Frame(parent, bg=theme.BG)
        self.form.pack(fill="both", expand=True)
        self.result = tk.Frame(parent, bg=theme.BG)
        self.mono = pick_font(theme.MONO_FONTS, "Courier")
        self.mode_var = tk.StringVar(value="true")
        self.person_var, self.phase_var = tk.StringVar(), tk.StringVar()
        self.seed_var = tk.StringVar(value="random")
        self.deep_var = tk.BooleanVar(value=False)
        self.out_var = tk.StringVar()
        self.out_user_set = False
        self.last: dict | None = None
        self.open_anon_btn = None

        heading(self.form, "How anonymous should the copy be?", "info_cloak").pack(anchor="w")
        self._build_cards(self.form)
        self.fields_slot = tk.Frame(self.form, bg=theme.BG)
        self.fields_slot.pack(fill="x")
        self._build_fields()
        self._build_actions(self.form)
        self.adv = Collapsible(self.form, "Advanced", ctx.settings, "adv_cloak", ctx.relayout)
        self.adv.pack(anchor="w", pady=(theme.PAD, 0))
        row = tk.Frame(self.adv.body, bg=theme.BG)
        row.pack(anchor="w")
        label(row, "Seed").pack(side="left", padx=(0, theme.PAD))
        self.seed_entry = entry(row, self.seed_var, "cloak_seed", width=14)
        self.seed_entry.pack(side="left", ipady=3)
        self.deep_chk = check(self.adv.body, "Deep integrity check first", self.deep_var, "cloak_deep")
        self.deep_chk.pack(anchor="w", pady=(theme.PAD_S, 0))
        self.mode_var.trace_add("write", lambda *_a: self._mode_changed())
        for v in (self.person_var, self.phase_var):
            v.trace_add("write", lambda *_a: self._update_examples())
        ctx.selection.on_loaded.append(self._selection_loaded)
        self._mode_changed()

    # ------------------------------------------------------------ layout pieces
    def _build_cards(self, parent: tk.Frame) -> None:
        row = tk.Frame(parent, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD, 0))
        self.cards: dict[str, tk.Frame] = {}
        self.example_lbls: dict[str, tk.Label] = {}
        for col, (value, title, desc, key) in enumerate(MODES):
            row.columnconfigure(col, weight=1, uniform="cards")
            card = tk.Frame(row, bg=theme.PANEL, highlightthickness=2,
                            highlightbackground=theme.PANEL, padx=12, pady=10, cursor="hand2")
            card.grid(row=0, column=col, sticky="nsew", padx=(0 if col == 0 else theme.PAD, 0))
            rb = tk.Radiobutton(card, text=title, variable=self.mode_var, value=value,
                                bg=theme.PANEL, fg=theme.FG, selectcolor=theme.PANEL_HI,
                                activebackground=theme.PANEL, activeforeground=theme.ACCENT,
                                font=theme.F_CARD, borderwidth=0, highlightthickness=0, anchor="w")
            rb.pack(anchor="w")
            d = tk.Label(card, text=desc, bg=theme.PANEL, fg=theme.DIM, wraplength=250,
                         justify="left", anchor="w")
            d.pack(anchor="w", fill="x", pady=(2, 6))
            ex = tk.Label(card, bg=theme.PANEL, fg=theme.OK, font=(self.mono, 9), anchor="w",
                          justify="left")
            ex.pack(anchor="w", fill="x")
            self.example_lbls[value] = ex
            self.cards[value] = card
            for w in (card, d, ex):
                w.bind("<Button-1>", lambda _e, v=value: self.mode_var.set(v))
            for w in (card, rb, d, ex):
                tip(w, key)
            d.bind("<Configure>", lambda e, w=d: w.configure(wraplength=max(e.width - 4, 120)))

    def _build_fields(self) -> None:
        f = self.fields = tk.Frame(self.fields_slot, bg=theme.BG)
        label(f, "Person").grid(row=0, column=0, sticky="w")
        self.person_entry = entry(f, self.person_var, "cloak_person", width=22)
        self.person_entry.grid(row=1, column=0, sticky="w", padx=(0, theme.PAD_L), ipady=3)
        self.phase_lbl = label(f, "Phase (optional)")
        self.phase_lbl.grid(row=0, column=1, sticky="w")
        self.phase_entry = entry(f, self.phase_var, "cloak_phase", width=22)
        self.phase_entry.grid(row=1, column=1, sticky="w", ipady=3)
        self.phase_note = label(f, "Phases come from your subfolders.")

    def _build_actions(self, parent: tk.Frame) -> None:
        out = tk.Frame(parent, bg=theme.BG)
        out.pack(fill="x", pady=(theme.PAD_L, 0))
        label(out, "Saving to:").pack(side="left")
        self.out_lbl = label(out, NO_OUT, "TLabel")
        self.out_lbl.pack(side="left", padx=(theme.PAD_S, theme.PAD_S))
        self.out_change = button(out, "Change", self._out_browse, "cloak_out_change", link=True)
        self.out_change.pack(side="left")
        row = tk.Frame(parent, bg=theme.BG)
        row.pack(fill="x", pady=(theme.PAD, 0))
        self.go_btn = button(row, "Cloak it", self._go, "cloak_go", primary=True)
        self.go_btn.pack(side="left")
        self.preview_btn = button(row, "Preview names", self._preview, "cloak_preview", link=True)
        self.preview_btn.pack(side="left", padx=(theme.PAD_L, 0))
        self.make_stop(row)

    # ------------------------------------------------------------ state
    def primary_button(self):
        if self.form.winfo_manager() == "pack":
            return self.go_btn
        return self.open_anon_btn

    def on_show(self) -> None:
        self._update_examples()

    def _selection_loaded(self) -> None:
        sel = self.ctx.selection
        if sel.sel and not self.out_user_set:
            self.out_var.set(workflow.default_output_dir(sel.folder))
        self.out_lbl.configure(text=shorten_path(self.out_var.get()) or NO_OUT)
        self._update_examples()
        self.set_busy(self.ctx.busy)

    def _mode_changed(self) -> None:
        mode = self.mode_var.get()
        for value, card in self.cards.items():
            card.configure(highlightbackground=theme.ACCENT if value == mode else theme.PANEL)
        if mode == "kinda":
            self.fields.pack(fill="x", pady=(theme.PAD, 0))
        else:
            self.fields.pack_forget()
        self._update_examples()
        self.ctx.relayout()

    def _update_examples(self) -> None:
        sel = self.ctx.selection
        inc = sel.included()
        ext = (os.path.splitext(inc[0].name)[1] if inc else "") or ".mp3"
        from_folders = sel.phases_from_folders()
        for value, lbl in self.example_lbls.items():
            lbl.configure(text=workflow.example_name(value, self.person_var.get(),
                                                     self.phase_var.get(), ext, from_folders))
        if from_folders:
            self.phase_lbl.grid_remove()
            self.phase_entry.grid_remove()
            self.phase_note.grid(row=1, column=1, sticky="w")
        else:
            self.phase_note.grid_remove()
            self.phase_lbl.grid()
            self.phase_entry.grid()

    def set_busy(self, busy: bool) -> None:
        if self.frame is None:
            return
        free = not busy
        ready = free and bool(self.ctx.selection.included())
        self.enable(self.go_btn, ready)
        self.enable(self.preview_btn, ready)
        self.enable(self.out_change, free)
        for w in (self.person_entry, self.phase_entry, self.seed_entry, self.deep_chk):
            self.enable(w, free)
        self.show_stop(busy)

    # ------------------------------------------------------------ actions
    def _out_browse(self) -> None:
        sel = self.ctx.selection
        d = filedialog.askdirectory(initialdir=os.path.dirname(sel.folder) if sel.sel else None,
                                    title="Choose where the cloaked copy goes")
        if d:
            self.out_var.set(os.path.normpath(d))
            self.out_user_set = True
            self.out_lbl.configure(text=shorten_path(self.out_var.get()))

    def _options(self) -> dict | None:
        ctx, sel = self.ctx, self.ctx.selection
        if not ctx.need_files():
            return None
        mode, person = self.mode_var.get(), self.person_var.get().strip()
        out = self.out_var.get().strip()
        try:
            seed = logic.check_cloak_form(mode, person, self.seed_var.get(), out, sel.folder)
        except FormError as e:
            ctx.tell(e.title, e.body, theme.BAD if e.bad else theme.ACCENT)
            return None
        return {"entries": sel.included(), "mode": mode, "person": person,
                "phase": self.phase_var.get(), "seed": seed, "out": out,
                "use_phases": sel.phases_var.get(), "deep": self.deep_var.get(),
                "source": sel.folder}

    def _preview(self) -> None:
        o = self._options()
        if not o:
            return
        ctx = self.ctx
        ctx.console.log("  Sketching the new names...", "dim")
        ctx.begin("cloak")

        def run() -> None:
            try:
                plan = cloak.build_plan(**workflow.plan_args(
                    o["entries"], o["mode"], o["person"], o["phase"], o["seed"], o["use_phases"]))
                ctx.ui(self._show_preview, cloak.preview(plan), plan.seed, o["mode"])
            except Exception as e:  # noqa: BLE001
                ctx.ui(ctx.job_failed, "%s: %s" % (type(e).__name__, e))
        threading.Thread(target=run, daemon=True).start()

    def _show_preview(self, rows: list, seed: int | None, mode: str) -> None:
        self.ctx.end()
        if mode != "kinda" and workflow.parse_seed(self.seed_var.get()) is None and seed is not None:
            self.seed_var.set(str(seed))       # lock it so 'Cloak it' matches this preview
        dialogs.show_preview(self.ctx.root, rows, seed, mode)

    def _go(self) -> None:
        o = self._options()
        if not o:
            return
        n, con = len(o["entries"]), self.ctx.console
        con.log("", "dim")
        con.log("  Sewing hoods. %s, %s." % (plural(n, "file"), MODE_TITLE[o["mode"]]), "ok")
        con.log("  Originals stay exactly where they are.", "dim")
        self.ctx.run_job("cloak", self._work, o)

    def _work(self, o: dict) -> None:
        ctx = self.ctx
        words = {"check": "Listening to", "plan": "Planning", "cloak": "Cloaking"}

        def progress(stage: str, done: int, total: int, name: str) -> None:
            ctx.post_progress(done, total, "%s %s" % (words[stage], name) if name else words[stage])
            if stage == "plan":
                ctx.say("  Plan drawn up. Copying, stripping, verifying...", "dim")
        run = flows.cloak_with_check(
            o["entries"], o["mode"], o["out"], person=o["person"], phase=o["phase"], seed=o["seed"],
            use_phases=o["use_phases"], deep=o["deep"], source_root=o["source"],
            progress=progress, stop=ctx.stop_flag)
        ctx.ui(self._done, run)

    # ------------------------------------------------------------ result panel
    def _done(self, run: workflow.CloakRun) -> None:
        ctx, con = self.ctx, self.ctx.console
        ctx.end()
        ctx.selection.update_summary()
        ctx.selection.refresh_status()
        r = run.result
        if r is None:
            con.log("  Stopped before anything was copied. Nothing was written.", "warn")
            return
        self.last = {"anon": os.path.join(r.out_dir, "anonymised"), "record": r.record_dir,
                     "out": r.out_dir}
        trouble = bool(r.failed or r.unstrippable)
        ctx.progress.finish("Cloaked {:,} of {:,} files".format(r.copied, len(run.plan or [])))
        summary = workflow.format_cloak_summary(run)
        for line in summary.splitlines():
            con.log("  " + line, "warn" if trouble else "ok")
        for path, why in run.left_out:
            con.log("  Left out (failed the check): %s -- %s" % (os.path.basename(path), "; ".join(why[:2])), "warn")
        for path, why in r.failed:
            con.log("  FAILED: %s -- %s" % (os.path.basename(path), why), "bad")
        con.final_banner(not trouble and r.copied > 0)
        con.log("  Share ONLY: " + self.last["anon"], "ok")
        con.log("  PRIVATE, keep to yourself: " + r.record_dir, "warn")
        self._show_result(run, summary, trouble)
        ctx.open_path(r.out_dir)
        if r.unstrippable:
            self._warn_unstrippable(r)

    def _show_result(self, run: workflow.CloakRun, summary: str, trouble: bool) -> None:
        for w in self.result.winfo_children():
            w.destroy()
        r = run.result
        title = "Cloaked %s" % plural(r.copied, "file") + (", with some trouble" if trouble else "")
        tk.Label(self.result, text=title, bg=theme.BG, fg=theme.WARN if trouble else theme.OK,
                 font=theme.F_BIG).pack(anchor="w")
        lines = list(summary.splitlines())
        lines += ["Left out (failed the check): %s" % os.path.basename(p) for p, _w in run.left_out]
        lines += ["FAILED: %s -- %s" % (os.path.basename(p), why) for p, why in r.failed]
        label(self.result, "\n".join(lines[:14]), "TLabel", justify="left", wraplength=760).pack(
            anchor="w", pady=(theme.PAD, 0))
        row = tk.Frame(self.result, bg=theme.BG)
        row.pack(anchor="w", pady=(theme.PAD_L, 0))
        self.open_anon_btn = button(row, "Open anonymised folder (share this)",
                                    lambda: self.ctx.open_path(self.last["anon"]), "open_anon",
                                    primary=True)
        self.open_anon_btn.pack(side="left")
        self.open_rec_btn = button(row, "Open private record (keep this)",
                                   lambda: self.ctx.open_path(self.last["record"]), "open_record")
        self.open_rec_btn.pack(side="left", padx=(theme.PAD, 0))
        label(self.result, "Share only the 'anonymised' folder. The 'record' folder maps the new "
              "names back to your real songs: keep it to yourself.", "Warn.TLabel",
              wraplength=760, justify="left").pack(anchor="w", pady=(theme.PAD_L, 0))
        button(self.result, "Cloak another playlist", self._back_to_form, "cloak_again",
               link=True).pack(anchor="w", pady=(theme.PAD, 0))
        self.form.pack_forget()
        self.result.pack(fill="both", expand=True)
        self.ctx.relayout()
        self.open_anon_btn.focus_set()

    def _back_to_form(self) -> None:
        self.result.pack_forget()
        self.form.pack(fill="both", expand=True)
        self.ctx.relayout()
        self.go_btn.focus_set()

    def _warn_unstrippable(self, r) -> None:
        ctx = self.ctx
        copies = workflow.unstrippable_copies(r)
        names = "\n".join("   " + os.path.basename(p) for p in copies[:12])
        more = "\n   ...and %d more" % (len(copies) - 12) if len(copies) > 12 else ""
        ans = ctx.ask(
            "WARNING: some tags could NOT be removed",
            "%s in a format I cannot strip. They were copied AS THEY ARE, so their tags "
            "(artist, title, maybe more) are STILL IN the copies in the anonymised folder:\n\n%s%s\n\n"
            "Do not share them. I can delete those copies from the anonymised folder now (your "
            "originals are not affected)." % (plural(len(r.unstrippable), "file is", "files are"),
                                              names, more),
            ("Delete those copies", "Leave them"), colour=theme.BAD, default="Delete those copies")
        if ans == "Delete those copies":
            if ctx.ask("Delete %d copies?" % len(copies),
                       "These files will be removed from the anonymised folder only:\n\n" + names +
                       more + "\n\nYour originals stay where they are.",
                       ("Delete", "Cancel"), colour=theme.BAD, default="Cancel") == "Delete":
                n = workflow.delete_copies(copies, os.path.join(r.out_dir, "anonymised"))
                ctx.console.log("  Deleted %s from anonymised/." % plural(n, "unstripped copy", "unstripped copies"), "ok")
        else:
            ctx.console.log("  Unstripped copies left in anonymised/. Do NOT share those.", "bad")
