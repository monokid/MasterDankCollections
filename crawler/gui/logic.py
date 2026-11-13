"""GUI-free helpers the tabs share: ordering, wording, row building, stage rules.

Nothing here touches Tk, so tests/test_gui_logic.py can pin each rule down. The point
of pulling them out of the widgets is that these are the bugs that actually happen
(list reorder off-by-one, wrong step highlighted, counts reading oddly).
"""
from __future__ import annotations

import os
from typing import Iterable, Iterator, Sequence

import workflow

STATUS_ICON = {"ok": "✓", "warn": "⚠", "fail": "✗", "unsupported": "○", None: ""}
LEVEL_ORDER = {"fail": 0, "warn": 1, "unsupported": 2, "ok": 3}
LEVEL_WORD = {"ok": "fine", "warn": "warning", "fail": "failed", "unsupported": "not checked"}
TICK, UNTICK = "☑", "☐"


def plural(n: int, word: str, many: str | None = None) -> str:
    return "%d %s" % (n, word if n == 1 else (many or word + "s"))


def human_time(sec: float | None) -> str:
    if sec is None or sec < 0:
        return "--"
    sec = int(sec)
    if sec < 60:
        return "%ds" % sec
    if sec < 3600:
        return "%dm %02ds" % (sec // 60, sec % 60)
    return "%dh %02dm" % (sec // 3600, (sec % 3600) // 60)


def batches(seq: Sequence, size: int) -> Iterator[Sequence]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


# ------------------------------------------------------------------ selection ordering

def move_order(order: list[str], selected: Iterable[str], delta: int) -> list[str]:
    """Move every id in `selected` by one place (delta -1 up, +1 down), keeping their
    relative order. A block already against the edge stays put; selected ids never
    swap with each other.
    """
    sel = set(selected)
    out = list(order)
    idxs = [i for i, k in enumerate(out) if k in sel]
    if delta > 0:
        idxs.reverse()
    for i in idxs:
        j = i + delta
        if 0 <= j < len(out) and out[j] not in sel:
            out[i], out[j] = out[j], out[i]
    return out


def sorted_by_name(order: list[str], names: dict[str, str], reverse: bool = False) -> list[str]:
    """Natural filename order ('2' before '10'), as the scan itself uses."""
    return sorted(order, key=lambda k: workflow.natural_key(names[k]), reverse=reverse)


# ------------------------------------------------------------------ Check wording and rows

def auto_workers(deep: bool, cpus: int | None = None) -> int:
    """Quick reads are I/O bound (a few threads per core is fine); a full decode is CPU
    bound, so leave a core free for the window."""
    n = cpus or os.cpu_count() or 2
    return max(2, min(8, n // 2)) if deep else max(2, min(8, n))


def check_line(by_level: dict) -> str:
    """'37 ok . 2 problems' (warnings and failures both count as problems)."""
    ok = by_level.get("ok", 0)
    bad = by_level.get("fail", 0) + by_level.get("warn", 0)
    skipped = by_level.get("unsupported", 0)
    parts = ["%d ok" % ok, plural(bad, "problem")]
    if skipped:
        parts.append("%d not checked" % skipped)
    return " · ".join(parts)


def result_reason(v) -> str:
    reason = v.reasons[0] if v.reasons else "all good"
    if len(v.reasons) > 1:
        reason += "  (+%d more)" % (len(v.reasons) - 1)
    return reason


def sort_results(verdicts: list, key: str, reverse: bool) -> list:
    keyfns = {
        "level": lambda v: (LEVEL_ORDER.get(v.level, 9), workflow.natural_key(os.path.basename(v.path))),
        "name": lambda v: workflow.natural_key(os.path.basename(v.path)),
        "reason": lambda v: (v.reasons[0].casefold() if v.reasons else ""),
        "engine": lambda v: v.engine,
    }
    return sorted(verdicts, key=keyfns[key], reverse=reverse)


def result_row(v) -> tuple:
    return (STATUS_ICON.get(v.level, "") + " " + LEVEL_WORD.get(v.level, v.level),
            os.path.basename(v.path), result_reason(v), v.engine)


# ------------------------------------------------------------------ Spotify

def sp_stage(has_client_id: bool, signed_in: bool, has_matches: bool) -> int:
    """0 = setup needed, 1 = sign in, 2 = find tracks, 3 = review and create."""
    if not has_client_id:
        return 0
    if not signed_in:
        return 1
    return 3 if has_matches else 2


def query_label(q) -> str:
    return " - ".join(x for x in (q.artist, q.title) if x) or q.ref


def sp_row(m) -> tuple[tuple, str]:
    """(table values, colour tag) for one match."""
    c = m.chosen or m.best
    match = score = ""
    if c:
        match = "%s - %s (%s)" % (c.name, ", ".join(c.artists), c.album)
        score = "%d%%" % round(c.score * 100)
    if m.status == "missing":
        icon, tag = "✗", "missing"
    elif m.chosen is None:
        icon, tag = ("?", "uncertain") if m.status == "uncertain" else ("–", "skipped")
        if m.status == "matched":
            match = "(skipped)"
    else:
        icon, tag = "✓", "matched"
    return (icon, query_label(m.query), match, score), tag


def sp_tally(matches: Iterable) -> dict:
    c = {"matched": 0, "uncertain": 0, "missing": 0, "chosen": 0}
    for m in matches:
        c[m.status] += 1
        if m.chosen:
            c["chosen"] += 1
    return c


def sp_counts_text(c: dict) -> str:
    return "%d matched · %d unsure · %d not found · %d will be added" % (
        c["matched"], c["uncertain"], c["missing"], c["chosen"])


def sp_has_missing(matches: Iterable) -> bool:
    return any(m.status == "missing" or (m.status == "uncertain" and m.chosen is None)
               for m in matches)


# ------------------------------------------------------------------ Cloak

class FormError(Exception):
    """A form the user must fix: `title` and `body` go straight into a dialog."""

    def __init__(self, title: str, body: str, bad: bool = False):
        super().__init__(body)
        self.title, self.body, self.bad = title, body, bad


def check_cloak_form(mode: str, person: str, seed_text: str, out: str, source: str):
    """Validate the Cloak form; returns the parsed seed (None = random) or raises FormError."""
    if mode == "kinda" and not person.strip():
        raise FormError("Who is this one for?",
                        "'Keep who & where' needs a Person: the name that goes in every file "
                        "name, like anon_Sam_Peak_03. Type one in the Person box.")
    try:
        seed = workflow.parse_seed(seed_text)
    except ValueError as e:
        raise FormError("That seed is not a number", str(e))
    bad = workflow.output_problem(out, [source])
    if bad:
        raise FormError("That output folder will not do", bad, bad=True)
    return seed


def shorten_path(path: str, limit: int = 64) -> str:
    """Keep the start and the end of a long path, elide the middle."""
    if len(path) <= limit:
        return path
    keep = limit - 3
    head = keep // 3
    return path[:head] + "..." + path[-(keep - head):]
