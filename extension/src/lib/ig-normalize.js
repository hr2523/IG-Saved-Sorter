// Pure normalization helpers for Instagram feed responses. Kept separate from
// the fetching so the fragile network shape and the parsing are both easy to
// adjust when Instagram changes things.

function extractMedia(item) {
  if (!item) return null;
  // REST saved feed wraps as {media:{...}}; GraphQL wraps as {node:{...}}.
  return item.media || item.node || item;
}

function shortcodeFromUrl(url) {
  const m = String(url || "").match(/\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

function bestThumbnailUrl(media) {
  const cands =
    (media.image_versions2 && media.image_versions2.candidates) ||
    (media.carousel_media &&
      media.carousel_media[0] &&
      media.carousel_media[0].image_versions2 &&
      media.carousel_media[0].image_versions2.candidates) ||
    [];
  if (cands.length) {
    const sorted = [...cands].sort((a, b) => (a.width || 0) - (b.width || 0));
    const pick = sorted.find((c) => (c.width || 0) >= 240) || sorted[0];
    if (pick) return pick.url;
  }
  // GraphQL shapes
  return media.thumbnail_src || media.display_url || media.thumbnail_url || null;
}

export function normalizeMedia(media) {
  if (!media) return null;
  const code = media.code || media.shortcode || (media.link && shortcodeFromUrl(media.link)) || null;
  const captionObj = media.caption;
  const caption =
    (captionObj && (captionObj.text || captionObj.edges?.[0]?.node?.text || (typeof captionObj === "string" ? captionObj : ""))) ||
    media.edge_media_to_caption?.edges?.[0]?.node?.text ||
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

// Deep-search a GraphQL response for the saved-media connection, if present.
function findEdges(json) {
  const conn =
    json?.data?.user?.edge_saved_media ||
    json?.data?.xdt_api__v1__feed__saved__posts_connection ||
    json?.data?.saved_posts;
  if (conn && Array.isArray(conn.edges)) return conn;
  return null;
}

// A saved/collection feed page -> normalized items + pagination cursor.
export function normalizePage(json) {
  // REST shape
  let rawItems = json.items || json.medias || null;
  let nextMaxId = json.next_max_id || null;
  let moreAvailable = Boolean(json.more_available);

  // GraphQL shape (edges + page_info) as a fallback
  if (!rawItems) {
    const conn = findEdges(json);
    if (conn) {
      rawItems = conn.edges;
      nextMaxId = conn.page_info?.end_cursor || null;
      moreAvailable = Boolean(conn.page_info?.has_next_page);
    }
  }

  const items = (rawItems || []).map((it) => normalizeMedia(extractMedia(it))).filter(Boolean);
  return { items, nextMaxId, moreAvailable };
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
