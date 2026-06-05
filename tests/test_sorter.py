"""Sorter tests using a fake classifier (no torch/CLIP needed)."""

import json
from pathlib import Path

from ig_saved_sorter.categories import UNCATEGORIZED
from ig_saved_sorter.metadata import build_shortcode_index, parse_saved_posts
from ig_saved_sorter.sorter import sort_media, write_csv, write_manifest


class FakeClassifier:
    """Returns canned predictions keyed by a substring of the filename."""

    def __init__(self, rules):
        self.rules = rules  # list of (substring, [(cat, score), ...])

    def classify_path(self, path, top_k=1, threshold=0.0):
        name = Path(path).name
        for needle, preds in self.rules:
            if needle in name:
                return preds[:top_k]
        return [("Photography", 0.05)]


def _make_files(tmp_path, names):
    for n in names:
        (tmp_path / n).write_bytes(b"data")
    return tmp_path


def test_sort_copies_into_category_folders(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    src = _make_files(src, ["pizza.jpg", "guitar.jpg"])
    out = tmp_path / "out"

    clf = FakeClassifier([
        ("pizza", [("Food & Cooking", 0.9)]),
        ("guitar", [("Music & Concerts", 0.8)]),
    ])
    files = sorted(src.glob("*.jpg"))
    report = sort_media(files, clf, out, strategy="copy", threshold=0.15)

    assert (out / "Food & Cooking" / "pizza.jpg").exists()
    assert (out / "Music & Concerts" / "guitar.jpg").exists()
    # originals remain when copying
    assert (src / "pizza.jpg").exists()
    assert report.counts == {"Food & Cooking": 1, "Music & Concerts": 1}


def test_low_confidence_goes_uncategorized(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    (src / "blurry.jpg").write_bytes(b"data")
    out = tmp_path / "out"

    clf = FakeClassifier([("blurry", [("Photography", 0.05)])])
    report = sort_media(list(src.glob("*.jpg")), clf, out, threshold=0.15)

    assert (out / UNCATEGORIZED / "blurry.jpg").exists()
    assert report.items[0].category == UNCATEGORIZED


def test_dry_run_moves_nothing(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    (src / "pizza.jpg").write_bytes(b"data")
    out = tmp_path / "out"

    clf = FakeClassifier([("pizza", [("Food & Cooking", 0.9)])])
    report = sort_media(list(src.glob("*.jpg")), clf, out, dry_run=True)

    assert not out.exists()
    assert report.items[0].category == "Food & Cooking"
    assert report.items[0].destination is None


def test_move_strategy_removes_original(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    (src / "pizza.jpg").write_bytes(b"data")
    out = tmp_path / "out"

    clf = FakeClassifier([("pizza", [("Food & Cooking", 0.9)])])
    sort_media(list(src.glob("*.jpg")), clf, out, strategy="move")

    assert not (src / "pizza.jpg").exists()
    assert (out / "Food & Cooking" / "pizza.jpg").exists()


def test_name_collisions_are_resolved(tmp_path):
    src1 = tmp_path / "a"
    src2 = tmp_path / "b"
    src1.mkdir()
    src2.mkdir()
    (src1 / "pic.jpg").write_bytes(b"1")
    (src2 / "pic.jpg").write_bytes(b"2")
    out = tmp_path / "out"

    clf = FakeClassifier([("pic", [("Photography", 0.9)])])
    sort_media([src1 / "pic.jpg", src2 / "pic.jpg"], clf, out, threshold=0.1)

    files = sorted((out / "Photography").glob("*.jpg"))
    assert {f.name for f in files} == {"pic.jpg", "pic_1.jpg"}


def test_manifest_and_csv_written(tmp_path):
    src = tmp_path / "in"
    src.mkdir()
    (src / "pizza.jpg").write_bytes(b"data")
    out = tmp_path / "out"

    clf = FakeClassifier([("pizza", [("Food & Cooking", 0.9), ("Travel", 0.05)])])
    report = sort_media(list(src.glob("*.jpg")), clf, out, top_k=2, threshold=0.15)

    manifest = write_manifest(report, out)
    csv_path = write_csv(report, out)
    assert manifest.exists() and csv_path.exists()

    data = json.loads(manifest.read_text())
    assert data["total"] == 1
    assert data["items"][0]["category"] == "Food & Cooking"
    assert len(data["items"][0]["predictions"]) == 2


class CaptionAwareClassifier:
    """Classifier that uses the caption when provided (mimics CLIP blending)."""

    def __init__(self):
        self.seen_captions = []

    def classify_path(self, path, top_k=1, threshold=0.0, caption=None, caption_weight=0.5):
        self.seen_captions.append(caption)
        if caption and "artist" in caption.lower():
            return [("Visual Art & Illustration", 0.95)]
        return [("Memes & Humor", 0.6)]


def test_caption_is_passed_and_used(tmp_path):
    from ig_saved_sorter.metadata import SavedPost

    src = tmp_path / "in"
    src.mkdir()
    f = src / "AAA.jpg"
    f.write_bytes(b"data")
    out = tmp_path / "out"

    meta = {str(f): SavedPost(url="u", shortcode="AAA", username="x", timestamp=None,
                              caption="Through his mixed media assemblages, the artist explores...")}
    clf = CaptionAwareClassifier()
    report = sort_media([f], clf, out, metadata_by_path=meta, threshold=0.15)

    # Caption reached the classifier and steered the result away from "Memes".
    assert clf.seen_captions == ["Through his mixed media assemblages, the artist explores..."]
    assert report.items[0].category == "Visual Art & Illustration"


def test_classifier_without_caption_support_still_works(tmp_path):
    """A stub that doesn't accept caption kwargs is handled via TypeError fallback."""
    src = tmp_path / "in"
    src.mkdir()
    (src / "pizza.jpg").write_bytes(b"data")
    out = tmp_path / "out"

    clf = FakeClassifier([("pizza", [("Food & Cooking", 0.9)])])
    report = sort_media(list(src.glob("*.jpg")), clf, out, threshold=0.15)
    assert report.items[0].category == "Food & Cooking"


def test_export_enrichment(tmp_path):
    export = tmp_path / "saved_posts.json"
    export.write_text(json.dumps({
        "saved_saved_media": [
            {
                "title": "chef",
                "string_map_data": {
                    "Saved on": {
                        "href": "https://www.instagram.com/p/Cabc123dEf0/",
                        "timestamp": 1609459200,
                    }
                },
            }
        ]
    }))
    index = build_shortcode_index(parse_saved_posts(export))

    src = tmp_path / "in"
    src.mkdir()
    (src / "Cabc123dEf0.jpg").write_bytes(b"data")
    out = tmp_path / "out"

    clf = FakeClassifier([("Cabc", [("Food & Cooking", 0.9)])])
    report = sort_media(
        list(src.glob("*.jpg")), clf, out, shortcode_index=index, threshold=0.15
    )
    assert report.items[0].post is not None
    assert report.items[0].post.username == "chef"
