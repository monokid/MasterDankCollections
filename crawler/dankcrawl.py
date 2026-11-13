"""DankCrawl entry point: the CLI and the launcher for the window (the GUI lives in gui/).

  dankcrawl.py                     open the window
  dankcrawl.py --cli <folder>      scan a library into mdc-crawl-*.json in the cwd
  dankcrawl.py cloak <folder> ...  anonymise a playlist from the command line
  dankcrawl.py check <folder> ...  integrity check from the command line
  dankcrawl.py --selftest          exercise every module on synthetic files (exit 0/1)

Engines are imported inside the commands that need them, so opening the window does
not load the CLI's code and `--selftest` never loads Tk.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time


def _ensure_stdio():
    """A --windowed exe has no console: attach to the parent's, else go quiet."""
    if sys.stdout is None:
        try:
            if os.name == "nt":
                import ctypes
                if ctypes.windll.kernel32.AttachConsole(-1):
                    sys.stdout = open("CONOUT$", "w", encoding="utf-8")
                    sys.stderr = sys.stdout
        except Exception:
            pass
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w")
    if sys.stderr is None:
        sys.stderr = sys.stdout
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="replace")
        except Exception:
            pass


def _cli_progress():
    last = [0.0]

    def progress(label, done, total, name=""):
        now = time.time()
        if now - last[0] < 0.4 and done < total:
            return
        last[0] = now
        print("  %s %d/%d %s" % (label, done, total, name[:40]).ljust(78), end="\r", flush=True)
    return progress


def cli_cloak(argv) -> int:
    import cloak
    import workflow
    ap = argparse.ArgumentParser(prog="dankcrawl.py cloak",
                                 description="Make an anonymised mirror copy of a playlist folder "
                                             "(originals are never touched).")
    ap.add_argument("folder")
    ap.add_argument("--mode", choices=cloak.MODES, default="true")
    ap.add_argument("--person")
    ap.add_argument("--phase")
    ap.add_argument("--seed", help="a whole number, or 'random' (default)")
    ap.add_argument("--out", help="output folder (default: 'DankCloak <date>' next to the playlist)")
    ap.add_argument("--no-check", action="store_true", help="skip the integrity check")
    ap.add_argument("--keep-failed", action="store_true",
                    help="do not leave out files that fail the integrity check")
    ap.add_argument("--no-phases", action="store_true", help="do not treat subfolders as phases")
    a = ap.parse_args(argv)
    if not os.path.isdir(a.folder):
        print("Not a folder: " + a.folder)
        return 2
    if a.mode == "kinda" and not (a.person or "").strip():
        print("--mode kinda needs --person")
        return 2
    try:
        seed = workflow.parse_seed(a.seed)
    except ValueError as e:
        print(e)
        return 2
    sel = workflow.scan_selection(a.folder)
    print(workflow.summary_text(sel.entries))
    if not sel.entries:
        print("No audio files found.")
        return 1
    out = a.out or workflow.default_output_dir(a.folder)
    pr = _cli_progress()
    try:
        run = workflow.run_cloak(
            sel.entries, a.mode, out, person=a.person, phase=a.phase, seed=seed,
            use_phases=sel.has_subfolders and not a.no_phases, check_first=not a.no_check,
            drop_failed=not a.keep_failed, source_root=a.folder,
            progress=lambda st, d, t, n: pr({"check": "checking", "plan": "planning", "cloak": "cloaking"}[st], d, t, n))
    except ValueError as e:
        print("\n" + str(e))
        return 1
    print()
    print(workflow.format_cloak_summary(run))
    for p, why in run.left_out:
        print("  left out: %s -- %s" % (os.path.basename(p), "; ".join(why[:2])))
    r = run.result
    for p, why in r.failed:
        print("  FAILED: %s -- %s" % (os.path.basename(p), why))
    for p in workflow.unstrippable_copies(r):
        print("  WARNING tags remain in: " + p)
    print("share:   " + os.path.join(r.out_dir, "anonymised"))
    print("PRIVATE: " + r.record_dir)
    return 1 if (r.failed or r.unstrippable) else 0


