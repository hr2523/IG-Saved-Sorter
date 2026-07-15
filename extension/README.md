# IG Saved Sorter — Chrome extension

Organize your Instagram **saved posts** into topic categories, entirely in your
browser. It reads your saved posts through your **already-logged-in
instagram.com session** — so there is **no login, no password, no 2FA, no
sessionid**. Classification runs locally with a small **CLIP** model
(transformers.js); nothing is uploaded anywhere, and your Instagram account is
never modified.

This is a browser-native alternative to the Python CLI in the repo root. Same
idea (CLIP + image/caption blending), no terminal login pain.

## What it does

- Fetches your saved posts (all, or one **Collection** by name) using the same
  private web API the Instagram Saved page itself calls, with your session cookies.
- Downloads a small **thumbnail** per post (stored locally; full media/videos are
  never downloaded).
- Classifies each post with **CLIP**, blending the thumbnail **image** with the
  post **caption** (the caption is often the decisive signal).
- Shows a **gallery** grouped by category — each card has the thumbnail,
  confidence, a link to the original post, and a **dropdown to re-categorize**
  (manual overrides stick and are never re-classified).
- Editable categories, confidence threshold, and image/caption weight in Settings.

## Install (one time)

You need **Node.js** (for the setup step) and **Chrome**.

```bash
# 1. Vendor the ML runtime locally (MV3 forbids loading code from a CDN).
bash extension/setup.sh

# 2. Load it in Chrome:
#    - open  chrome://extensions
#    - turn on "Developer mode" (top-right)
#    - click "Load unpacked" and select the  extension/  folder
```

The first classification downloads the CLIP weights (~90 MB) once from
HuggingFace, then everything runs offline.

## Use

1. Have a normal **instagram.com** tab open and logged in.
2. Click the extension icon → optionally type a Collection name (or "List my
   collections") and a limit → **Sync & classify**.
3. Click **Open gallery** to review, filter by category, and re-categorize.

## Files

```
extension/
  manifest.json
  setup.sh                     # vendors transformers.js + WASM (run once)
  src/
    background/service-worker.js  # orchestrates fetch + classify + thumbnails
    content/ig-fetch.js           # the ONLY file that calls Instagram's web API
    offscreen/offscreen.html + classifier.js   # CLIP (WASM) — image+caption blend
    app/index.html + app.js + app.css          # the gallery + settings
    popup/popup.html + popup.js                 # launcher + progress
    lib/{categories,settings,db,messaging}.js
```

## If sync breaks (endpoint changed)

Instagram's private web endpoints are undocumented and change without notice.
Everything Instagram-specific lives in **one** file: `src/content/ig-fetch.js`
(see `FETCH_ENDPOINTS` and `normalize()`). To fix:

1. Open your Saved page: `https://www.instagram.com/<you>/saved/`
2. DevTools → **Network** → scroll the page → find the request that returns your
   saved posts (look for `feed/saved` or `collection`/GraphQL).
3. Copy its **URL, method, request headers, and response JSON shape**.
4. Update `FETCH_ENDPOINTS` / `normalize()` to match, and reload the extension.

## Responsible use / caveats

- This reads Instagram's **private web API** via automation. It uses **your own**
  logged-in session, only **reads** your **own** saved posts, stores everything
  **locally**, and never modifies your account — but it is still against
  Instagram's Terms of Use, and there is no official API for saved posts. Use it
  gently for personal organization. Rapid fetching can trigger rate limits; the
  extension throttles between pages, but don't hammer it.
- CLIP is good, not perfect — use the re-categorize dropdown to fix misses.
- Icons are omitted (Chrome shows a default) to keep the repo binary-free; add
  PNGs under `assets/icons/` and reference them in `manifest.json` if you like.
