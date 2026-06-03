import json

import pytest

from ig_saved_sorter.categories import (
    DEFAULT_CATEGORIES,
    expand_prompts,
    load_categories,
)


def test_default_categories_loaded():
    cats = load_categories(None)
    assert cats == DEFAULT_CATEGORIES
    assert "Food & Cooking" in cats


def test_load_categories_from_file(tmp_path):
    path = tmp_path / "cats.json"
    path.write_text(json.dumps({"Food": ["a plate of food"], "Art": "an artwork"}))
    cats = load_categories(path)
    assert cats["Food"] == ["a plate of food"]
    # string prompt is normalised to a list
    assert cats["Art"] == ["an artwork"]


def test_load_categories_rejects_empty(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({}))
    with pytest.raises(ValueError):
        load_categories(path)


def test_expand_prompts_uses_templates():
    out = expand_prompts(["food"], templates=["{}", "a photo of {}"])
    assert out == ["food", "a photo of food"]
