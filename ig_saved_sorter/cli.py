"""Command-line interface for IG Saved Sorter."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .categories import DEFAULT_CATEGORIES, load_categories
from .metadata import build_shortcode_index, parse_saved_posts
from .scanner import scan_media
from .sorter import ItemResult, sort_media, write_csv, write_manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ig-saved-sorter",
        description="Organize Instagram saved media into topic folders using local CLIP.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")

    parser.add_argument(
        "input",
        nargs="?",
        help="Folder (or single file) of saved media to classify.",
    )
    parser.add_argument(
        "-o", "--output",
        help="Destination root for category folders (default: <input>/sorted).",
    )
    parser.add_argument(
        "--strategy",
        choices=["copy", "move", "symlink"],
        default="copy",
        help="How to place files into category folders (default: copy).",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.15,
        help="Min top-1 confidence (0-1) to assign a category; else Uncategorized.",
    )
    parser.add_argument(
        "--top-k", type=int, default=3,
        help="How many ranked predictions to record per item (default: 3).",
    )
    parser.add_argument(
        "--no-recursive", action="store_true",
        help="Do not descend into subfolders of the input.",
    )
    parser.add_argument(
        "--categories-file",
        help="JSON file overriding the default category->prompts taxonomy.",
    )
    parser.add_argument(
        "--export",
        help="Path to Instagram saved_posts.json to enrich results (url/username).",
    )
    parser.add_argument(
        "--model", default="ViT-B-32", help="open_clip model name (default: ViT-B-32).",
    )
    parser.add_argument(
        "--pretrained", default="laion2b_s34b_b79k",
        help="open_clip pretrained weights tag.",
    )
    parser.add_argument(
        "--device", default=None, help="Force device, e.g. 'cpu' or 'cuda'.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Classify and report without moving/copying any files.",
    )
    parser.add_argument(
        "--list-categories", action="store_true",
        help="Print the active categories and exit.",
    )
    return parser


def _print_categories(categories) -> None:
    print(f"{len(categories)} categories:")
    for name, prompts in categories.items():
        print(f"  - {name}  ({len(prompts)} prompts)")


def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        categories = load_categories(args.categories_file)
    except (ValueError, OSError) as exc:
        parser.error(f"Could not load categories: {exc}")

    if args.list_categories:
        _print_categories(categories)
        return 0

    if not args.input:
        parser.error("an input folder is required (or use --list-categories)")

    input_path = Path(args.input)
    if not input_path.exists():
        parser.error(f"Input path does not exist: {input_path}")

    media_files = scan_media(input_path, recursive=not args.no_recursive)
    if not media_files:
        print(f"No media files found under {input_path}", file=sys.stderr)
        return 1

    if args.output:
        output_dir = Path(args.output)
    elif input_path.is_file():
        output_dir = input_path.parent / "sorted"
    else:
        output_dir = input_path / "sorted"

    shortcode_index = None
    if args.export:
        posts = parse_saved_posts(args.export)
        shortcode_index = build_shortcode_index(posts)
        print(f"Loaded {len(posts)} saved posts ({len(shortcode_index)} with shortcodes).")

    print(
        f"Found {len(media_files)} media file(s). "
        f"Loading CLIP model '{args.model}' ({args.pretrained})..."
    )

    # Lazy import keeps non-ML commands usable without torch installed.
    from .classifier import MissingDependencyError, build_classifier

    try:
        classifier = build_classifier(
            categories,
            model_name=args.model,
            pretrained=args.pretrained,
            device=args.device,
        )
    except MissingDependencyError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        print("Install ML deps with: pip install -r requirements.txt", file=sys.stderr)
        return 2

    def progress(idx: int, total: int, item: ItemResult) -> None:
        status = item.error or f"{item.category} ({item.confidence:.2f})"
        print(f"[{idx}/{total}] {Path(item.source).name} -> {status}")

    report = sort_media(
        media_files,
        classifier,
        output_dir,
        strategy=args.strategy,
        top_k=args.top_k,
        threshold=args.threshold,
        dry_run=args.dry_run,
        shortcode_index=shortcode_index,
        on_progress=progress,
    )

    manifest = write_manifest(report, output_dir)
    csv_path = write_csv(report, output_dir)

    print("\nSummary:")
    for category, count in sorted(report.counts.items(), key=lambda kv: -kv[1]):
        print(f"  {count:>4}  {category}")
    if report.errors:
        print(f"\n{len(report.errors)} file(s) could not be processed.")
    print(f"\nManifest: {manifest}")
    print(f"CSV:      {csv_path}")
    if args.dry_run:
        print("(dry-run: no files were copied/moved)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
