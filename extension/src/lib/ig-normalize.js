// Pure normalization helpers for Instagram feed responses. Kept separate from
// the fetching so the fragile network shape and the parsing are both easy to
// adjust when Instagram changes things.

function extractMedia(item) {
  return item && item.media ? item.media : item;
}

function bestThumbnailUrl(media) {
  const cands =
    (media.image_versions2 && media.image_versions2.candidates) ||
    (media.carousel_media &&
      media.carousel_media[0] &&
      media.carousel_media[0].image_versions2 &&
      media.carousel_media[0].image_versions2.candidates) ||
    [];
  if (!cands.length) return null;
  const sorted = [...cands].sort((a, b) => (a.width || 0) - (b.width || 0));
  const pick = sorted.find((c) => (c.width || 0) >= 240) || sorted[0];
  return pick ? pick.url : null;
}

export function normalizeMedia(media) {
  if (!media) return null;
  const code = media.code || media.shortcode || null;
  const captionObj = media.caption;
  const caption =
    (captionObj && (captionObj.text || captionObj)) ||
    media.accessibility_caption ||
    "";
  return {
    id: String(media.pk || media.id || code),
    code,
    caption: typeof caption === "string" ? caption : "",
    thumbnailUrl: bestThumbnailUrl(media),
    permalink: code ? `https://www.instagram.com/p/${code}/` : null,
    takenAt: media.taken_at || null,
    status: "pending",
    category: null,
    confidence: 0,
    manualOverride: false,
  };
}

// A saved/collection feed page -> normalized items + pagination cursor.
export function normalizePage(json) {
  const items = (json.items || json.medias || []).map((it) => normalizeMedia(extractMedia(it))).filter(Boolean);
  return {
    items,
    nextMaxId: json.next_max_id || null,
    moreAvailable: Boolean(json.more_available),
  };
}

export function normalizeCollections(json) {
  const raw = json.items || json.collections || [];
  return raw.map((c) => ({
    pk: String(c.collection_id || c.id || c.collection_pk || ""),
    name: c.collection_name || c.name || "",
    count:
      (c.collection_media_count != null && c.collection_media_count) ||
      (c.media_count != null && c.media_count) ||
      0,
    type: c.collection_type || "",
  }));
}
