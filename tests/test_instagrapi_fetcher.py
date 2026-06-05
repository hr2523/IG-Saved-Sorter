"""Unit tests for InstagrapiFetcher logic using a fake instagrapi Client.

We can't install/log into Instagram here, so we construct the fetcher and swap
in a fake `cl` to exercise collection selection, describe(), and download_post()
without the real dependency.
"""

from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from ig_saved_sorter.fetcher import FetcherError


def _make_fetcher():
    """Build an InstagrapiFetcher without importing instagrapi."""
    from ig_saved_sorter import fetcher as fmod

    f = fmod.InstagrapiFetcher.__new__(fmod.InstagrapiFetcher)
    f._exceptions = None
    f.username = "me"
    f._collection_pk = None
    f._collection_name = None
    f.cl = None
    return f


class FakeMedia:
    def __init__(self, code, pk, username="poster", media_type=1, product_type=""):
        self.code = code
        self.pk = pk
        self.user = SimpleNamespace(username=username)
        self.media_type = media_type
        self.product_type = product_type
        self.taken_at = datetime(2021, 1, 1, tzinfo=timezone.utc)


class FakeClient:
    def __init__(self, collections=None, medias=None):
        self._collections = collections or []
        self._medias = medias or []
        self.calls = []

    def collections(self):
        return self._collections

    def collection_medias(self, pk, amount=0):
        self.calls.append(("collection_medias", pk, amount))
        return self._medias

    def collection_medias_by_name(self, name, amount=0):
        self.calls.append(("by_name", name, amount))
        return self._medias

    def photo_download(self, pk, folder):
        p = Path(folder) / f"ig_{pk}.jpg"
        p.write_bytes(b"img")
        return p

    def video_download(self, pk, folder):
        p = Path(folder) / f"ig_{pk}.mp4"
        p.write_bytes(b"vid")
        return p


def test_select_collection_all_saved():
    f = _make_fetcher()
    f.cl = FakeClient()
    f.select_collection(None)
    assert f._collection_pk is None
    f.select_collection("All Posts")
    assert f._collection_pk is None


def test_select_collection_by_name():
    f = _make_fetcher()
    f.cl = FakeClient(collections=[SimpleNamespace(name="Recipes", pk="123", media_count=4)])
    f.select_collection("recipes")  # case-insensitive
    assert f._collection_pk == "123"


def test_select_collection_not_found():
    f = _make_fetcher()
    f.cl = FakeClient(collections=[SimpleNamespace(name="Recipes", pk="123", media_count=4)])
    with pytest.raises(FetcherError) as exc:
        f.select_collection("Nope")
    assert "not found" in str(exc.value).lower()


def test_iter_saved_uses_pk_when_selected():
    f = _make_fetcher()
    cl = FakeClient(collections=[SimpleNamespace(name="Recipes", pk="123", media_count=4)],
                    medias=[FakeMedia("AAA", 1)])
    f.cl = cl
    f.select_collection("Recipes")
    list(f.iter_saved())
    assert ("collection_medias", "123", 999) in cl.calls


def test_describe_builds_savedpost():
    f = _make_fetcher()
    post = f.describe(FakeMedia("AAA", 1, username="chef"))
    assert post.shortcode == "AAA"
    assert post.username == "chef"
    assert post.url.endswith("/p/AAA/")
    assert post.timestamp == int(datetime(2021, 1, 1, tzinfo=timezone.utc).timestamp())


def test_download_post_renames_to_shortcode(tmp_path):
    f = _make_fetcher()
    f.cl = FakeClient()
    path = f.download_post(FakeMedia("Cabc123", 99, media_type=1), tmp_path)
    assert path.name == "Cabc123.jpg"
    assert path.exists()


def test_download_video(tmp_path):
    f = _make_fetcher()
    f.cl = FakeClient()
    path = f.download_post(FakeMedia("Vid42", 7, media_type=2), tmp_path)
    assert path.name == "Vid42.mp4"
