// Content script — runs in the instagram.com page context, so same-origin
// fetches automatically carry the user's logged-in cookies. This is the ONLY
// file that talks to Instagram's private web API. If Instagram changes the
// endpoints, this is the one file to update (capture the real request from
// DevTools -> Network on your Saved page and adjust FETCH_ENDPOINTS below).
//
// Classic content script (no ES modules): communicates via chrome.runtime.

(() => {
  "use strict";

  const IG_APP_ID = "936619743392459"; // the public web app id IG uses
  const API = "https://www.instagram.com/api/v1";

  // --- endpoint adapter (the fragile surface) -----------------------------
  const FETCH_ENDPOINTS = {
    collectionsList: () =>
      `${API}/collections/list/?collection_types=` +
      encodeURIComponent('["ALL_MEDIA_AUTO_COLLECTION","MEDIA"]'),
    savedAll: (maxId) =>
      `${API}/feed/saved/posts/` + (maxId ? `?max_id=${encodeURIComponent(maxId)}` : ""),
    collection: (pk, maxId) =>
      `${API}/feed/collection/${encodeURIComponent(pk)}/` +
      (maxId ? `?max_id=${encodeURIComponent(maxId)}` : ""),
  };

  function getCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  function headers() {
    const h = {
      "x-ig-app-id": IG_APP_ID,
      "x-requested-with": "XMLHttpRequest",
      "x-csrftoken": getCookie("csrftoken"),
    };
    try {
      const claim = window.sessionStorage.getItem("www-claim-v2");
      if (claim) h["x-ig-www-claim"] = claim;
    } catch (_) {}
    return h;
  }

  async function apiGet(url) {
    const res = await fetch(url, {
      method: "GET",
      credentials: "include",
      headers: headers(),
    });
    if (!res.ok) {
      throw new Error(
        `Instagram request failed: ${res.status} ${res.statusText} (${url}). ` +
          `The endpoint may have changed — capture the real request in DevTools.`
      );
    }
    return res.json();
  }

  // --- normalization ------------------------------------------------------
  // Pull one usable media object out of a feed "item" (handles the
  // {media:{...}} wrapper and bare media). Returns null if unusable.
  function extractMedia(item) {
    return item && item.media ? item.media : item;
  }

  function bestThumbnailUrl(media) {
    // image_versions2.candidates is largest-first; take a mid/small one.
    const cands =
      (media.image_versions2 && media.image_versions2.candidates) ||
      (media.carousel_media &&
        media.carousel_media[0] &&
        media.carousel_media[0].image_versions2 &&
        media.carousel_media[0].image_versions2.candidates) ||
      [];
    if (!cands.length) return null;
    // choose the smallest candidate >= 240px wide, else the smallest.
    const sorted = [...cands].sort((a, b) => (a.width || 0) - (b.width || 0));
    const pick = sorted.find((c) => (c.width || 0) >= 240) || sorted[0];
    return pick ? pick.url : null;
  }

  function normalize(media) {
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

  function pageItems(json) {
    // saved/collection feeds return { items: [...], more_available, next_max_id }
    const items = json.items || json.medias || [];
    return items.map((it) => normalize(extractMedia(it))).filter(Boolean);
  }

  // --- message handlers ---------------------------------------------------
  async function handleFetchCollections() {
    const json = await apiGet(FETCH_ENDPOINTS.collectionsList());
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

  async function handleFetchSavedPage({ collectionPk, maxId }) {
    const url =
      collectionPk && !isAllPosts(collectionPk)
        ? FETCH_ENDPOINTS.collection(collectionPk, maxId)
        : FETCH_ENDPOINTS.savedAll(maxId);
    const json = await apiGet(url);
    return {
      items: pageItems(json),
      nextMaxId: json.next_max_id || null,
      moreAvailable: Boolean(json.more_available),
    };
  }

  function isAllPosts(pk) {
    return String(pk).toUpperCase().includes("ALL_MEDIA");
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === "PING") {
      sendResponse({ ok: true, data: "pong" });
      return true;
    }
    if (msg.type === "FETCH_COLLECTIONS") {
      handleFetchCollections()
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
    if (msg.type === "FETCH_SAVED_PAGE") {
      handleFetchSavedPage(msg)
        .then((data) => sendResponse({ ok: true, data }))
        .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
      return true;
    }
  });
})();
