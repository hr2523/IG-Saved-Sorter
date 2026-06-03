"""Filesystem scanning for media files."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable, List

IMAGE_EXTS = {
    ".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif",
    ".heic", ".heif", ".tif", ".tiff",
}
VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".3gp"}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS


def is_image(path: Path) -> bool:
    return path.suffix.lower() in IMAGE_EXTS


def is_video(path: Path) -> bool:
    return path.suffix.lower() in VIDEO_EXTS


def is_media(path: Path) -> bool:
    return path.suffix.lower() in MEDIA_EXTS


def scan_media(root: str | Path, recursive: bool = True) -> List[Path]:
    """Return a sorted list of media files under ``root``.

    Hidden files (dotfiles) are skipped.
    """
    root = Path(root)
    if root.is_file():
        return [root] if is_media(root) else []
    if not root.is_dir():
        raise NotADirectoryError(f"Not a directory: {root}")

    walker: Iterable[Path] = root.rglob("*") if recursive else root.glob("*")
    files = [
        p for p in walker
        if p.is_file() and is_media(p) and not p.name.startswith(".")
    ]
    return sorted(files)
