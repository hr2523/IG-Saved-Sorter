"""Command-line interface for IG Saved Sorter.

Subcommands:
  sort        Classify a local folder of media into topic folders.
  sync        Log into Instagram, download NEW saved posts, then sort them.
  categories  Print the active category taxonomy.
"""

from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

from . import __version__
from .categories import load_categories
from .metadata import SavedPost, build_shortcode_index, parse_saved_posts
from .scanner import scan_media
from .sorter import ItemResult, SortReport, sort_media, write_csv, write_manifest


# --------------------------------------------------------------------------- #
# Argument parsing
# --------------------------------------------------------------------------- #

def _add_sort_options(parser: argparse.ArgumentParser) -> None:
    """Options shared by `sort` and `sync` (classification + placement)."""
    parser.add_argument(
        "--strategy", choices=["copy", "move", "symlink"], default="copy",
        help="How to place files into category folders (default: copy).",
    )
    parser.add_argument(
        "--threshold", type=float, default=0.15,
        help="Min top-1 confidence (0-1) to assign a category; else Uncategorized.",
    )
    parser.add_argument(
        "--top-k", type=int, default=3,
        help="How many ranked predictions to record per item (default: 3).",
    )
    parser.add_argument(
        "--categories-file",
        help="JSON file overriding the default category->prompts taxonomy.",
    )
    parser.add_argument("--model", default="ViT-B-32", help="open_clip model name.")
    parser.add_argument(
        "--pretrained", default="laion2b_s34b_b79k",
        help="open_clip pretrained weights tag.",
    )
    parser.add_argument("--device", default=None, help="Force 'cpu' or 'cuda'.")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Classify and report without moving/copying any files.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ig-saved-sorter",
        description="Organize Instagram saved media into topic folders using local CLIP.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument(
        "--list-categories", action="store_true",
        help="Print the default categories and exit (shortcut for 'categories').",
    )

    sub = parser.add_subparsers(dest="command")

    # sort -------------------------------------------------------------------
    sort_p = sub.add_parser("sort", help="Sort a local folder of media.")
    sort_p.add_argument("input", help="Folder (or single file) of saved media.")
    sort_p.add_argument(
        "-o", "--output", help="Destination root (default: <input>/sorted).",
    )
    sort_p.add_argument(
        "--export", help="Instagram saved_posts.json to enrich results.",
    )
    sort_p.add_argument(
        "--no-recursive", action="store_true",
        help="Do not descend into subfolders of the input.",
    )
    _add_sort_options(sort_p)

    # sync -------------------------------------------------------------------
    sync_p = sub.add_parser(
        "sync", help="Fetch NEW saved posts from Instagram, then sort them."
    )
    sync_p.add_argument("-u", "--user", required=True, help="Your Instagram username.")
    sync_p.add_argument(
        "--password",
        help="Password (else $IG_PASSWORD, else prompt). A saved session is preferred.",
    )
    sync_p.add_argument("--session-file", help="Path to an Instaloader session file.")
    sync_p.add_argument(
        "--media-dir", default="./ig_saved_media",
        help="Where to download saved media (default: ./ig_saved_media).",
    )
    sync_p.add_argument(
        "-o", "--output", help="Destination root (default: <media-dir>/sorted).",
    )
    sync_p.add_argument(
        "--state-file",
        help="Sync state JSON tracking seen posts (default: <media-dir>/.sync_state.json).",
    )
    sync_p.add_argument(
        "--limit", type=int, default=None,
        help="Max number of NEW posts to download this run.",
    )
    sync_p.add_argument(
        "--no-sort", action="store_true",
        help="Only download new saves; skip classification.",
    )
    _add_sort_options(sync_p)

    # categories -------------------------------------------------------------
    cat_p = sub.add_parser("categories", help="Print the active taxonomy.")
    cat_p.add_argument("--categories-file", help="JSON taxonomy override to print.")

    return parser


# --------------------------------------------------------------------------- #
# Shared helpers
# --------------------------------------------------------------------------- #

def _print_categories(categories) -> None:
    print(f"{len(categories)} categories:")
    for name, prompts in categories.items():
        print(f"  - {name}  ({len(prompts)} prompts)")


def _progress(idx: int, total: int, item: ItemResult) -> None:
    status = item.error or f"{item.category} ({item.confidence:.2f})"
    print(f"[{idx}/{total}] {Path(item.source).name} -> {status}")


