"""The console banner: DIGGY DIGGY DANK in block letters, adrift in stars.

The word is composed from a letter table rather than written out as one big
string. Hand-aligning fourteen six-row letters is a losing game -- one stray
space and a column bends -- and composing it means the star field can be
scattered around whatever shape the word turns out to be.
"""
from __future__ import annotations

import functools
import math
import random

# Six-row block letters. Only the letters the banners need exist; adding a
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
    "C": [
        " ██████╗",
        "██╔════╝",
        "██║     ",
        "██║     ",
        "╚██████╗",
        " ╚═════╝",
    ],
    "L": [
        "██╗     ",
        "██║     ",
        "██║     ",
        "██║     ",
        "███████╗",
        "╚══════╝",
    ],
    "O": [
        " ██████╗ ",
        "██╔═══██╗",
        "██║   ██║",
        "██║   ██║",
        "╚██████╔╝",
        " ╚═════╝ ",
    ],
    "H": [
        "██╗  ██╗",
        "██║  ██║",
        "███████║",
        "██╔══██║",
        "██║  ██║",
        "╚═╝  ╚═╝",
    ],
    "E": [
        "███████╗",
        "██╔════╝",
        "█████╗  ",
        "██╔══╝  ",
        "███████╗",
        "╚══════╝",
    ],
    "R": [
        "██████╗ ",
        "██╔══██╗",
        "██████╔╝",
        "██╔══██╗",
        "██║  ██║",
        "╚═╝  ╚═╝",
    ],
    "B": [
        "██████╗ ",
        "██╔══██╗",
        "██████╔╝",
        "██╔══██╗",
        "██████╔╝",
        "╚═════╝ ",
    ],
    "T": [
        "████████╗",
        "╚══██╔══╝",
        "   ██║   ",
        "   ██║   ",
        "   ██║   ",
        "   ╚═╝   ",
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


# ---------------------------------------------------------------------------
# More banners. Same recipe as DIG: block letters (or none) with a sprite beside
# them, a star field scattered only into cells that are empty on every side, so a
# star can never fuse with a stroke. Each row is a list of (text, kind) segments;
# the GUI turns kinds into colours:
#   word   block letters        star  background sparkle
#   art    the sprite           hot   a hot accent (heartbeat line)
#   text   a bright caption
# ---------------------------------------------------------------------------

# Hue ramps (from, to) per banner, top row to bottom row. Hues run *down* the
# wheel like CosmicBar, so DIG stays the magenta -> mint it always was.
HUES = {
    "dig": (0.88, 0.42),
    "cloak": (0.80, 0.60),
    "check": (0.52, 0.36),
    "orbit": (0.10, -0.12),
    "success": (0.42, 0.14),
    "failure": (0.99, 0.92),
}
ART_HUES = {          # the sprite gets its own ramp so it separates from the word
    "dig": (0.88, 0.42),
    "cloak": (0.72, 0.55),
    "check": (0.95, 0.88),
    "orbit": (0.56, 0.45),
    "success": (0.14, 0.88),
    "failure": (0.62, 0.58),
}

GHOST = [
    r"       .-~~~~-.       ",
    r"     .'  _  _  '.     ",
    r"    /   (o)(o)   \    ",
    r"   |      ..      |   ",
    r"   |    '----'    |   ",
    r"   |   ~  ~~  ~   |   ",
    r"  /|  ~   ~~   ~  |\  ",
    r" ~ \_~/\__/\__/\~_/ ~ ",
    r"  ~   ~  ~   ~  ~   ~ ",
]

STETHOSCOPE = [
    r"  o         o  ",
    r"  |\       /|  ",
    r"  | \     / |  ",
    r"   \ \___/ /   ",
    r"    \     /    ",
    r"     |   |     ",
    r"     |   |     ",
    r"    .'   '.    ",
    r"   (   o   )   ",
    r"    '._ _.'    ",
]

ROCKET = [
    r"      /\      ",
    r"     /  \     ",
    r"    | () |    ",
    r"    |    |    ",
    r"   /|    |\   ",
    r"  / |    | \  ",
    r" /__|____|__\ ",
    r"     /\/\     ",
    r"    (_/\_)    ",
]

PLANET = [
    r"      _.-''-._       ",
    r"   .-'  ____  '-.    ",
    r"__/_.-'~      '~-._\_",
    r"(__ ===\______/=== __)",
    r"   '-.__      __.-'  ",
    r"        '''''        ",
]

PARTY_AMOEBA = [
    r"         .  *  .          ",
    r"      \   \  |  /   /     ",
    r'  *    .-"""""""-.    *   ',
    r"  \\  /   ^     ^   \  //  ",
    r"   \\|      \_/      |//   ",
    r"    \\\   ~~~~~~~   ///    ",
    r"      '-._________.-'      ",
    r"       ~~  ~~~~~  ~~       ",
]

SAD_AMOEBA = [
    r"      .-~~~~~~-.          ",
    r"    .'  x    x  '.        ",
    r"   /      __      \       ",
    r"  |      /  \      |      ",
    r"   \    '    '    /       ",
    r"    '-._ ____ _.-'        ",
    r"   ~~~~~ ~~  ~~~~ ~~      ",
]

CRACKED_DISC = [
    r'   .-""""-.   ',
    r"  / /\     \  ",
    r" |  \ \/\   | ",
    r" |  ( O )\  | ",
    r"  \     \ \/  ",
    r"   '-....-'   ",
]


def _sprinkle(text: str, kind: str, rng, density: float) -> list:
    """Split `text` into segments, turning isolated blanks into stars."""
    segs, buf, cur = [], "", kind
    for i, ch in enumerate(text):
        left = text[i - 1] if i else " "
        right = text[i + 1] if i + 1 < len(text) else " "
        star = ch == " " and left == " " and right == " " and rng.random() < density
        want = "star" if star else kind
        piece = rng.choice(STARS) if star else ch
        if want != cur and buf:
            segs.append((buf, cur))
            buf = ""
        cur = want
        buf += piece
    if buf:
        segs.append((buf, cur))
    return segs


def _sky(width: int, rng, density: float) -> list:
    return _sprinkle(" " * width, "star", rng, density)


def compose(word, art: list, seed: int = 7, extra: list | None = None,
            caption: list | None = None) -> list:
    """Word (optional) and sprite side by side, stars everywhere there is room.

    `extra` rows (text, kind) go under the pair, `caption` rows are bright text.
    """
    rng = random.Random(seed)
    wrows = render_word(word) if word else []
    ww = max((len(r) for r in wrows), default=0)
    aw = max(len(r) for r in art)
    h = max(len(wrows), len(art))
    w_off = (h - len(wrows)) // 2
    a_off = (h - len(art)) // 2
    gap = 5 if word else 0
    lead, tail = 5, 6
    total = lead + ww + gap + aw + tail
    rows = [_sky(total, rng, 0.10), _sky(total, rng, 0.06)]
    for i in range(h):
        wl = wrows[i - w_off] if 0 <= i - w_off < len(wrows) else " " * ww
        al = (art[i - a_off] if 0 <= i - a_off < len(art) else "").ljust(aw)
        segs = _sprinkle(" " * lead, "star", rng, 0.30)
        segs += [(wl, "word")] if wl.strip() else _sprinkle(wl, "star", rng, 0.07)
        if gap:
            segs += _sprinkle(" " * gap, "star", rng, 0.25)
        segs.append((al, "art"))
        segs += _sprinkle(" " * tail, "star", rng, 0.30)
        rows.append(segs)
    for text, kind in (extra or []):
        rows.append([(" " * lead, "star"), (text, kind)])
    for text in (caption or []):
        rows.append([(" " * lead, "star"), (text, "text")])
    rows += [_sky(total, rng, 0.06), _sky(total, rng, 0.10)]
    return rows


def _heartbeat(width: int = 64) -> str:
    """A flatline with two proper QRS spikes, in ASCII."""
    unit = list("_" * width)
    for centre in (width // 4, (width * 3) // 4):
        for off, ch in ((-4, "/"), (-3, "\\"), (-2, "_"), (-1, "/"), (0, "^"), (1, "\\"),
                        (2, "v"), (3, "/"), (4, "_")):
            x = centre + off
            if 0 <= x < width:
                unit[x] = ch
    return "".join(unit)


@functools.lru_cache(maxsize=None)
def pieces(name: str) -> list:
    """Rows of (text, kind) segments for the named banner (cached: the art never changes)."""
    if name == "dig":
        return [[(line, "word" if any(c in line for c in "█║═") else "star")]
                for line in BANNER]
    if name == "cloak":
        return compose("CLOAK", GHOST, seed=11,
                       caption=["a hood for every file. nobody here but us amoebas."])
    if name == "check":
        return compose("CHECK", STETHOSCOPE, seed=13,
                       extra=[(_heartbeat(), "hot")],
                       caption=["breathe in. say aaah. every second gets a listen."])
    if name == "orbit":
        return compose("ORBIT", ROCKET, seed=17,
                       extra=[(l, "art") for l in PLANET],
                       caption=["lift-off in three, two, one. tracks to the stars."])
    if name == "success":
        return compose(None, PARTY_AMOEBA, seed=23,
                       caption=["~ sparkling. absolutely sparkling. ~"])
    if name == "failure":
        return compose(None, SAD_AMOEBA + [""] + CRACKED_DISC, seed=29,
                       caption=["~ well. that cracked. nothing of yours was harmed. ~"])
    raise KeyError(name)


def plain(name: str) -> list:
    return ["".join(t for t, _ in row) for row in pieces(name)]


def burst(rng=None) -> list:
    """A little ring of sparkles for the moment something finishes."""
    rng = rng or random.Random()
    out = []
    cx, cy = 15, 3
    glyphs = "*✦✧+.·⋆"
    for r in range(7):
        line = []
        for c in range(31):
            d = math.hypot((c - cx) / 2.0, r - cy)
            if r == cy and c == cx:
                line.append("✺")
            elif 1.0 <= d <= 1.6 and rng.random() < 0.55:
                line.append(rng.choice(glyphs))
            elif 2.3 <= d <= 3.5 and rng.random() < 0.45:
                line.append(rng.choice(glyphs))
            else:
                line.append(" ")
        out.append("  " + "".join(line).rstrip())
    return out


# Console voice, per tab. READY is DIG's; the rest speak the same dialect.
TAB_READY = {
    "cloak": [
        "",
        "  Point me at a playlist and I'll sew every track a little hood.",
        "  I work on a COPY. Your originals are never touched, not even looked at sideways.",
        "  Tags, cover art, lyrics, comments: all of it comes off the copy.",
        "",
    ],
    "check": [
        "",
        "  Quick is a glance at the bones. Thorough listens to every single second.",
        "  A track can look fine and still stutter at 2:41. That is what Thorough is for.",
        "  I only read. I never fix, move, or delete.",
        "",
    ],
    "spotify": [
        "",
        "  I look each track up on Spotify and queue the matches into a playlist.",
        "  You sign in with your own account in your own browser. I never see your password.",
        "  Anything I am unsure about waits for your say-so. No sneaky guesses.",
        "",
    ],
}

FLAVOUR = {
    "dig": [
        "tapping the walls for hollow spots",
        "following a promising vein of bass",
        "brushing dust off a very old B-side",
        "the headlamp flickers. the notebook fills",
        "somewhere below, a decade of good decisions",
        "dig deeper. dig dankier",
    ],
    "cloak": [
        "teaching the files to wear a hood",
        "unpicking every last tag, gently",
        "cover art goes in the bin. the music stays",
        "stitching tiny hoods. very tiny. very many",
        "nobody here but us amoebas",
    ],
    "check": [
        "listening to every single second",
        "holding the stethoscope to the bass drum",
        "counting frames like sheep",
        "checking the pulse of the file",
        "say aaah",
    ],
    "orbit": [
        "asking the satellite nicely",
        "rehearsing the lift-off countdown",
        "polishing the rings of a small planet",
        "searching the stars for that one track",
        "dropping tracks into orbit",
    ],
}

POEM = [
    "",
    "   roses are dank, the violets too,",
    "   a cave full of tunes and a headlamp for you.",
    "   no tag was harmed, no file was moved,",
    "   the groove goes on. the dank is approved.",
    "",
]
