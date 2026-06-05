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
        "--collection",
        help="Fetch only this saved Collection (by name). Default: all saved posts.",
    )
    sync_p.add_argument(
        "--list-collections", action="store_true",
        help="List your saved Collections and exit (no download).",
    )
    sync_p.add_argument(
        "--no-sort", action="store_true",
        help="Only download new saves; skip classification.",
    )
    _add_sort_options(sync_p)

    # web --------------------------------------------------------------------
    web_p = sub.add_parser("web", help="Launch the interactive review web app.")
    web_p.add_argument(
        "sorted_dir", nargs="?", default="./ig_saved_media/sorted",
        help="Folder containing manifest.json (default: ./ig_saved_media/sorted).",
    )
    web_p.add_argument("--host", default="127.0.0.1", help="Bind host (default: 127.0.0.1).")
    web_p.add_argument("--port", type=int, default=5000, help="Port (default: 5000).")
    web_p.add_argument("--categories-file", help="JSON taxonomy override.")
    # Optional: wire Instagram sync into the web UI (uses a saved session).
    web_p.add_argument("-u", "--user", help="Instagram username to enable in-app sync.")
    web_p.add_argument("--session-file", help="Instagrapi session file for in-app sync.")
    web_p.add_argument("--media-dir", default="./ig_saved_media", help="Where sync downloads media.")
    web_p.add_argument("--state-file", help="Sync state file (default: <media-dir>/.sync_state.json).")
    web_p.add_argument("--threshold", type=float, default=0.15, help="Classification threshold for in-app sync.")
    web_p.add_argument("--strategy", choices=["copy", "move", "symlink"], default="copy")
    web_p.add_argument("--top-k", type=int, default=3)
    web_p.add_argument("--model", default="ViT-B-32")
    web_p.add_argument("--pretrained", default="laion2b_s34b_b79k")
    web_p.add_argument("--device", default=None)

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
    args, categories, media_files, output_dir,
    shortcode_index=None, metadata_by_path=None,
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
        dry_run=getattr(args, "dry_run", False), shortcode_index=shortcode_index,
        metadata_by_path=metadata_by_path, on_progress=_progress,
    )
    _report_summary(report, output_dir, getattr(args, "dry_run", False))
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


def _login_fetcher(args):
    """Build an InstagrapiFetcher and log in, prompting interactively as needed.

    Raises FetcherError on failure (caller converts to an exit code).
    """
    from .fetcher import FetcherError, InstagrapiFetcher

    password = getattr(args, "password", None) or os.environ.get("IG_PASSWORD")
    interactive = sys.stdin.isatty()

    def ask_2fa() -> str:
        print(
            "\nTwo-factor step: enter your authenticator-app code, an SMS code, "
            "or an 8-digit backup code."
        )
        return input("Two-factor code: ").strip()

    def ask_challenge(choice: str) -> str:
        # instagrapi passes the method: SMS (0) or EMAIL (1).
        method = {
            "0": "SMS text message", "1": "email",
            "SMS": "SMS text message", "EMAIL": "email",
        }.get(str(choice).upper(), f"'{choice}'")
        print(
            f"\nInstagram security check: it just sent a 6-digit code to your "
            f"{method} for THIS login."
        )
        print(
            "  -> Check there now (look in spam for email). This is NOT your "
            "authenticator/backup code."
        )
        return input("Enter that 6-digit code: ").strip()

    two_factor_cb = ask_2fa if interactive else None
    challenge_cb = ask_challenge if interactive else None

    if password is None and interactive and not (
        args.session_file and Path(args.session_file).exists()
    ):
        password = getpass.getpass(f"Instagram password for {args.user}: ")

    fetcher = InstagrapiFetcher()
    attempts = 3 if interactive else 1
    last_exc = None
    for i in range(attempts):
        try:
            fetcher.login(
                args.user, password=password, session_file=args.session_file,
                two_factor_callback=two_factor_cb, challenge_callback=challenge_cb,
            )
            return fetcher
        except FetcherError as exc:
            last_exc = exc
            msg = str(exc).lower()
            retryable = any(
                s in msg for s in ("security code", "check the", "challenge", "try again")
            )
            if i < attempts - 1 and retryable:
                print(
                    f"\nThat didn't work (attempt {i + 1}/{attempts}). Instagram "
                    "may send a NEW code — let's try once more.\n"
                    "Tip: approve the login in the Instagram app first if it asks.",
                    file=sys.stderr,
                )
                continue
            raise
    raise last_exc  # pragma: no cover


