// Settings persisted in chrome.storage.local: category taxonomy, confidence
// threshold, image/caption blend weights, multi-label knobs, gallery layout.

import { DEFAULT_CATEGORIES, TAXONOMY_VERSION, cloneCategories } from "./categories.js";
import { addLog } from "./log.js";

const KEY = "igss_settings";

export const DEFAULT_SETTINGS = {
  categories: cloneCategories(), // deep copy — never hand out the shared DEFAULT_CATEGORIES singleton
  taxonomyVersion: TAXONOMY_VERSION,
  threshold: 0.15, // below this top confidence -> Uncategorized
  imageWeight: 0.45,
  captionWeight: 0.55, // captions are often the decisive signal
  model: "Xenova/clip-vit-base-patch32",
  // Multi-label categorization
  multiLabel: true,
  secondaryMargin: 0.9, // a secondary category must score >= 0.9 * the top blended cosine
  maxLabels: 3, // cap on categories per post (primary + secondaries + intent)
  // Gallery layout (user-customizable, pure CSS — no re-classify needed)
  cardRadius: 6, // px corner radius on image tiles
  cardMinWidth: 210, // px min column width -> density
  gridGap: 22, // px gap between cards
};

export async function getSettings() {
  const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  // One-time taxonomy refresh: a persisted `categories` object completely shadows
  // the code defaults (this is a shallow merge), so bumping TAXONOMY_VERSION is the
  // only way new phrases + categories reach an install that ever saved settings.
  // Preserve the user's threshold/weights/layout; replace only `categories`.
  // Steady-state stays read-only (getSettings runs every ~1.5s during classify) —
  // we persist only when the version actually changed, and it's idempotent.
  if ((stored.taxonomyVersion || 0) < TAXONOMY_VERSION) {
    merged.categories = cloneCategories();
    merged.taxonomyVersion = TAXONOMY_VERSION;
    await chrome.storage.local.set({ [KEY]: merged });
    addLog("info", `settings: taxonomy migrated to v${TAXONOMY_VERSION}`);
  }
  return merged;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function resetSettings() {
  const fresh = { ...DEFAULT_SETTINGS, categories: cloneCategories(), taxonomyVersion: TAXONOMY_VERSION };
  await chrome.storage.local.set({ [KEY]: fresh });
  return fresh;
}
