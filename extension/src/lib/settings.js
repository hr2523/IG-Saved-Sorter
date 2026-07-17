// Settings persisted in chrome.storage.local: category taxonomy, confidence
// threshold, image/caption blend weights, and the last sync cursor.

import { DEFAULT_CATEGORIES } from "./categories.js";

const KEY = "igss_settings";

export const DEFAULT_SETTINGS = {
  categories: DEFAULT_CATEGORIES,
  threshold: 0.15, // below this top confidence -> Uncategorized
  imageWeight: 0.45,
  captionWeight: 0.55, // captions are often the decisive signal
  model: "Xenova/clip-vit-base-patch32",
  // Gallery layout (user-customizable, pure CSS — no re-classify needed)
  cardRadius: 6, // px corner radius on image tiles
  cardMinWidth: 210, // px min column width -> density
  gridGap: 22, // px gap between cards
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[KEY] || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ [KEY]: DEFAULT_SETTINGS });
  return DEFAULT_SETTINGS;
}
