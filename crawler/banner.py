"""The console banner: DIGGY DIGGY DANK in block letters, adrift in stars.

The word is composed from a letter table rather than written out as one big
string. Hand-aligning fourteen six-row letters is a losing game -- one stray
space and a column bends -- and composing it means the star field can be
scattered around whatever shape the word turns out to be.
"""
from __future__ import annotations

import random

# Six-row block letters. Only the ones DIGGY DIGGY DANK needs exist; adding a
# letter means adding six equal-width rows here and nothing else.
LETTERS = {
    "D": [
        "██████╗ ",
        "██╔══██╗",
        "██║  ██║",
        "██║  ██║",
        "██████╔╝",
        "╚═════╝ ",
    ],
    "I": [
        "██╗",
        "██║",
        "██║",
        "██║",
        "██║",
        "╚═╝",
    ],
    "G": [
        " ██████╗ ",
        "██╔════╝ ",
        "██║  ███╗",
        "██║   ██║",
        "╚██████╔╝",
        " ╚═════╝ ",
    ],
    "Y": [
        "██╗   ██╗",
        "╚██╗ ██╔╝",
        " ╚████╔╝ ",
        "  ╚██╔╝  ",
        "   ██║   ",
        "   ╚═╝   ",
    ],
    "A": [
        " █████╗ ",
        "██╔══██╗",
        "███████║",
        "██╔══██║",
        "██║  ██║",
        "╚═╝  ╚═╝",
    ],
    "N": [
        "███╗   ██╗",
        "████╗  ██║",
        "██╔██╗ ██║",
        "██║╚██╗██║",
        "██║ ╚████║",
        "╚═╝  ╚═══╝",
    ],
    "K": [
        "██╗  ██╗",
        "██║ ██╔╝",
        "█████╔╝ ",
        "██╔═██╗ ",
        "██║  ██╗",
        "╚═╝  ╚═╝",
    ],
    " ": ["  "] * 6,
}

ROWS = 6
STARS = [".", "·", "*", "✦", "˙", "+"]


def render_word(word: str) -> list:
    """One word to six aligned rows."""
    lines = [""] * ROWS
    for ch in word.upper():
        glyph = LETTERS.get(ch)
        if not glyph:
            continue
        for r in range(ROWS):
            lines[r] += glyph[r]
    return lines


def build(seed: int = 7) -> list:
    """The finished banner, as lines. Seeded so it looks the same every run."""
    rng = random.Random(seed)

    top = render_word("DIGGY DIGGY")
    bottom = render_word("DANK")
    width = max(len(l) for l in top)
    pad = (width - max(len(l) for l in bottom)) // 2
    bottom = [" " * pad + l for l in bottom]

    body = top + [""] + bottom

    def scatter(n: int, density: float) -> str:
        return "".join(
            rng.choice(STARS) if rng.random() < density else " " for _ in range(n))

    def starry(line: str, density: float) -> str:
        """Scatter stars into the margins, keeping a clear gutter either side.

        Without the gutter a star lands flush against a stroke and reads as
        part of the letter.
        """
        left = scatter(4, density) + "  "
        right = "  " + scatter(8, density)
        return left + line.ljust(width) + right

    def sky(density: float) -> str:
        return scatter(width + 14, density)

    out = [sky(0.10), sky(0.06)]
    for line in body:
        # Blank rows between the words get their own stars; letter rows only
        # get them in the margins, so nothing collides with the type.
        out.append(sky(0.07) if not line.strip() else starry(line, 0.30))
    out += [sky(0.06), sky(0.10)]
    return out


BANNER = build()

READY = [
    "",
    "  Somewhere in this folder is a decade of very good decisions.",
    "  I'm going in with a headlamp and a notebook -- names, tags, nothing else.",
    "  Nothing gets moved, copied, or uploaded. Your tunes never leave the cave.",
    "",
]
