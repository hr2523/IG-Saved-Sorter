# IG Saved Sorter — project guide & handoff

Organize a user's Instagram **saved posts** into topic categories, classified locally
with CLIP. Two deliverables live in this repo:

- **`ig_saved_sorter/`** — the original **Python CLI (v1)**. Fetches via instagrapi,
  classifies with a local CLIP model, sorts into folders. Works; tests pass
  (`pytest`). Not the active focus.
- **`extension/`** — a **Chrome MV3 browser extension (v2, current focus)**. Reads the
  user's saved posts *in their logged-in browser* (no login/2FA), classifies in-browser
  with transformers.js CLIP, and shows a gallery. **All recent work is here.**

Active branch: **`claude/ig-saved-media-sorter-D1tAe`**. Current version: **0.9.3**
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
- **`lib/{categories,tags,settings,db,log,messaging}.js`**: taxonomy (23 cats, each with
  descriptive phrases + `expandPrompts`; `TAXONOMY_VERSION` + `cloneCategories` for the
  settings migration; `INTENT_DETECTORS`/`detectIntentCategories` — caption-regex labels like
  Tutorials/Reels that CLIP can't see in pixels), ~140-tag vocab + caption keyword extractor,
  settings (chrome.storage; `getSettings` runs a version-gated taxonomy refresh + carries
  `multiLabel`/`secondaryMargin`/`maxLabels`), IndexedDB wrapper (posts + thumbnails), log
  ring-buffer (its own IndexedDB — works in every context), message constants + `broadcast`.
- **Multi-label:** a post carries `post.categories` (string[]) built by `assembleCategories`
  in the classifier — primary via argmax+threshold, secondaries via **raw blended cosine**
  (NOT the peaky softmax) within `secondaryMargin` of the top, plus caption **intent** labels.
  `post.category` = `categories[0]` (kept for backward-compat + the DB `category` index).
- **`app/`**: gallery tab (grid filtered by category chips **+ a keyword/caption/category
  search box**, multi-label category chips per card + a removable-chip/add-dropdown editor,
  Settings drawer with layout sliders + **Reset categories** + **Logs panel + Copy logs**,
  light/dark).
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

**What v0.8.4 tried and what the user's logs proved (important):** v0.8.4 made `initEmbed`
self-select among three strategies. The user's Logs panel then showed ALL THREE failing:
- `split:<model>` (both patch32 AND patch16) → `Missing … input_ids`. So this is **not**
  model-specific: in transformers.js **2.17.2**, `CLIPVisionModelWithProjection` never yields a
  vision-only session — every split load is a two-tower graph that demands `input_ids`. There is
  no "use a model with separate exports" escape hatch in this version.
- `features:<model>` → **`CLIPModel exposes no get_text_features/get_image_features`** — those
  methods simply don't exist in 2.17.2.

**v0.8.5 fix — the "merged dummy-tower" strategy** (in `classifier.js` `buildEmbedModels`):
run the SAME merged graph the pipeline already runs successfully, but feed a throwaway **dummy**
to the tower we don't need and read only the output we want — `image_embeds` depends solely on
`pixel_values`, `text_embeds` solely on `input_ids`. So we encode each image via
`model({ pixel_values, ...dummyText })` → read `image_embeds`, and cache category/tag text via
`model({ input_ids, attention_mask, pixel_values: dummyPixels })` → read `text_embeds`. Because
it's the pipeline's own graph, it loads wherever the pipeline does — but we stop re-encoding
~150 label texts per image, which is the ~10× win. `initEmbed` now tries
`merged:<configured>` → `split:<configured>` → `merged:Xenova/clip-vit-base-patch16`, self-testing
BOTH paths (with two texts, to catch any text/image batch-size coupling) before committing, else
pipeline. **Check the logs** for `embed self-test OK via merged:<id>` and
`classifier: embedding path … — model <id>` (success) vs `classifier: pipeline path`. Can't be
reproduced in-sandbox (HF 403), so it's confirmed from the user's Logs panel + per-post timing.
If `merged:` also fails its self-test, read the new `embed attempt merged:<id> failed — …` line —
that's the next thing to debug (likely the merged export not surfacing `image_embeds`/`text_embeds`).

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
- **v0.8.4** — first attempt to unblock the fast embed path (split→`get_*_features`→patch16
  split, self-tested). The user's logs proved all three fail in transformers.js 2.17.2 (split =
  `Missing input_ids` on BOTH models; `CLIPModel` has no `get_*_features`). Superseded by 0.8.5.
  (Background-execution question that prompted this: closing the popup / switching tabs does
  NOT throttle classify — it's a pure `await`/WASM loop in the offscreen doc; the felt "lag"
  was the slow pipeline path, which this targets.)
- **v0.8.5** — the fix that should actually stick: **merged dummy-tower** embed strategy. Run
  the pipeline's own merged CLIP graph but feed a dummy to the unused tower and read
  `image_embeds`/`text_embeds` separately — encode each image once, cache text once (~10× win),
  using a graph proven to load on the user's machine. `initEmbed` tries `merged:<configured>` →
  `split:<configured>` → `merged:patch16`, self-tested, else pipeline. Confirm from the Logs
  panel (`embed self-test OK via merged:…`) + per-post timing (expect well under the pipeline's
  ~3 s/post).