def _cmd_sync(args, parser) -> int:
    from .fetcher import FetcherError, sync_saved

    media_dir = Path(args.media_dir)
    state_file = Path(args.state_file) if args.state_file else media_dir / ".sync_state.json"

    try:
        fetcher = _login_fetcher(args)
    except FetcherError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 2

    if args.list_collections:
        try:
            cols = fetcher.list_collections()
        except Exception as exc:
            print(f"\nError listing collections: {exc}", file=sys.stderr)
            return 2
        print(f"{len(cols)} collection(s):")
        for name, count in cols:
            print(f"  - {name}  ({count} posts)")
        return 0

    try:
        fetcher.select_collection(args.collection)
    except FetcherError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 2

    def on_fetch(n: int, post: SavedPost) -> None:
        print(f"  +{n} downloaded {post.shortcode} (@{post.username or '?'})")

    where = f"collection '{args.collection}'" if args.collection else "all saved posts"
    print(f"Fetching {where} as @{args.user} into {media_dir} ...")
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
    metadata_by_path = {str(p): post for p, post in zip(result.downloaded, result.posts)}
    return _run_sort(
        args, categories, result.downloaded, output_dir,
        metadata_by_path=metadata_by_path,
    )


def _cmd_web(args, parser) -> int:
    from .webapp import WebConfig, create_app

    sorted_dir = Path(args.sorted_dir)
    categories = list(load_categories(args.categories_file).keys())

    list_collections = None
    run_sync = None
    if args.user:
        # In-app sync reuses a saved session (no interactive 2FA in the browser).
        list_collections, run_sync = _build_web_sync_hooks(args, sorted_dir, categories)

    config = WebConfig(
        sorted_dir=sorted_dir, categories=categories,
        list_collections=list_collections, run_sync=run_sync,
    )
    try:
        app = create_app(config)
    except RuntimeError as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        return 2

    print(f"Serving review app for {sorted_dir} at http://{args.host}:{args.port}")
    if not args.user:
        print("(in-app Instagram sync disabled; pass --user to enable it)")
    app.run(host=args.host, port=args.port)
    return 0


def _build_web_sync_hooks(args, sorted_dir, categories):
    """Return (list_collections, run_sync) closures for the web app."""
    from .fetcher import sync_saved

    media_dir = Path(args.media_dir)
    state_file = Path(args.state_file) if args.state_file else media_dir / ".sync_state.json"
    cats = load_categories(args.categories_file)
    fetcher_holder = {}

    def _ensure_fetcher():
        if "f" not in fetcher_holder:
            fetcher_holder["f"] = _login_fetcher(args)
        return fetcher_holder["f"]

    def list_collections():
        return _ensure_fetcher().list_collections()

    def run_sync(collection, limit):
        fetcher = _ensure_fetcher()
        fetcher.select_collection(collection)
        result = sync_saved(fetcher, media_dir, state_file, limit=limit)
        summary = {"new_count": result.new_count, "skipped": result.skipped}
        if result.new_count and not getattr(args, "no_sort", False):
            from .classifier import build_classifier
            from .sorter import sort_media, write_csv, write_manifest
            classifier = build_classifier(
                cats, model_name=args.model,
                pretrained=args.pretrained, device=args.device,
            )
            meta = {str(p): post for p, post in zip(result.downloaded, result.posts)}
            report = sort_media(
                result.downloaded, classifier, sorted_dir,
                strategy=args.strategy, top_k=args.top_k, threshold=args.threshold,
                metadata_by_path=meta,
            )
            write_manifest(report, sorted_dir)
            write_csv(report, sorted_dir)
            summary["counts"] = report.counts
        return summary

    return list_collections, run_sync


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
        if args.command == "web":
            return _cmd_web(args, parser)
        if args.command == "categories":
            return _cmd_categories(args)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))

    parser.error("a subcommand is required (sort, sync, web, or categories)")
    return 2  # unreachable; parser.error exits


if __name__ == "__main__":
    raise SystemExit(main())
