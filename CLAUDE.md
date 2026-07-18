# IG Saved Sorter — project guide & handoff

Organize a user's Instagram **saved posts** into topic categories, classified locally
with CLIP. Two deliverables live in this repo:

- **`ig_saved_sorter/`** — the original **Python CLI (v1)**. Fetches via instagrapi,
  classifies with a local CLIP model, sorts into folders. Works; tests pass
  (`pytest`). Not the active focus.
- **`extension/`** — a **Chrome MV3 browser extension (v2, current focus)**. Reads the
  user's saved posts *in their logged-in browser* (no login/2FA), classifies in-browser
  with transformers.js CLIP, and shows a gallery. **All recent work is here.**

Active branch: **`claude/ig-saved-media-sorter-D1tAe`**. Current version: **0.8.4**
(see `extension/manifest.json`). GitHub repo scope: `hr2523/ig-saved-sorter`.

---

## Extension architecture (`extension/src/`)

Flow: read saved posts → download+downscale thumbnails → classify (offscreen CLIP) →
gallery. Everything is local (IndexedDB); the IG account is never modified.

- **`content/interceptor.js`** (MAIN world, `document_start`): monkey-patches
  `fetch`+`XMLHttpRequest` on instagram.com to capture Instagram's OWN saved-feed request
  (method/url/headers/body) + its JSON response; `postMessage`s them out.
- **`content/relay.js`** (ISOLATED world): forwards captures to the service worker
  (MAIN world has no `chrome.runtime`).
- **`background/service-worker.js`**: orchestrates a sync. Nudges IG to fire its request,
  then **replays** the captured request with pagination cursors (`replayInPage` via
  `chrome.scripting.executeScript`, MAIN world) — **no scrolling**. Retries transient
  429/5xx with backoff (`replayWithRetry`). Persists a per-saved-page resume cursor +
  `complete` flag in `chrome.storage.local` (full-crawl until end, then incremental).
  Downloads/downscales thumbnails via `OffscreenCanvas` → blob in IndexedDB. Fallbacks:
  `scrollInterceptFallback` → DOM scrape (`scrapeChunk`). Drives the offscreen classifier.
- **`lib/ig-normalize.js`**: parses REST (`items[]`) and GraphQL (`edges[]`) shapes.
  **Post id = shortcode (`code`)** across all paths (so dedupe is consistent).
- **`offscreen/classifier.js`**: two engines (auto-selected, logged):
  - **embed** (preferred): hand-wired CLIP — precompute category **prototypes**
    (mean-pooled over the descriptive phrases w/ prompt ensembling) + tag embeddings ONCE,
    encode each image once, **blend image+caption** (`imageWeight`/`captionWeight`),
    softmax(temp=100), threshold. Self-tested at load; on failure →
  - **pipeline** (fallback): `pipeline('zero-shot-image-classification', ...)` fed the real
    phrases (not display names), phrase→category max-aggregation. Image-only.
  - Classify requests are **serialized** (one inference at a time on the shared model).
- **`lib/{categories,tags,settings,db,log,messaging}.js`**: taxonomy (18 cats, each with
  descriptive phrases + `expandPrompts`), ~110-tag vocab + caption keyword extractor,
  settings (chrome.storage), IndexedDB wrapper (posts + thumbnails), log ring-buffer
  (its own IndexedDB — works in every context), message constants + `broadcast` (also
  mirrors errors/progress into the log).
- **`app/`**: gallery tab (grid grouped by category, keyword bullets, re-categorize,
  Settings drawer with layout sliders + **Logs panel + Copy logs**, light/dark).
- **`popup/`**: launcher (Sync this page, limit, progress, open gallery). Shows version.

Post `status` lifecycle: `pending` → (`needs_thumb` if thumbnail failed / `error` if
inference failed) → `done`. Incremental sync skips a post only when BOTH the record AND
its thumbnail blob exist; `needs_thumb`/`error` are retryable.

---

## Dev workflow & HARD-WON GOTCHAS (read these)

- **Setup once:** `bash extension/setup.sh` vendors transformers.js + onnxruntime WASM
  into `src/lib/`+`src/wasm/` (git-ignored). Needs Node. Not re-run per pull.
- **Load unpacked:** `chrome://extensions` → Developer mode → Load unpacked → `extension/`.
- **RELOAD AFTER EVERY PULL:** loading unpacked snapshots the files; `git pull` does NOT
  update the running extension. Toggle the extension **off/on** (more reliable than the
  ↻ icon) and reopen the popup. **The version number in the popup is the reload check** —
  bump `manifest.json` version on every change so the user can confirm the new code loaded.
- **Monitoring, not guessing:** the in-app **Logs panel** (Settings → Copy logs) is the
  debugging channel. Errors are surfaced there, not swallowed. Ask the user to paste logs.
