"""The job bodies the tabs run on worker threads, free of Tk so they can be tested.

`cloak_with_check` exists because `workflow.run_cloak` can only pre-check with the slow
deep decoder. The GUI promise is "a quick check always runs first, files that fail are
always left out and listed", with deep as an opt-in, so the check stage is done here and
`run_cloak` is called with its own check switched off.
"""
from __future__ import annotations

import threading
from typing import Callable

import integrity
import workflow
from . import logic

Progress = Callable[[str, int, int, str], None]


def cloak_with_check(entries: list, mode: str, out: str, *, person: str = "", phase: str = "",
                     seed: int | None = None, use_phases: bool = True, deep: bool = False,
                     source_root: str | None = None, progress: Progress | None = None,
                     stop: threading.Event | None = None) -> workflow.CloakRun:
    """Integrity check (quick, or deep when asked), drop failures, then cloak the rest.

    progress(stage, done, total, name) with stage in 'check' | 'plan' | 'cloak'.
    Raises ValueError for an unusable output folder or nothing left to cloak.
    """
    bad = workflow.output_problem(out, [source_root] if source_root else [])
    if bad:
        raise ValueError(bad)
    inc = [e for e in entries if e.include]
    run = workflow.CloakRun()
    if inc:
        verdicts = integrity.check_many(
            [e.path for e in inc], deep=deep, workers=logic.auto_workers(deep), stop=stop,
            progress=(lambda d, t, n: progress("check", d, t, n)) if progress else None)
        run.verdicts = verdicts
        if stop is not None and stop.is_set():
            run.stopped = True
            return run
        by_path = {v.path: v for v in verdicts}
        kept = []
        for e in inc:
            v = by_path.get(e.path)
            if v is not None:
                e.status = v.level
            if v is not None and v.level == "fail":
                run.left_out.append((e.path, list(v.reasons)))
            else:
                kept.append(e)
        inc = kept
    if not inc:
        raise ValueError("Nothing left to cloak: every file failed the check or none are ticked.")
    done = workflow.run_cloak(inc, mode, out, person=person, phase=phase, seed=seed,
                              use_phases=use_phases, check_first=False, source_root=source_root,
                              progress=progress, stop=stop)
    done.verdicts, done.left_out = run.verdicts, run.left_out
    return done