def _run_sort(
    args, categories, media_files, output_dir, shortcode_index
) -> int:
    """Build the classifier, sort the files, write reports. Returns exit code."""
    print(
        f"Found {len(media_files)} media file(s). "
        f"Loading CLIP model '{args.model}' ({args.pretrained})..."
    )
    from .classifier import MissingDependencyError, build_classifier

    try:
        classifier = build_classifier(
            categories, model_name=args.model,
            pretrained=args.pretrained, device=args.device,
        )
    except MissingDependencyError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        print("Install ML deps with: pip install -r requirements.txt", file=sys.stderr)
        return 2

    report = sort_media(
        media_files, classifier, output_dir,
        strategy=args.strategy, top_k=args.top_k, threshold=args.threshold,
        dry_run=args.dry_run, shortcode_index=shortcode_index,
        on_progress=_progress,
    )
    _report_summary(report, output_dir, args.dry_run)
    return 0


def _report_summary(report: SortReport, output_dir, dry_run: bool) -> None:
    manifest = write_manifest(report, output_dir)
    csv_path = write_csv(report, output_dir)
    print("\nSummary:")
    for category, count in sorted(report.counts.items(), key=lambda kv: -kv[1]):
        print(f"  {count:>4}  {category}")
    if report.errors:
        print(f"\n{len(report.errors)} file(s) could not be processed.")
    print(f"\nManifest: {manifest}")
    print(f"CSV:      {csv_path}")
    if dry_run:
        print("(dry-run: no files were copied/moved)")


# --------------------------------------------------------------------------- #
# Command handlers
# --------------------------------------------------------------------------- #

def _cmd_sort(args, parser) -> int:
    categories = load_categories(args.categories_file)
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

    return _run_sort(args, categories, media_files, output_dir, shortcode_index)


def _cmd_sync(args, parser) -> int:
    from .fetcher import FetcherError, InstaloaderFetcher, sync_saved

    media_dir = Path(args.media_dir)
    state_file = Path(args.state_file) if args.state_file else media_dir / ".sync_state.json"
    password = args.password or os.environ.get("IG_PASSWORD")

    interactive = sys.stdin.isatty()

    def ask_2fa() -> str:
        return input("Enter the 6-digit two-factor code (authenticator app or SMS): ")

    two_factor_cb = ask_2fa if interactive else None

    try:
        fetcher = InstaloaderFetcher()
        # Only prompt for a password if there's no session to fall back on.
        try:
            fetcher.login(
                args.user, password=password,
                session_file=args.session_file, two_factor_callback=two_factor_cb,
            )
        except FetcherError:
            if password is None and interactive:
                password = getpass.getpass(f"Instagram password for {args.user}: ")
                fetcher.login(
                    args.user, password=password,
                    session_file=args.session_file, two_factor_callback=two_factor_cb,
                )
            else:
                raise
    except FetcherError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 2

    def on_fetch(n: int, post: SavedPost) -> None:
        who = post.username or "?"
        print(f"  +{n} downloaded {post.shortcode} (@{who})")

    print(f"Fetching saved posts as @{args.user} into {media_dir} ...")
    try:
        result = sync_saved(
            fetcher, media_dir, state_file, limit=args.limit, on_progress=on_fetch
        )
    except Exception as exc:  # network / endpoint / auth surprises
        print(f"\nError while fetching: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    print(
        f"\nDownloaded {result.new_count} new post(s); "
        f"skipped {result.skipped} already-synced."
    )
    if result.new_count == 0:
        print("Nothing new to sort.")
        return 0
    if args.no_sort:
        return 0

    categories = load_categories(args.categories_file)
    output_dir = Path(args.output) if args.output else media_dir / "sorted"
    shortcode_index = build_shortcode_index(result.posts)
    # Sort only the freshly downloaded files.
    return _run_sort(args, categories, result.downloaded, output_dir, shortcode_index)


def _cmd_categories(args) -> int:
    _print_categories(load_categories(args.categories_file))
    return 0


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #

def main(argv=None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.list_categories:
            return _cmd_categories(argparse.Namespace(categories_file=None))
        if args.command == "sort":
            return _cmd_sort(args, parser)
        if args.command == "sync":
            return _cmd_sync(args, parser)
        if args.command == "categories":
            return _cmd_categories(args)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))

    parser.error("a subcommand is required (sort, sync, or categories)")
    return 2  # unreachable; parser.error exits


if __name__ == "__main__":
    raise SystemExit(main())
