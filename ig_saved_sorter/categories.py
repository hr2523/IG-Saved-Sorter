"""Topic categories and their CLIP text prompts.

Each category maps to a list of natural-language phrases that describe the kind
of content that belongs in it. CLIP scores an image against every phrase; the
phrase scores are averaged per category to decide where the image belongs.

You can override these with a JSON file (see ``load_categories``) shaped like::

    {
      "Food & Cooking": ["a photo of food", "a plate of a delicious meal"],
      "Travel & Places": ["a travel photo of a famous place"]
    }
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, List

# Prompt templates used for ensembling. Each category phrase is also wrapped in
# these templates to make CLIP's zero-shot scoring more robust.
PROMPT_TEMPLATES: List[str] = [
    "{}",
    "a photo of {}",
    "an instagram post about {}",
    "a picture showing {}",
]

# Default IG-oriented topic taxonomy. Keys are the folder names that will be
# created; values are descriptive phrases fed to CLIP.
DEFAULT_CATEGORIES: Dict[str, List[str]] = {
    "Visual Art & Illustration": [
        "a painting or drawing",
        "digital art or an illustration",
        "an artwork on a gallery wall",
        "a sketch or graphic design",
    ],
    "Photography": [
        "an artistic photograph",
        "a striking photography shot",
        "a black and white photograph",
    ],
    "Food & Cooking": [
        "a plate of food",
        "a delicious meal or dish",
        "a recipe or cooking photo",
        "dessert or baked goods",
    ],
    "Travel & Places": [
        "a travel photo of a famous place",
        "a scenic landscape or destination",
        "a city street or landmark",
    ],
    "Nature & Animals": [
        "a nature landscape",
        "a wild animal or pet",
        "plants, flowers or wildlife",
    ],
    "Architecture & Interiors": [
        "a building or architecture",
        "interior design of a room",
        "home decor and furniture",
    ],
    "Fashion & Style": [
        "a fashion outfit",
        "clothing and street style",
        "a model wearing stylish clothes",
    ],
    "Beauty & Makeup": [
        "makeup and cosmetics",
        "a beauty or skincare photo",
        "hairstyle and grooming",
    ],
    "Fitness & Sports": [
        "a workout or exercise",
        "a sports activity or athlete",
        "gym and fitness training",
    ],
    "Music & Concerts": [
        "a musician or band performing",
        "a concert or live music",
        "musical instruments",
    ],
    "Technology & Gadgets": [
        "a computer, phone or gadget",
        "technology and electronics",
        "a software or coding screenshot",
    ],
    "Cars & Vehicles": [
        "a car or motorcycle",
        "an automobile or vehicle",
    ],
    "Memes & Humor": [
        "a funny meme",
        "a humorous image with text overlay",
    ],
    "Quotes & Text": [
        "an inspirational quote on a plain background",
        "a graphic that is mostly text",
        "a screenshot of text or a tweet",
    ],
    "People & Portraits": [
        "a portrait of a person",
        "a selfie or photo of people",
    ],
    "DIY & Crafts": [
        "a do-it-yourself craft project",
        "handmade crafts and tutorials",
    ],
    "Business & Career": [
        "business, finance or investing",
        "a job, hiring or career opportunity post",
        "an advertisement or marketing promotion",
        "entrepreneurship, startups and productivity advice",
    ],
    "Graphic Design & Typography": [
        "graphic design and typography",
        "a poster, logo or branding design",
        "lettering, fonts and type design",
    ],
    "Books & Education": [
        "books or reading",
        "an educational infographic or study notes",
    ],
}

# Folder used when nothing scores above the confidence threshold.
UNCATEGORIZED = "Uncategorized"


def load_categories(path: str | Path | None) -> Dict[str, List[str]]:
    """Return the category->prompts mapping, optionally loaded from JSON.

    Falls back to :data:`DEFAULT_CATEGORIES` when ``path`` is ``None``.
    """
    if path is None:
        return dict(DEFAULT_CATEGORIES)

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not data:
        raise ValueError("Categories file must be a non-empty JSON object")

    categories: Dict[str, List[str]] = {}
    for name, prompts in data.items():
        if isinstance(prompts, str):
            prompts = [prompts]
        if not isinstance(prompts, list) or not prompts:
            raise ValueError(f"Category '{name}' must map to a non-empty list of prompts")
        categories[str(name)] = [str(p) for p in prompts]
    return categories


def expand_prompts(prompts: List[str], templates: List[str] | None = None) -> List[str]:
    """Apply prompt templates to each phrase for ensembling."""
    templates = templates if templates is not None else PROMPT_TEMPLATES
    expanded: List[str] = []
    for phrase in prompts:
        for template in templates:
            expanded.append(template.format(phrase))
    return expanded