def cli_check(argv) -> int:
    import integrity
    import workflow
    from gui.logic import LEVEL_ORDER
    ap = argparse.ArgumentParser(prog="dankcrawl.py check",
                                 description="Check that every audio file is complete and plays cleanly.")
    ap.add_argument("folder")
    ap.add_argument("--deep", action="store_true", help="decode everything (slower)")
    ap.add_argument("--report", help="write a CSV report (and a .txt summary beside it)")
    ap.add_argument("--workers", type=int)
    a = ap.parse_args(argv)
    if not os.path.isdir(a.folder):
        print("Not a folder: " + a.folder)
        return 2
    sel = workflow.scan_selection(a.folder)
    print(workflow.summary_text(sel.entries))
    pr = _cli_progress()
    workers = a.workers or (2 if a.deep else 4)
    vs = integrity.check_many([e.path for e in sel.entries], deep=a.deep, workers=workers,
                              progress=lambda d, t, n: pr("checking", d, t, n))
    print()
    s = integrity.summarise(vs)
    print(workflow.format_check_counts(s))
    for v in sorted(vs, key=lambda v: (LEVEL_ORDER.get(v.level, 9), v.path)):
        if v.level in ("fail", "warn"):
            print("  [%s] %s -- %s" % (v.level, os.path.basename(v.path), "; ".join(v.reasons[:3])))
    if a.report:
        txt = integrity.write_report(vs, a.report)
        print("report:  %s\nsummary: %s" % (a.report, txt))
    return 1 if s["by_level"]["fail"] else 0


def cli_selftest(argv) -> bool:
    import workflow
    log = None
    if "--log" in argv:
        i = argv.index("--log")
        if i + 1 < len(argv):
            log = open(argv[i + 1], "w", encoding="utf-8")

    def say(line):
        print(line)
        if log:
            log.write(line + "\n")
            log.flush()
    ok = workflow.selftest(say)
    if log:
        log.close()
    return ok


def run_cli(argv: list):
    # A --windowed build has no console attached, so sys.stdout is None and any
    # print() would abort the scan. Keep CLI mode usable from the exe anyway.
    _ensure_stdio()
    if argv and argv[0] == "cloak":
        return cli_cloak(argv[1:])
    if argv and argv[0] == "check":
        return cli_check(argv[1:])

    import scanner
    from gui.system import app_dir
    root_dir = argv[0] if argv else app_dir()
    last = [0.0]

    def progress(done, total, current):
        now = time.time()
        if now - last[0] < 0.5 and done < total:
            return
        last[0] = now
        pct = (done * 100.0 / total) if total else 0
        print("  {:,}/{:,} ({:.0f}%)".format(done, total, pct), end="\r", flush=True)

    doc = scanner.scan(root_dir, progress=progress)
    out = os.path.join(os.getcwd(), scanner.output_filename(doc["root_name"]))
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
    c = doc["counts"]
    print("\n{:,} media files, {:,} dirs, {:,} tagged, {:,} errors in {}s".format(
        c["media"], c["dirs"], c["with_tags"], c["errors"], doc["elapsed_sec"]))
    print("by ext:   " + str(c["by_ext"]))
    print("excluded: {:,} non-media {}".format(c["excluded"], c["excluded_by_ext"]))
    print("saved:    " + out)
    return doc


def main() -> None:
    argv = sys.argv[1:]
    if "--selftest" in argv:
        _ensure_stdio()
        sys.exit(0 if cli_selftest(argv) else 1)
    if "--cli" in argv:
        run_cli([a for a in argv if a != "--cli"])
        return
    if argv and argv[0] in ("cloak", "check"):
        sys.exit(run_cli(argv))
    from gui import app
    sys.exit(app.run())


if __name__ == "__main__":
    main()