- **v0.9.0** — **multi-label categorization + keyword search.** Added 5 categories (Motion
  Graphics & Animation, 3D/CGI Render, Video/Film/Reels, UI/UX & Web/Product Design, Tutorials)
  and tightened over-broad absorber phrases (Photography/People/Business/Tech/Quotes/Memes).
  Posts now carry `post.categories[]` via `assembleCategories` (secondaries from raw cosine, not
  the peaky softmax; caption **intent** detector adds Tutorials/Reels regardless of the image —
  so a cooking tutorial = Food **and** Tutorials). Gallery: keyword/caption/category search box +
  per-card multi-label chip editor. Settings: `TAXONOMY_VERSION`-gated refresh in `getSettings`
  (existing installs' frozen `categories` get replaced once, threshold/weights preserved) +
  **Reset categories** button. Existing posts need a **Re-classify all** to gain `categories`
  and be re-scored; legacy single-`category` records render via a `postCategories()` fallback.
- **v0.9.1** — **crawl-cap fixes + collapsible keywords.** A user with >2474 saved posts
  couldn't fetch past ~2474. Causes: (1) sync fell back to DOM-scroll (weak, plateaus) because
  the interceptor didn't capture IG's request in the single 9s window; (2) the resume `frontier`
  cursor was written every page but **never read** (`cursor` hard-coded to `""` at replay-loop
  init), so partial crawls re-walked page 1 to the same wall; (3) a latched `complete` flag made
  re-runs incremental. Fixes: loop the nudge (`nudgeScroll` now scrolls up+down; up to ~24s over
  6 cycles) to reliably capture IG's request → **prefer replay over scroll**; **seed the replay
  cursor from `resume.frontier`** for interrupted full crawls; new **`MSG.RESET_SYNC`** →
  `clearResume()` only (keeps posts) wired to a **Force full re-sync** button (gallery Settings +
  popup); `MSG.DONE` now carries `fetchComplete`/`fetched` so a **partial fetch is surfaced**
  ("may be incomplete — Sync to resume") instead of a plain "Done". Keywords on gallery cards are
  now a per-card `<details>` (collapsed by default) plus a header **#** toggle for global
  show/hide (persisted in `localStorage`, mirrors the theme toggle). NOTE: if IG genuinely stops
  giving a cursor at ~2474 (`fetch: replay finished (… complete)`), that's an IG-side limit no
  client fix can beat — read the fetch logs to tell replay-vs-scroll and complete-vs-partial.
- **v0.9.2** — **log-flood fix so fetch diagnostics survive.** The log ring buffer was `MAX=200`
  (`log.js`) while a classify pass logged every 3 posts (~400 lines via `broadcast` mirroring
  PROGRESS), evicting the fetch-phase lines before the user could copy them ("early log not
  showing up"). Added a **`noLog`** hint honored by `broadcast` (`messaging.js`): classify progress
  now updates the UI bar every 3 posts but only LOGS a milestone (~every 60 + final), and the
  fetch `Found N…` counter is `noLog`. Raised `MAX` to **1000**. The valuable per-page
  `replay page N … cursor=yes/no` lines are `addLog`'d directly (unaffected). This unblocks
  diagnosing the crawl cap — the fetch markers now persist through a classify pass.
- **v0.9.3** — **crawl robustness (get the whole feed).** The crawl stopped at a *variable* point
  (2474/2454/1197), which rules out a fixed IG cap and points to scroll-fallback or replay
  throttling. Two-pronged, tightly-bounded fix in `service-worker.js`: **(S) guarantee replay** —
  if the multi-nudge still captures nothing, **reload the saved tab once** (`chrome.tabs.reload` +
  `waitForTabComplete`) and re-nudge, since a fresh load reliably fires IG's first saved-feed
  request; plus a more patient scroll backstop (stable 4→8, 6 for DOM scrape, 1.2s waits).
  **(T) patient replay** — jittered pacing (`PAGE_DELAY_MS` 900→1400 + `pageDelay()` random),
  `replayWithRetry` 5→**8** tries & 120s cap, in-loop **cool-down auto-resume** (on throttle-null,
  wait 60–90s and retry the SAME cursor up to 3 *consecutive* times, budget refilled on any
  success), and **bounded retry-on-missing-cursor** (IG drops `next_max_id` transiently while
  `more_available` — retry same cursor up to 2× before declaring end). Partial banners now say
  "Sync again to continue (don't Clear)" since the frontier resume accumulates. NOTE: still needs
  the user's 0.9.2+ fetch logs to confirm which path (replay vs scroll, complete vs partial); if
  replay consistently hits a clean `more_available:false` at a stable point, that's IG's true
  end-of-feed for the account and unbeatable client-side.

### Not yet done (remaining verified review findings, lower priority)
- Gallery re-reads all posts + re-decodes all thumbnails every 1.5s during classify
  (flicker/CPU) → patch cards incrementally instead of full `load()`.
- DOM-scrape/scroll fallback doesn't honor the full-crawl gating (only the replay path does).
- Offscreen document is never torn down (~90MB resident) — optional idle-close.
- `web_accessible_resources` over-exposes model/wasm/offscreen to instagram.com — safe to
  remove (nothing web-facing loads them).
- Dead endpoint-guessing code in the service worker (`inPageFetch`, candidate builders,
  `resolveCollectionPk`, unused `normalizeCollections`) — delete or wire in.
- Multi-label shipped in v0.9.0. Remaining categorization ideas: a stronger model (SigLIP)
  as an opt-in; expose `secondaryMargin`/`maxLabels` as Settings sliders; tune the intent
  regex if it over-fires; optional absolute-cosine floor so a near-tie *visual* dual-category
  post isn't collapsed to Uncategorized by the peaky softmax (needs on-machine tuning).
- Consider ESLint `no-undef` in the pre-push checks.

Full review with per-finding fixes: run history / prior thread. Verified findings covered
the plan file at `~/.claude/plans/`.

---

## Git / commits
Develop on `claude/ig-saved-media-sorter-D1tAe`; commit + push there. Bump the extension
version on every functional change. Do not open a PR unless asked.
