"""Fetch saved posts (and specific Collections) from your own Instagram account.

This is an **opt-in** feature that logs in *as you* and reads your saved feed
through Instagram's private API (there is no official API for saved posts).
Using it means automated access to your account, which is against Instagram's
Terms of Service and can trigger rate limiting or login challenges. Use it
gently, on your own account, for personal organization only.

Backend: `instagrapi`, imported lazily so the rest of the package works without
it. instagrapi has first-class support for saved Collections, so you can fetch a
single collection by name instead of every saved post.

The incremental sync core (:func:`sync_saved`) is decoupled from instagrapi via a
small fetcher protocol, so it can be unit tested with a fake fetcher.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, List, Optional, Protocol, Set, Tuple

from .metadata import SavedPost


class FetcherError(RuntimeError):
    """Raised for login/fetch problems (including a missing dependency)."""


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
    path.write_text(json.dumps({"seen": sorted(seen)}, indent=2), encoding="utf-8")


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
# instagrapi-backed fetcher (with Collections support)
# --------------------------------------------------------------------------- #

# Auto-collection that contains every saved post (instagrapi/Instagram naming).
_ALL_SAVED = "ALL_MEDIA_AUTO_COLLECTION"


class InstagrapiFetcher:
    """Fetch saved posts / a named Collection using instagrapi."""

    def __init__(self, delay_range: Optional[Tuple[int, int]] = (1, 3),
                 thumbnails_only: bool = True) -> None:
        try:
            from instagrapi import Client
        except ImportError as exc:  # pragma: no cover - needs the optional dep
            raise FetcherError(
                "'instagrapi' is required for sync. Install it with: "
                "pip install instagrapi"
            ) from exc
        try:
            import instagrapi.exceptions as _exc
        except Exception:  # pragma: no cover
            _exc = None
        self._exceptions = _exc
        self.cl = Client()
        # Gentle, human-like pacing between private API calls.
        if delay_range:
            self.cl.delay_range = list(delay_range)
        self.username: Optional[str] = None
        self._collection_pk: Optional[str] = None
        self._collection_name: Optional[str] = None
        # When True, download only the small cover thumbnail (no full media).
        self.thumbnails_only = thumbnails_only

    # -- auth ----------------------------------------------------------------
    def login(
        self,
        username: str,
        password: Optional[str] = None,
        session_file: Optional[str | Path] = None,
        sessionid: Optional[str] = None,
        two_factor_callback: Optional[Callable[[], str]] = None,
        challenge_callback: Optional[Callable[[str], str]] = None,
    ) -> None:
        """Log in, preferring a browser sessionid, then a saved session file,
        then a password.

        ``sessionid`` is the cookie from a browser where you're already logged
        in; using it skips the password / 2FA / login-challenge flow entirely.
        Handles two-factor auth (``two_factor_callback`` supplies the one-time
        code) and login challenges (``challenge_callback`` supplies the
        emailed/texted code).
        """
        self.username = username
        if challenge_callback is not None:
            self.cl.challenge_code_handler = lambda u, choice: challenge_callback(str(choice))

        # 0) A browser sessionid bypasses the whole login flow.
        if sessionid:
            sid = sessionid.strip().strip('"').strip("'")
            try:
                self.cl.login_by_sessionid(sid)
                self.cl.get_timeline_feed()  # validate
            except Exception as exc:
                raise FetcherError(
                    f"Login by sessionid failed: {exc}\n"
                    "  Fixes, in order:\n"
                    "  1) Update instagrapi:  pip install -U instagrapi\n"
                    "  2) Copy a FRESH, COMPLETE sessionid from a browser that is "
                    "currently logged into instagram.com (right-click the cookie "
                    "row -> Copy value; don't truncate).\n"
                    "  3) Make sure you didn't include surrounding quotes/spaces."
                ) from exc
            if session_file:
                try:
                    self.cl.dump_settings(str(session_file))
                except Exception:
                    pass
            return

        # 1) Reuse a saved session if present.
        if session_file and Path(session_file).exists():
            try:
                self.cl.load_settings(str(session_file))
                self.cl.login(username, password or "")
                self.cl.get_timeline_feed()  # validate the session is alive
                return
            except Exception:
                pass  # fall through to a fresh password login

        # 2) Fresh login with password (+ 2FA if required).
        if not password:
            raise FetcherError(
                "No sessionid, no valid saved session, and no password provided. "
                "Provide --sessionid (recommended), --password, or IG_PASSWORD."
            )
        two_factor_exc = getattr(self._exceptions, "TwoFactorRequired", None) if self._exceptions else None
        try:
            try:
                self.cl.login(username, password)
            except Exception as exc:
                if two_factor_exc is not None and isinstance(exc, two_factor_exc):
                    if two_factor_callback is None:
                        raise FetcherError(
                            "Two-factor authentication is required. Re-run "
                            "interactively so you can enter the code."
                        ) from exc
                    code = (two_factor_callback() or "").strip()
                    self.cl.login(username, password, verification_code=code)
                else:
                    raise
        except FetcherError:
            raise
        except Exception as exc:
            raise FetcherError(f"Instagram login failed: {exc}") from exc

        if session_file:
            try:
                self.cl.dump_settings(str(session_file))
            except Exception:
                pass

    # -- collections ---------------------------------------------------------
    def list_collections(self) -> List[Tuple[str, int]]:
        """Return ``[(name, media_count), ...]`` for your saved Collections."""
        out: List[Tuple[str, int]] = []
        for c in self.cl.collections():
            out.append((getattr(c, "name", "?"), int(getattr(c, "media_count", 0) or 0)))
        return out

    _ALL_NAMES = {"", "all", "all posts", "all saved"}

    def select_collection(self, name: Optional[str]) -> None:
        """Choose which collection :meth:`iter_saved` returns.

        ``None`` (or "All Posts") means every saved post. A user collection name
        is validated against your actual collections so you get a helpful error.
        """
        if not name or name.strip().lower() in self._ALL_NAMES:
            self._collection_name = None
            self._collection_pk = None
            return
        wanted = name.strip().lower()
        for c in self.cl.collections():
            if str(getattr(c, "name", "")).strip().lower() == wanted:
                self._collection_name = getattr(c, "name", name)
                self._collection_pk = str(getattr(c, "pk", "") or "") or None
                return
        available = ", ".join(n for n, _ in self.list_collections()) or "(none)"
        raise FetcherError(f"Collection '{name}' not found. Available: {available}")

    # -- fetching ------------------------------------------------------------
    @staticmethod
    def _call_medias(fn, key, amount):
        """Call an instagrapi medias method tolerant of signature differences.

        Across instagrapi versions the ``amount`` parameter may be keyword,
        positional, or absent — try each before letting the error surface.
        """
        for attempt in (
            lambda: fn(key, amount=amount),
            lambda: fn(key, amount),
            lambda: fn(key),
        ):
            try:
                return attempt()
            except TypeError:
                continue
        return fn(key)

    def iter_saved(self):
        # amount=0 is meant to return everything but is buggy for saved
        # collections; a large amount fetches all in practice (instagrapi #250).
        amount = 999
        if self._collection_pk is not None:
            return self._call_medias(self.cl.collection_medias, self._collection_pk, amount)
        # All saved posts: the ALL_MEDIA_AUTO_COLLECTION constant is the
        # documented route; the literal name "All Posts" raises CollectionNotFound
        # on many versions, so only fall back to it if the constant route fails.
        try:
            return self._call_medias(self.cl.collection_medias, _ALL_SAVED, amount)
        except Exception:
            by_name = getattr(self.cl, "collection_medias_by_name", None)
            if by_name is None:
                raise
            return self._call_medias(by_name, "All Posts", amount)

    def describe(self, media) -> SavedPost:
        ts = None
        taken = getattr(media, "taken_at", None)
        if taken is not None:
            try:
                ts = int(taken.timestamp())
            except Exception:
                ts = None
        user = getattr(media, "user", None)
        caption = getattr(media, "caption_text", None)
        return SavedPost(
            url=f"https://www.instagram.com/p/{media.code}/",
            shortcode=getattr(media, "code", None),
            username=getattr(user, "username", None) if user else None,
            timestamp=ts,
            caption=caption or None,
        )

    def _thumbnail_url(self, media) -> Optional[str]:
        url = str(getattr(media, "thumbnail_url", "") or "")
        if not url:
            resources = getattr(media, "resources", None) or []
            if resources:
                url = str(getattr(resources[0], "thumbnail_url", "") or "")
        return url or None

    def download_thumbnail(self, media, media_dir: Path) -> Optional[Path]:
        """Download just the small cover thumbnail (~tens of KB), no full media."""
        import requests

        url = self._thumbnail_url(media)
        code = getattr(media, "code", None) or getattr(media, "pk", "item")
        if not url:
            return None
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
        except Exception as exc:
            raise FetcherError(f"Failed to fetch thumbnail for {code}: {exc}") from exc
        target = Path(media_dir) / f"{code}.jpg"
        target.write_bytes(resp.content)
        return target

    def download_post(self, media, media_dir: Path) -> Optional[Path]:
        media_dir = Path(media_dir)
        media_dir.mkdir(parents=True, exist_ok=True)
        if self.thumbnails_only:
            return self.download_thumbnail(media, media_dir)
        pk = media.pk
        media_type = getattr(media, "media_type", 1)
        product = getattr(media, "product_type", "") or ""
        try:
            if media_type == 2 and product == "igtv":
                path = self.cl.igtv_download(pk, folder=media_dir)
            elif media_type == 2 and product == "clips":
                path = self.cl.clip_download(pk, folder=media_dir)
            elif media_type == 2:
                path = self.cl.video_download(pk, folder=media_dir)
            elif media_type == 8:
                paths = self.cl.album_download(pk, folder=media_dir)
                path = paths[0] if paths else None
            else:
                path = self.cl.photo_download(pk, folder=media_dir)
        except Exception as exc:
            raise FetcherError(f"Failed to download {getattr(media, 'code', pk)}: {exc}") from exc

        if path is None:
            return None
        # Rename to a predictable, shortcode-based filename.
        path = Path(path)
        code = getattr(media, "code", None)
        if code:
            target = media_dir / f"{code}{path.suffix}"
            if path != target:
                try:
                    path.replace(target)
                    path = target
                except OSError:
                    pass
        return path