- **Sandbox can't run the real thing:** HuggingFace is 403 (no model download), `sharp`
  binary is blocked (no Node transformers.js). So CLIP/IG behavior can only be verified on
  the *user's* machine via the Logs panel. `node --check` catches syntax but NOT undefined
  references (a missing import shipped once) — consider adding ESLint `no-undef`.
- **Must-use browser:** Chrome/Edge/Brave. **Dia does NOT work** (missing MV3 `offscreen`/
  `scripting` APIs → "Receiving end does not exist").
- **Only Chrome-family** — the whole model runs in an offscreen document because WASM is
  not allowed in a service worker.
- **Offscreen docs can only use `chrome.runtime`** — NOT `chrome.storage` (settings are
  passed into the classifier via message). Service workers **cannot use dynamic `import()`**
  (use static imports).
- **Instagram is GraphQL-only now** — the private REST endpoints 404, which is why fetching
  is done by intercepting IG's own request and replaying it, not by calling a hardcoded API.

### The "Missing input_ids" history (important for the classifier)
The embed engine uses `CLIPTextModelWithProjection`/`CLIPVisionModelWithProjection`. An
earlier attempt at this exact API threw `An error occurred during model execution: "Missing
the following inputs: input_ids"` and was replaced by the pipeline. **Root cause (v0.8.4):**
the default model `Xenova/clip-vit-base-patch32` ships **only a merged CLIP graph** (both
towers), so `CLIPVisionModelWithProjection` can't load a vision-only session — encoding an
image alone still demands `input_ids`, hence the throw. The pipeline works because it feeds
`input_ids`+`pixel_values` together to that same merged graph.

**v0.8.4 fix — `initEmbed` now self-selects a working embed strategy** (in `classifier.js`),
trying each and self-testing BOTH the vision and text paths before committing:
1. `split:<configured model>` — `…WithProjection` on patch32 (today's path)
2. `features:<configured model>` — merged `CLIPModel` via `get_image_features`/`get_text_features`
3. `split:Xenova/clip-vit-base-patch16` — a model that DOES ship separate text/vision ONNX exports
…else fall back to the pipeline (unchanged). Each candidate is isolated, so a throw just moves
on — the fast path can only be gained, never regress. **Check the logs** for
`embed self-test OK via <label>` (which strategy won) or `embed attempt <label> failed — …`,
and `classifier: embedding path … — model <id>` vs `classifier: pipeline path`. Since this
can't be reproduced in-sandbox (HF is 403), the winning strategy is confirmed from the user's
Logs panel. If ALL embed strategies fail, that's the next thing to debug.

---

## Status

Done recently (from an adversarial code review — 21 verified findings):
- **v0.8.0 Phase A** — stop silently stranding posts as Uncategorized (retryable
  `needs_thumb`/`error` statuses, aggregate error count, single-flight offscreen, gated
  reclassify).
- **v0.8.1 Phase B** — resumable + retrying fetch (persisted frontier cursor + complete
  flag, backoff on 429/5xx, cursor-less first page, unified shortcode key). NOTE: the key
  change means existing installs should **Clear data + resync once**.
- **v0.8.2 Phase C** — categorization rewrite: real phrases + prompt ensembling +
  image/caption blend + ~10× fewer text encodes, with the pipeline fallback.
- **v0.8.3** — fix missing `getThumbnail` import.
- **v0.8.4** — unblock the fast embed path: `initEmbed` self-selects a working CLIP strategy
  (split→`get_*_features`→patch16 split), self-testing vision+text before committing, so the
  ~10× fast path is used whenever any strategy works instead of always falling to the slow
  pipeline. Root-caused the "Missing input_ids" throw to patch32 shipping only a merged graph.
  (Background-execution question that prompted this: closing the popup / switching tabs does
  NOT throttle classify — it's a pure `await`/WASM loop in the offscreen doc; the felt "lag"
  was the slow pipeline path, which this targets.)

### Not yet done (remaining verified review findings, lower priority)
- Gallery re-reads all posts + re-decodes all thumbnails every 1.5s during classify
  (flicker/CPU) → patch cards incrementally instead of full `load()`.
- DOM-scrape/scroll fallback doesn't honor the full-crawl gating (only the replay path does).
- Offscreen document is never torn down (~90MB resident) — optional idle-close.
- `web_accessible_resources` over-exposes model/wasm/offscreen to instagram.com — safe to
  remove (nothing web-facing loads them).
- Dead endpoint-guessing code in the service worker (`inPageFetch`, candidate builders,
  `resolveCollectionPk`, unused `normalizeCollections`) — delete or wire in.
- Categorization could be multi-label (IG posts span topics) and/or a stronger model
  (SigLIP) as an opt-in.
- Consider ESLint `no-undef` in the pre-push checks.

Full review with per-finding fixes: run history / prior thread. Verified findings covered
the plan file at `~/.claude/plans/`.

---

## Git / commits
Develop on `claude/ig-saved-media-sorter-D1tAe`; commit + push there. Bump the extension
version on every functional change. Do not open a PR unless asked.
