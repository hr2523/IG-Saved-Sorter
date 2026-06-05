"""Orchestration: classify media files and lay them out into category folders."""

from __future__ import annotations

import csv
import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional, Protocol

from .categories import UNCATEGORIZED
from .metadata import SavedPost, match_file_to_post


class Classifier(Protocol):
    """Anything with a ``classify_path`` method works as a classifier."""

    def classify_path(
        self, path: Path, top_k: int = 1, threshold: float = 0.0
    ) -> List[tuple]: ...


@dataclass
class ItemResult:
    source: str
    category: str
    confidence: float
    predictions: List[tuple] = field(default_factory=list)
    destination: Optional[str] = None
    post: Optional[SavedPost] = None
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "category": self.category,
            "confidence": round(self.confidence, 4),
            "predictions": [
                {"category": c, "confidence": round(s, 4)} for c, s in self.predictions
            ],
            "destination": self.destination,
            "post": self.post.to_dict() if self.post else None,
            "error": self.error,
        }


@dataclass
class SortReport:
    items: List[ItemResult] = field(default_factory=list)

    @property
    def counts(self) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for item in self.items:
            out[item.category] = out.get(item.category, 0) + 1
        return out

    @property
    def errors(self) -> List[ItemResult]:
        return [i for i in self.items if i.error]

    def to_dict(self) -> dict:
        return {
            "total": len(self.items),
            "counts": self.counts,
            "items": [i.to_dict() for i in self.items],
        }


def _safe_destination(dest_dir: Path, name: str) -> Path:
    """Return a non-colliding path inside ``dest_dir`` for ``name``."""
    candidate = dest_dir / name
    if not candidate.exists():
        return candidate
    stem, suffix = candidate.stem, candidate.suffix
    i = 1
    while True:
        candidate = dest_dir / f"{stem}_{i}{suffix}"
        if not candidate.exists():
            return candidate
        i += 1


def _place(src: Path, dest: Path, strategy: str) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if strategy == "copy":
        shutil.copy2(src, dest)
    elif strategy == "move":
        shutil.move(str(src), str(dest))
    elif strategy == "symlink":
        dest.symlink_to(src.resolve())
    else:
        raise ValueError(f"Unknown strategy: {strategy}")


def sort_media(
    media_files: List[Path],
    classifier: Classifier,
    output_dir: str | Path,
    strategy: str = "copy",
    top_k: int = 3,
    threshold: float = 0.0,
    dry_run: bool = False,
    shortcode_index: Optional[Dict[str, SavedPost]] = None,
    metadata_by_path: Optional[Dict[str, SavedPost]] = None,
    caption_weight: float = 0.55,
    on_progress: Optional[Callable[[int, int, ItemResult], None]] = None,
) -> SortReport:
    """Classify each file and place it under ``output_dir/<Category>/``.

    The folder placement uses the top prediction; the full top-k ranking is kept
    in the report. Files scoring below ``threshold`` go to *Uncategorized*.

    Post metadata can be attached two ways: ``metadata_by_path`` maps an exact
    source path to its :class:`SavedPost` (used by the instagrapi sync flow,
    where we already know each file's origin); ``shortcode_index`` matches by the
    post shortcode embedded in the filename (used by ``sort --export``).
    """
    output_dir = Path(output_dir)
    report = SortReport()
    total = len(media_files)

    for idx, src in enumerate(media_files, start=1):
        item = ItemResult(source=str(src), category=UNCATEGORIZED, confidence=0.0)
        # The caption (when we know the post) is a strong classification signal.
        caption = None
        if metadata_by_path and str(src) in metadata_by_path:
            caption = getattr(metadata_by_path[str(src)], "caption", None)
        try:
            try:
                predictions = classifier.classify_path(
                    src, top_k=top_k, threshold=0.0,
                    caption=caption, caption_weight=caption_weight,
                )
            except TypeError:
                # Classifier doesn't support captions (e.g. a test stub).
                predictions = classifier.classify_path(src, top_k=top_k, threshold=0.0)
            item.predictions = predictions
            if predictions and predictions[0][1] >= threshold:
                item.category, item.confidence = predictions[0]
            else:
                item.category, item.confidence = (
                    UNCATEGORIZED,
                    predictions[0][1] if predictions else 0.0,
                )
        except Exception as exc:  # keep going on a single bad file
            item.error = f"{type(exc).__name__}: {exc}"

        if metadata_by_path and str(src) in metadata_by_path:
            item.post = metadata_by_path[str(src)]
        elif shortcode_index:
            item.post = match_file_to_post(src.name, shortcode_index)

        if not dry_run and item.error is None:
            dest = _safe_destination(output_dir / item.category, src.name)
            _place(src, dest, strategy)
            item.destination = str(dest)

        report.items.append(item)
        if on_progress:
            on_progress(idx, total, item)

    return report


def write_manifest(report: SortReport, output_dir: str | Path) -> Path:
    """Write a JSON manifest of the full report; return its path."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "manifest.json"
    path.write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
    return path


def write_csv(report: SortReport, output_dir: str | Path) -> Path:
    """Write a flat CSV summary of classifications; return its path."""
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / "manifest.csv"
    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(
            ["source", "category", "confidence", "destination", "username", "url", "error"]
        )
        for item in report.items:
            writer.writerow(
                [
                    item.source,
                    item.category,
                    f"{item.confidence:.4f}",
                    item.destination or "",
                    item.post.username if item.post else "",
                    item.post.url if item.post else "",
                    item.error or "",
                ]
            )
    return path


def recategorize_file(
    current_path: str | Path, new_category: str, output_dir: str | Path
) -> Path:
    """Move an already-sorted file into ``output_dir/<new_category>/``.

    Returns the new path. Used by the web app when you correct a classification.
    """
    current_path = Path(current_path)
    if not current_path.exists():
        raise FileNotFoundError(f"File not found: {current_path}")
    dest = _safe_destination(Path(output_dir) / new_category, current_path.name)
    _place(current_path, dest, "move")
    return dest
