"""Web app tests (Flask installed in dev/test env)."""

import json
from pathlib import Path

import pytest

flask = pytest.importorskip("flask")

from ig_saved_sorter.webapp import WebConfig, create_app


def _setup_sorted_dir(tmp_path):
    """Create a sorted dir with one categorized file + manifest."""
    sorted_dir = tmp_path / "sorted"
    (sorted_dir / "Food & Cooking").mkdir(parents=True)
    img = sorted_dir / "Food & Cooking" / "pizza.jpg"
    img.write_bytes(b"\xff\xd8\xff\xe0imgdata")  # pretend jpeg
    manifest = {
        "total": 1,
        "counts": {"Food & Cooking": 1},
        "items": [
            {
                "source": "/in/pizza.jpg",
                "category": "Food & Cooking",
                "confidence": 0.9,
                "predictions": [{"category": "Food & Cooking", "confidence": 0.9}],
                "destination": str(img),
                "post": {"url": "https://instagram.com/p/AAA/", "username": "chef",
                         "shortcode": "AAA", "timestamp": None},
                "error": None,
            }
        ],
    }
    (sorted_dir / "manifest.json").write_text(json.dumps(manifest))
    return sorted_dir


def _client(sorted_dir, **kw):
    app = create_app(WebConfig(sorted_dir=sorted_dir, **kw))
    app.config.update(TESTING=True)
    return app.test_client()


def test_index_serves_page(tmp_path):
    c = _client(_setup_sorted_dir(tmp_path))
    r = c.get("/")
    assert r.status_code == 200
    assert b"IG Saved Sorter" in r.data


def test_manifest_api(tmp_path):
    c = _client(_setup_sorted_dir(tmp_path))
    d = c.get("/api/manifest").get_json()
    assert len(d["items"]) == 1
    item = d["items"][0]
    assert item["category"] == "Food & Cooking"
    assert item["media_url"].startswith("/media/")
    assert item["is_video"] is False
    assert d["sync_enabled"] is False


def test_media_served_and_guarded(tmp_path):
    sorted_dir = _setup_sorted_dir(tmp_path)
    c = _client(sorted_dir)
    url = c.get("/api/manifest").get_json()["items"][0]["media_url"]
    assert c.get(url).status_code == 200
    # path traversal is blocked
    assert c.get("/media/../../etc/passwd").status_code == 404


def test_recategorize_moves_file_and_updates_manifest(tmp_path):
    sorted_dir = _setup_sorted_dir(tmp_path)
    c = _client(sorted_dir)
    item = c.get("/api/manifest").get_json()["items"][0]
    old_dest = item["destination"]

    r = c.post("/api/recategorize", json={"destination": old_dest, "category": "Travel & Places"})
    body = r.get_json()
    assert body["ok"] is True
    assert body["item"]["category"] == "Travel & Places"

    # File physically moved
    assert not Path(old_dest).exists()
    assert (sorted_dir / "Travel & Places" / "pizza.jpg").exists()
    # Manifest persisted
    data = json.loads((sorted_dir / "manifest.json").read_text())
    assert data["items"][0]["category"] == "Travel & Places"
    assert data["counts"] == {"Travel & Places": 1}


def test_recategorize_validation(tmp_path):
    c = _client(_setup_sorted_dir(tmp_path))
    assert c.post("/api/recategorize", json={"category": "X"}).status_code == 400
    assert c.post("/api/recategorize", json={"destination": "/nope.jpg", "category": "X"}).status_code == 404


def test_sync_endpoints_disabled_without_hooks(tmp_path):
    c = _client(_setup_sorted_dir(tmp_path))
    assert c.get("/api/collections").status_code == 400
    assert c.post("/api/sync", json={}).status_code == 400


def test_sync_endpoints_with_hooks(tmp_path):
    sorted_dir = _setup_sorted_dir(tmp_path)
    calls = {}

    def list_collections():
        return [("Recipes", 12), ("Travel", 3)]

    def run_sync(collection, limit):
        calls["args"] = (collection, limit)
        return {"new_count": 2, "skipped": 1}

    c = _client(sorted_dir, list_collections=list_collections, run_sync=run_sync)
    cols = c.get("/api/collections").get_json()["collections"]
    assert cols[0] == {"name": "Recipes", "count": 12}

    out = c.post("/api/sync", json={"collection": "Recipes", "limit": 5}).get_json()
    assert out["new_count"] == 2
    assert calls["args"] == ("Recipes", 5)

    assert c.get("/api/manifest").get_json()["sync_enabled"] is True
