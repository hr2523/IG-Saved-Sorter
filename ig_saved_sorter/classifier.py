"""Local zero-shot image classification with CLIP (open_clip).

Heavy ML dependencies (``torch``, ``open_clip_torch``, ``Pillow``) are imported
lazily so the rest of the package — scanning, metadata parsing, reporting and
the test suite — works without them installed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

from .categories import expand_prompts
from .scanner import is_video

# A classification result: (category, confidence) pairs sorted high to low.
Prediction = List[Tuple[str, float]]


class MissingDependencyError(RuntimeError):
    """Raised when an optional ML dependency is not installed."""


def _require(module: str, hint: str):
    try:
        return __import__(module)
    except ImportError as exc:  # pragma: no cover - exercised only without deps
        raise MissingDependencyError(
            f"'{module}' is required for CLIP classification. {hint}"
        ) from exc


def extract_video_frame(path: Path):
    """Return a PIL image of a representative (middle) frame from a video.

    Requires ``opencv-python``. Returns ``None`` if the frame can't be read.
    """
    cv2 = _require("cv2", "Install it with: pip install opencv-python")
    from PIL import Image

    capture = cv2.VideoCapture(str(path))
    try:
        total = int(capture.get(cv2.CAP_PROP_FRAME_COUNT)) or 0
        if total > 0:
            capture.set(cv2.CAP_PROP_POS_FRAMES, total // 2)
        ok, frame = capture.read()
        if not ok or frame is None:
            return None
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        return Image.fromarray(rgb)
    finally:
        capture.release()


def load_image(path: Path):
    """Load any media path as a PIL RGB image (extracting a frame for videos)."""
    if is_video(path):
        return extract_video_frame(path)
    from PIL import Image

    with Image.open(path) as img:
        return img.convert("RGB")


class ClipClassifier:
    """Zero-shot topic classifier backed by an open_clip model."""

    def __init__(
        self,
        categories: Dict[str, List[str]],
        model_name: str = "ViT-B-32",
        pretrained: str = "laion2b_s34b_b79k",
        device: Optional[str] = None,
        templates: Optional[List[str]] = None,
    ) -> None:
        torch = _require("torch", "Install it with: pip install torch")
        open_clip = _require(
            "open_clip", "Install it with: pip install open_clip_torch"
        )

        self._torch = torch
        self.categories = list(categories.keys())
        if device is None:
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device

        self.model, _, self.preprocess = open_clip.create_model_and_transforms(
            model_name, pretrained=pretrained
        )
        self.model = self.model.to(device).eval()
        tokenizer = open_clip.get_tokenizer(model_name)
        self._tokenizer = tokenizer  # reused to embed captions at query time

        # Precompute one averaged, normalised text embedding per category.
        embeddings = []
        with torch.no_grad():
            for prompts in categories.values():
                phrases = expand_prompts(prompts, templates)
                tokens = tokenizer(phrases).to(device)
                feats = self.model.encode_text(tokens)
                feats = feats / feats.norm(dim=-1, keepdim=True)
                embeddings.append(feats.mean(dim=0))
        text_features = torch.stack(embeddings)
        self._text_features = text_features / text_features.norm(dim=-1, keepdim=True)

    def _image_similarity(self, image):
        """Return raw cosine similarities of an image to each category."""
        torch = self._torch
        with torch.no_grad():
            tensor = self.preprocess(image).unsqueeze(0).to(self.device)
            feats = self.model.encode_image(tensor)
            feats = feats / feats.norm(dim=-1, keepdim=True)
            return (feats @ self._text_features.T)[0]

    def _text_similarity(self, text: str):
        """Return raw cosine similarities of a caption to each category."""
        torch = self._torch
        with torch.no_grad():
            tokens = self._tokenizer([text]).to(self.device)
            feats = self.model.encode_text(tokens)
            feats = feats / feats.norm(dim=-1, keepdim=True)
            return (feats @ self._text_features.T)[0]

    def classify_pil(
        self,
        image,
        top_k: int = 1,
        threshold: float = 0.0,
        caption: Optional[str] = None,
        caption_weight: float = 0.55,
    ) -> Prediction:
        """Classify an image, optionally blending in the post caption.

        When a non-empty ``caption`` is given, the caption's similarity to each
        category is mixed with the image's (``caption_weight`` controls how much
        the text matters — captions are often the stronger signal for text-heavy
        or ambiguous posts). Scores are softmaxed into confidences.
        """
        torch = self._torch
        sim = self._image_similarity(image)
        caption = (caption or "").strip()
        if caption:
            # CLIP captions are capped at 77 tokens; a prefix is plenty.
            text_sim = self._text_similarity(caption[:300])
            sim = (1.0 - caption_weight) * sim + caption_weight * text_sim
        probs = (100.0 * sim).softmax(dim=-1).cpu().tolist()

        ranked = sorted(
            zip(self.categories, probs), key=lambda kv: kv[1], reverse=True
        )
        ranked = [(name, score) for name, score in ranked if score >= threshold]
        return ranked[: max(1, top_k)]

    def classify_path(
        self,
        path: Path,
        top_k: int = 1,
        threshold: float = 0.0,
        caption: Optional[str] = None,
        caption_weight: float = 0.55,
    ) -> Prediction:
        """Classify a media file path. Returns ``[]`` if it can't be read."""
        image = load_image(Path(path))
        if image is None:
            return []
        return self.classify_pil(
            image, top_k=top_k, threshold=threshold,
            caption=caption, caption_weight=caption_weight,
        )


def build_classifier(
    categories: Dict[str, List[str]],
    model_name: str = "ViT-B-32",
    pretrained: str = "laion2b_s34b_b79k",
    device: Optional[str] = None,
    templates: Optional[Sequence[str]] = None,
) -> ClipClassifier:
    """Convenience factory mirroring the CLI options."""
    return ClipClassifier(
        categories,
        model_name=model_name,
        pretrained=pretrained,
        device=device,
        templates=list(templates) if templates is not None else None,
    )
