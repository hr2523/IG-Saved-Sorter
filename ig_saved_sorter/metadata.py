"""Parsing of Instagram's "Download Your Information" saved-posts export.

The export ships ``saved_posts.json`` (older exports may call it
``saved_saved_media.json``) shaped roughly like::

    {
      "saved_saved_media": [
        {
          "title": "some_account",
          "string_map_data": {
            "Saved on": {
              "href": "https://www.instagram.com/p/Cabc123dEf/",
              "timestamp": 1609459200
            }
          }
        }
      ]
    }

We can't match these entries to local files by content, but Instagram media
downloaders commonly embed the post *shortcode* (the ``/p/<shortcode>/`` part
of the URL) in the downloaded filename. We use that to enrich classifications
with the source URL, username and save date when possible.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

# IG shortcodes are 11 characters of [A-Za-z0-9_-], embedded in /p/, /reel/ or
# /tv/ URLs.
_URL_SHORTCODE_RE = re.compile(r"/(?:p|reel|tv)/([A-Za-z0-9_-]+)")
# Shortcodes as they appear inside filenames are bounded by non-shortcode chars.
_FILENAME_SHORTCODE_RE = re.compile(r"(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])")


@dataclass
class SavedPost:
    """A single saved-post record from the Instagram export."""

    url: str
    shortcode: Optional[str]
    username: Optional[str]
    timestamp: Optional[int]
    caption: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "url": self.url,
            "shortcode": self.shortcode,
            "username": self.username,
            "timestamp": self.timestamp,
            "caption": self.caption,
        }


def extract_shortcode_from_url(url: str) -> Optional[str]:
    match = _URL_SHORTCODE_RE.search(url or "")
    return match.group(1) if match else None


def _iter_records(data: object):
    """Yield the list of saved-media records regardless of wrapper key."""
    if isinstance(data, list):
        yield from data
        return
    if isinstance(data, dict):
        for value in data.values():
            if isinstance(value, list):
                yield from value


def parse_saved_posts(path: str | Path) -> List[SavedPost]:
    """Parse an Instagram saved-posts export into :class:`SavedPost` records."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    posts: List[SavedPost] = []
    for record in _iter_records(data):
        if not isinstance(record, dict):
            continue
        username = record.get("title")
        smd = record.get("string_map_data") or {}
        # The inner key is usually "Saved on" but be lenient.
        entry = None
        if isinstance(smd, dict):
            entry = smd.get("Saved on") or next(
                (v for v in smd.values() if isinstance(v, dict)), None
            )
        if not isinstance(entry, dict):
            continue
        url = entry.get("href") or ""
        timestamp = entry.get("timestamp")
        posts.append(
            SavedPost(
                url=url,
                shortcode=extract_shortcode_from_url(url),
                username=username,
                timestamp=timestamp,
            )
        )
    return posts


def build_shortcode_index(posts: List[SavedPost]) -> Dict[str, SavedPost]:
    """Index saved posts by shortcode for quick filename matching."""
    return {p.shortcode: p for p in posts if p.shortcode}


def match_file_to_post(
    filename: str, index: Dict[str, SavedPost]
) -> Optional[SavedPost]:
    """Find the saved post whose shortcode appears in ``filename``.

    Prefers an exact 11-char token match (most downloaders), then falls back to
    a substring search for any known shortcode.
    """
    stem = Path(filename).stem
    for token in _FILENAME_SHORTCODE_RE.findall(stem):
        if token in index:
            return index[token]
    for shortcode, post in index.items():
        if shortcode in stem:
            return post
    return None
