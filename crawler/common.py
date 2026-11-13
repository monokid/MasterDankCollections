"""Small helpers shared by the engines (scanner, cloak, integrity, spotify_link, workflow).

Standard library only and import-cheap, so every engine can still be imported on its own.
"""
from __future__ import annotations

import contextlib
import os
import re
import stat as _stat

# Extensions. scanner's AUDIO_EXTS is deliberately generous: a miss costs one failed tag
# read, recorded as an error. VIDEO_EXTS are kept because a video among the tracks is a
# real anomaly worth cataloguing.
AUDIO_EXTS = frozenset({
    ".mp3", ".flac", ".m4a", ".mp4", ".aac", ".ogg", ".oga", ".opus", ".wav",
    ".wma", ".ape", ".wv", ".mpc", ".aiff", ".aif", ".alac", ".m4b", ".mka",
})
VIDEO_EXTS = frozenset({".mp4", ".mkv", ".avi", ".webm", ".mov", ".wmv", ".m4v", ".flv"})

# Container families the anonymiser can strip (cloak) and the checker can walk (integrity).
MP3_EXTS = frozenset({".mp3"})
FLAC_EXTS = frozenset({".flac"})
MP4_EXTS = frozenset({".m4a", ".mp4", ".m4b"})
WAV_EXTS = frozenset({".wav"})
AIFF_EXTS = frozenset({".aiff", ".aif"})
OGG_EXTS = frozenset({".ogg", ".oga", ".opus"})

# subprocess.run(creationflags=...) value that stops a console window flashing up on Windows.
CREATE_NO_WINDOW = 0x08000000


def no_window_kwargs() -> dict:
    """Extra subprocess keyword arguments: hide the console window on Windows, nothing elsewhere."""
    return {"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {}


# ----------------------------------------------------------------- paths

_LONG_PREFIX = "\\\\?\\"
_UNC_PREFIX = _LONG_PREFIX + "UNC\\"


def long_path(p: str) -> str:
    """Windows caps paths at 260 characters unless they carry the extended-length prefix. No-op elsewhere."""
    if os.name != "nt":
        return p
    if p.startswith(_LONG_PREFIX):
        return p
    p = os.path.abspath(p)
    if p.startswith("\\\\"):
        return _UNC_PREFIX + p[2:]
    return _LONG_PREFIX + p


def plain_path(p: str) -> str:
    """Undo long_path: drop the extended-length prefix again (for paths shown to people or stored)."""
    if p.startswith(_UNC_PREFIX):
        return "\\\\" + p[len(_UNC_PREFIX):]
    if p.startswith(_LONG_PREFIX):
        return p[len(_LONG_PREFIX):]
    return p


def norm_path(p: str) -> str:
    """Canonical key for 'is this the same real file': absolute, links resolved, case-folded."""
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def is_within(child: str, parent: str) -> bool:
    """True if child == parent or child is inside parent (both already through norm_path)."""
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:  # different drives
        return False


def is_regular_file(path: str) -> tuple:
    """(exists, is_file, size) from ONE stat call; long-path safe."""
    try:
        st = os.stat(long_path(path))
    except OSError:
        return False, False, 0
    return True, _stat.S_ISREG(st.st_mode), st.st_size


# ----------------------------------------------------------------- text

_NUM_SPLIT = re.compile(r"(\d+)")


def natural_key(s: str) -> list:
    """Sort key for 'Track 2' < 'Track 10'. Always [str, int, str, int, ...]."""
    return [int(t) if i % 2 else t.casefold() for i, t in enumerate(_NUM_SPLIT.split(s))]


def split_hms(sec) -> tuple:
    """Seconds (rounded, never negative) -> (hours, minutes, seconds)."""
    sec = int(round(max(sec, 0)))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    return h, m, s


# ----------------------------------------------------------------- files

def atomic_write(path: str, write, mode: str = "w", *, private: bool = False, **open_kw) -> None:
    """Write via `write(fh)` to path + '.tmp', then rename over `path`; the tmp file never outlives a failure.

    Raises whatever open/write/replace raises (callers decide whether that matters).
    `private=True` makes the file owner-only where the OS supports it.
    """
    tmp = path + ".tmp"
    try:
        with open(tmp, mode, **open_kw) as fh:
            write(fh)
        if private:
            with contextlib.suppress(OSError):
                os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


# ----------------------------------------------------------------- walking

_REPARSE = getattr(_stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


def _is_reparse_dir(entry) -> bool:
    """A Windows junction / mount point (os.walk follows these, unlike symlinks)."""
    try:
        return bool(entry.stat(follow_symlinks=False).st_file_attributes & _REPARSE)
    except (OSError, AttributeError):
        return False


def walk_entries(top: str):
    """os.walk-alike over os.scandir that hands back DirEntry objects (their stat is free on Windows).

    Yields (dirpath, dirs, files) in the same preorder as os.walk(top): `dirs` and `files` are lists
    of DirEntry; remove entries from `dirs` in place to prune. Symlinked folders are listed in
    `dirs` but never entered (as os.walk). A junction that points at one of its own ancestors is not
    entered either, so a loop cannot run forever. Unreadable folders are skipped silently.
    """
    stack = [top]
    while stack:
        dirpath = stack.pop()
        try:
            with os.scandir(dirpath) as it:
                entries = list(it)
        except OSError:
            continue
        dirs, files = [], []
        for e in entries:
            try:
                is_dir = e.is_dir()
            except OSError:
                is_dir = False
            (dirs if is_dir else files).append(e)
        yield dirpath, dirs, files
        real = None
        todo = []
        for d in dirs:
            try:
                if d.is_symlink():
                    continue
            except OSError:
                continue
            if _is_reparse_dir(d):
                if real is None:
                    real = norm_path(dirpath)
                if is_within(real, norm_path(d.path)):
                    continue  # points at this folder or one above it: a loop
            todo.append(d.path)
        stack.extend(reversed(todo))
