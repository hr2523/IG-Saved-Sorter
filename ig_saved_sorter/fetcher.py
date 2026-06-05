"""Fetch saved posts from your own Instagram account via Instaloader.

This is an **opt-in** feature that logs in *as you* and reads your saved feed
through Instagram's private endpoints (there is no official API for saved
posts). Using it means automated access to your account, which is against
Instagram's Terms of Service and can trigger rate limiting or checkpoints.
Use it gently, on your own account, for personal organization only.

``instaloader`` is imported lazily so the rest of the package works without it.

The incremental sync core (:func:`sync_saved`) is decoupled from Instaloader via
a small fetcher protocol, so it can be unit tested with a fake fetcher.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Protocol, Set

from .metadata import SavedPost


class FetcherError(RuntimeError):
    """Raised for login/fetch problems (including missing dependency)."""


class SavedPostFetcher(Protocol):
    """Minimal interface the sync core needs from a fetcher backend."""

    def iter_saved(self): ...
    def download_post(self, post, media_dir: Path) -> Optional[Path]: ...
    def describe(self, post) -> SavedPost: ...


@dataclass
class FetchResult:
    downloaded: List[Path] = field(default_factory=list)
    posts: List[SavedPost] = field(default_factory=list)
    skipped: int = 0  # already-seen posts not re-downloaded

    @property
    def new_count(self) -> int:
        return len(self.downloaded)


# --------------------------------------------------------------------------- #
# Incremental sync state (set of already-processed shortcodes)
# --------------------------------------------------------------------------- #

def load_state(path: str | Path) -> Set[str]:
    path = Path(path)
    if not path.exists():
        return set()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return set()
    seen = data.get("seen", []) if isinstance(data, dict) else data
    return {str(s) for s in seen}


def save_state(path: str | Path, seen: Set[str]) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"seen": sorted(seen)}, indent=2), encoding="utf-8"
    )


def sync_saved(
    fetcher: SavedPostFetcher,
    media_dir: str | Path,
    state_path: str | Path,
    limit: Optional[int] = None,
    on_progress: Optional[Callable[[int, SavedPost], None]] = None,
) -> FetchResult:
    """Download saved posts that haven't been seen before.

    Tracks processed shortcodes in ``state_path`` so repeat runs only fetch new
    saves. Stops after ``limit`` new downloads if given. State is saved after
    each download so an interrupted run resumes cleanly.
    """
    media_dir = Path(media_dir)
    media_dir.mkdir(parents=True, exist_ok=True)
    seen = load_state(state_path)
    result = FetchResult()

    for post in fetcher.iter_saved():
        record = fetcher.describe(post)
        shortcode = record.shortcode
        if shortcode and shortcode in seen:
            result.skipped += 1
            continue

        path = fetcher.download_post(post, media_dir)
        if shortcode:
            seen.add(shortcode)
            save_state(state_path, seen)
        if path is not None:
            result.downloaded.append(Path(path))
        result.posts.append(record)

        if on_progress:
            on_progress(result.new_count, record)
        if limit is not None and result.new_count >= limit:
            break

    return result


# --------------------------------------------------------------------------- #
# Instaloader-backed fetcher
# --------------------------------------------------------------------------- #

class InstaloaderFetcher:
    """Fetch saved posts using Instaloader, logged in as the given user."""

    def __init__(self, quiet: bool = True) -> None:
        try:
            import instaloader  # noqa: F401
        except ImportError as exc:  # pragma: no cover - needs the optional dep
            raise FetcherError(
                "'instaloader' is required for sync. Install it with: "
                "pip install instaloader"
            ) from exc
        self._il = instaloader
        # Download just the media: no sidecar metadata/txt/thumbnails, and name
        # files by shortcode so they match the saved_posts shortcode matcher.
        self.L = instaloader.Instaloader(
            quiet=quiet,
            filename_pattern="{shortcode}",
            download_video_thumbnails=False,
            download_comments=False,
            save_metadata=False,
            compress_json=False,
            post_metadata_txt_pattern="",
        )
        self.username: Optional[str] = None

    def login(
        self,
        username: str,
        password: Optional[str] = None,
        session_file: Optional[str | Path] = None,
    ) -> None:
        """Log in, preferring a saved session file over a password."""
        self.username = username
        # 1) Try an existing session (no password needed, fewer challenges).
        try:
            if session_file:
                self.L.load_session_from_file(username, str(session_file))
            else:
                self.L.load_session_from_file(username)
            return
        except FileNotFoundError:
            pass
        except Exception as exc:  # corrupt/expired session -> fall through
            if not password:
                raise FetcherError(f"Could not load session: {exc}") from exc

        # 2) Fall back to a password login, then persist the session.
        if not password:
            raise FetcherError(
                "No saved session found and no password provided. "
                "Provide --password (or IG_PASSWORD), or run instaloader once "
                "to create a session file."
            )
        try:
            self.L.login(username, password)
            if session_file:
                self.L.save_session_to_file(str(session_file))
            else:
                self.L.save_session_to_file()
        except Exception as exc:
            raise FetcherError(f"Instagram login failed: {exc}") from exc

    def iter_saved(self):
        profile = self._il.Profile.own_profile(self.L.context)
        return profile.get_saved_posts()

    def describe(self, post) -> SavedPost:
        ts = None
        date = getattr(post, "date_utc", None)
        if date is not None:
            try:
                ts = int(date.timestamp())
            except Exception:
                ts = None
        return SavedPost(
            url=f"https://www.instagram.com/p/{post.shortcode}/",
            shortcode=post.shortcode,
            username=getattr(post, "owner_username", None),
            timestamp=ts,
        )

    def download_post(self, post, media_dir: Path) -> Optional[Path]:
        media_dir = Path(media_dir)
        # Constant dirname pattern -> everything lands directly in media_dir.
        self.L.dirname_pattern = str(media_dir)
        self.L.download_post(post, target=media_dir.name or "saved")
        matches = sorted(media_dir.glob(f"{post.shortcode}.*"))
        media = [m for m in matches if m.suffix.lower() != ".json"]
        return media[0] if media else None
