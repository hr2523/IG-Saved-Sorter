import json

from ig_saved_sorter.metadata import (
    build_shortcode_index,
    extract_shortcode_from_url,
    match_file_to_post,
    parse_saved_posts,
)

SAMPLE = {
    "saved_saved_media": [
        {
            "title": "chef_account",
            "string_map_data": {
                "Saved on": {
                    "href": "https://www.instagram.com/p/Cabc123dEf0/",
                    "timestamp": 1609459200,
                }
            },
        },
        {
            "title": "art_account",
            "string_map_data": {
                "Saved on": {
                    "href": "https://www.instagram.com/reel/Xyz987wQrs1/",
                    "timestamp": 1612137600,
                }
            },
        },
    ]
}


def test_extract_shortcode_from_url():
    assert extract_shortcode_from_url("https://instagram.com/p/Cabc123dEf0/") == "Cabc123dEf0"
    assert extract_shortcode_from_url("https://instagram.com/reel/Xyz987wQrs1") == "Xyz987wQrs1"
    assert extract_shortcode_from_url("https://example.com/nope") is None


def test_parse_saved_posts(tmp_path):
    path = tmp_path / "saved_posts.json"
    path.write_text(json.dumps(SAMPLE), encoding="utf-8")

    posts = parse_saved_posts(path)
    assert len(posts) == 2
    assert posts[0].username == "chef_account"
    assert posts[0].shortcode == "Cabc123dEf0"
    assert posts[1].timestamp == 1612137600


def test_match_file_to_post(tmp_path):
    path = tmp_path / "saved_posts.json"
    path.write_text(json.dumps(SAMPLE), encoding="utf-8")
    index = build_shortcode_index(parse_saved_posts(path))

    matched = match_file_to_post("2021-01-01_Cabc123dEf0.jpg", index)
    assert matched is not None and matched.username == "chef_account"

    assert match_file_to_post("random_photo.jpg", index) is None
