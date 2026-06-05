"""Tests for the incremental sync core using a fake fetcher (no instaloader)."""

from pathlib import Path

from ig_saved_sorter.fetcher import (
    FetchResult,
    load_state,
    save_state,
    sync_saved,
)
from ig_saved_sorter.metadata import SavedPost


class FakePost:
    def __init__(self, shortcode, username="someone"):
        self.shortcode = shortcode
        self.username = username


class FakeFetcher:
    """Yields canned posts and 'downloads' by writing an empty file."""

    def __init__(self, shortcodes):
        self.posts = [FakePost(sc) for sc in shortcodes]
        self.downloaded = []

    def iter_saved(self):
        return iter(self.posts)

    def describe(self, post) -> SavedPost:
        return SavedPost(
            url=f"https://www.instagram.com/p/{post.shortcode}/",
            shortcode=post.shortcode,
            username=post.username,
            timestamp=None,
        )

    def download_post(self, post, media_dir: Path):
        path = Path(media_dir) / f"{post.shortcode}.jpg"
        path.write_bytes(b"img")
        self.downloaded.append(post.shortcode)
        return path


def test_state_roundtrip(tmp_path):
    state = tmp_path / "state.json"
    assert load_state(state) == set()
    save_state(state, {"a", "b"})
    assert load_state(state) == {"a", "b"}


def test_sync_downloads_all_when_fresh(tmp_path):
    fetcher = FakeFetcher(["AAA", "BBB", "CCC"])
    result = sync_saved(fetcher, tmp_path / "media", tmp_path / "state.json")

    assert isinstance(result, FetchResult)
    assert result.new_count == 3
    assert result.skipped == 0
    assert {p.name for p in result.downloaded} == {"AAA.jpg", "BBB.jpg", "CCC.jpg"}
    # State now remembers everything.
    assert load_state(tmp_path / "state.json") == {"AAA", "BBB", "CCC"}


def test_sync_is_incremental(tmp_path):
    state = tmp_path / "state.json"
    media = tmp_path / "media"
    sync_saved(FakeFetcher(["AAA", "BBB"]), media, state)

    # Second run: one old + one new -> only the new one is downloaded.
    fetcher = FakeFetcher(["AAA", "DDD"])
    result = sync_saved(fetcher, media, state)
    assert fetcher.downloaded == ["DDD"]
    assert result.new_count == 1
    assert result.skipped == 1
    assert load_state(state) == {"AAA", "BBB", "DDD"}


def test_sync_respects_limit(tmp_path):
    fetcher = FakeFetcher(["A", "B", "C", "D"])
    result = sync_saved(fetcher, tmp_path / "m", tmp_path / "s.json", limit=2)
    assert result.new_count == 2
    assert fetcher.downloaded == ["A", "B"]


def test_sync_records_post_metadata(tmp_path):
    fetcher = FakeFetcher(["AAA"])
    result = sync_saved(fetcher, tmp_path / "m", tmp_path / "s.json")
    assert result.posts[0].username == "someone"
    assert result.posts[0].url.endswith("/p/AAA/")
