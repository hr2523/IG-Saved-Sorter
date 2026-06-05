# IG Saved Sorter

Organize your Instagram **saved media** into topic folders — *Food & Cooking*,
*Visual Art*, *Travel & Places*, *Music*, and more — using a **local CLIP model**.
Everything runs on your machine: no images are uploaded anywhere, and no API key
is required.

```
saved_media/                      sorted/
├── Cabc123dEf0.jpg               ├── Food & Cooking/
├── party_reel.mp4        ──►     │   └── Cabc123dEf0.jpg
├── sunset.png                    ├── Music & Concerts/
└── recipe_screenshot.jpg         │   └── party_reel.mp4
                                  ├── Travel & Places/
                                  │   └── sunset.png
                                  └── manifest.json / manifest.csv
```

## How it works

1. **Scan** a folder of downloaded saved media (images and videos).
2. **Classify** each file with [open_clip](https://github.com/mlfoundations/open_clip)
   using zero-shot scoring against a customizable topic taxonomy. When a post
   **caption** is available (via `sync`), its meaning is blended in — often the
   decisive signal for text-heavy or visually ambiguous posts. Videos are
   classified from a sampled middle frame.
3. **Sort** each file into `output/<Category>/` (copy, move, or symlink) and
   write a `manifest.json` + `manifest.csv` of every decision and confidence.
4. *(Optional)* **Enrich** results with your Instagram data export
   (`saved_posts.json`) so each item also records the original post URL,
   username, and save date.

Steps 1–3 also run automatically from the optional **`sync`** command, which
fetches new saved posts straight from your account (see the
[experimental section](#syncing-directly-from-instagram-experimental)).

## Getting your saved media

The classifier works on **image/video files**. You have two ways to get them:

1. **Automatic — `sync`** (logs into your account, downloads only *new* saves,
   then sorts them). The most convenient, but it scrapes Instagram — see the
   [important caveats](#syncing-directly-from-instagram-experimental) below.
2. **Manual** — drop a folder of images/videos you already have (downloaded with
   any tool you're authorized to use) and run `sort` on it. Optionally pass
   `--export saved_posts.json` to attach each post's original URL/username
   (matched by the `/p/<shortcode>/` in the filename).

To get `saved_posts.json` for option 2: Instagram → *Settings → Accounts Center
→ Your information and permissions → Download your information* → request
**JSON**. (The official export lists post URLs only — not the media files.)

## Installation

```bash
git clone <this-repo>
cd IG-Saved-Sorter

# Core CLIP stack (PyTorch is a large download)
pip install -r requirements.txt

# Or install the package with just the extras you want:
pip install -e ".[clip,video]"     # classification (+ video frames)
pip install -e ".[fetch]"          # the `sync` command (instagrapi)
pip install -e ".[web]"            # the `web` review app (Flask)
```

> `torch`, `open_clip_torch`, and `Pillow` are required for classification.
> `opencv-python` is optional and only needed to classify **videos**.
> `instagrapi` is optional and only needed for the `sync` command.
> `flask` is optional and only needed for the `web` review app.

## Usage

The CLI has four subcommands: **`sort`** (local folder), **`sync`** (fetch from
Instagram, then sort), **`web`** (interactive review app), and **`categories`**
(inspect the taxonomy).

### One-time shortcut (skip the cd + activate dance)

So you don't have to `cd` into the repo and activate the venv every new terminal,
add a shortcut that points at the bundled launcher (`run.sh` / `run.ps1`), which
does both for you:

```bash
# macOS / Linux (zsh) — run once from inside the repo:
echo "alias igsort=\"$(pwd)/run.sh\"" >> ~/.zshrc && source ~/.zshrc

# then, from ANY terminal:
igsort sync -u your_username --collection "Recipes"
igsort web ./ig_saved_media/sorted
```

```powershell
# Windows PowerShell — run once from inside the repo:
Add-Content $PROFILE "function igsort { & '$PWD\run.ps1' @args }" ; . $PROFILE
igsort sync -u your_username --collection "Recipes"
```

```bash
# Sort a folder of saved media (copies files into ./saved_media/sorted/)
ig-saved-sorter sort ./saved_media

# Choose an output location and move instead of copy
ig-saved-sorter sort ./saved_media -o ./organized --strategy move

# Preview decisions without touching files
ig-saved-sorter sort ./saved_media --dry-run

# Attach original post URLs/usernames from your IG export
ig-saved-sorter sort ./saved_media --export ./saved_posts.json

# Use your own categories and a higher confidence cutoff
ig-saved-sorter sort ./saved_media --categories-file categories.example.json --threshold 0.25

# Inspect the active categories
ig-saved-sorter categories          # or: ig-saved-sorter --list-categories
```

You can also run it as a module: `python -m ig_saved_sorter ...`

## Syncing directly from Instagram (experimental)

The `sync` command (powered by [instagrapi](https://github.com/subzeroid/instagrapi))
logs into your account, downloads **only saved posts it hasn't seen before**, and
sorts them — so you can re-run it to keep your folders current. It supports
fetching a **single saved Collection** by name.

```bash
pip install -e ".[clip,fetch]"

# See your Collections (names you can pass to --collection)
ig-saved-sorter sync -u your_username --list-collections

# Fetch + sort just one Collection
ig-saved-sorter sync -u your_username --collection "Recipes"

# Or all saved posts; later runs fetch only NEW saves
ig-saved-sorter sync -u your_username

# Limit how many new posts to pull, and download without sorting
ig-saved-sorter sync -u your_username --limit 50 --no-sort
```

### Logging in (recommended: `--sessionid`)

Password + 2FA + login-challenge flows are the flakiest part of any Instagram
automation. The most reliable way in is to **reuse the session from a browser
where you're already logged in**, which skips passwords, 2FA, and challenges
entirely:

1. In a desktop browser, log into `instagram.com`.
2. Open DevTools → **Application/Storage → Cookies → `https://www.instagram.com`**.
3. Copy the value of the **`sessionid`** cookie.
4. Pass it (via env var so it stays out of your shell history):

```bash
export IG_SESSIONID="the_long_sessionid_value"   # Windows PowerShell: $env:IG_SESSIONID="..."
ig-saved-sorter sync -u your_username --collection "Recipes"
# (or pass --sessionid "..." directly)
```

> Your `sessionid` is as sensitive as your password — never share or commit it.

**Password + 2FA (fallback):** run **in an interactive terminal**. After your
password you'll be prompted for the right code, and the prompt tells you where it
came from:
- a **two-factor** step takes your authenticator code or an 8-digit **backup code**;
- a **login challenge** ("confirm it's you") takes the 6-digit code Instagram
  **emails/texts you for that login** — *not* your backup code.

SMS is the least reliable (Instagram often won't send it to tooling); prefer
`--sessionid`, an authenticator app, or a backup code.

It keeps a small state file (`<media-dir>/.sync_state.json`) of processed
shortcodes for incremental updates, reuses a saved login session when present,
and automatically attaches each post's URL/username to the sorted results.

**Lightweight by default:** `sync` downloads only each post's small **cover
thumbnail** (~tens of KB) — not full-resolution photos or videos. That's enough
for CLIP to classify and for the web gallery to display, while keeping disk use
tiny (a few MB instead of gigabytes; videos aren't downloaded at all). The "open
↗" link in the web app always points to the original full post. Pass
`--full-media` if you actually want the original files saved.

> [!WARNING]
> **This scrapes Instagram and is against their Terms of Service.** There is no
> official API for saved posts, so `sync` reads private endpoints by logging in
> as you. This can trigger rate limits, login challenges, or account action. Use
> it sparingly, on your **own** account, for personal organization only. The
> manual `sort` workflow avoids all of this.
>
> Credentials: pass `--password`, set `$IG_PASSWORD`, or you'll be prompted.
> A reusable session is stored via `--session-file`. Session files and
> `.sync_state.json` are git-ignored — never commit them.

## Reviewing in the browser (`web`)

The `web` command launches a local app to **visually confirm** what was fetched
and sorted — a gallery grouped by category, with confidence bars, links back to
the original posts, and a dropdown on each item to **re-categorize** it (which
physically moves the file and updates the manifest).

```bash
pip install -e ".[clip,web]"

# Review an existing sorted folder
ig-saved-sorter web ./ig_saved_media/sorted          # open http://127.0.0.1:5000

# Enable in-app fetching too (lists your Collections, "Fetch & sort" button).
# Uses a saved session so it won't prompt for 2FA in the browser — log in once
# via `sync` first to create the session.
ig-saved-sorter web ./ig_saved_media/sorted -u your_username --session-file ig_session.json
```

### Key options (sort / sync)

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output` | `<input>/sorted` | Destination root for category folders. |
| `--strategy` | `copy` | `copy`, `move`, or `symlink`. |
| `--threshold` | `0.15` | Min top-1 confidence (0–1); below it → `Uncategorized`. |
| `--top-k` | `3` | Number of ranked predictions recorded per item. |
| `--categories-file` | built-in | JSON taxonomy override (see below). |
| `--caption-weight` | `0.55` | How much the caption (vs image) drives classification, 0–1. `0` = image only. |
| `--export` | — | Path to Instagram `saved_posts.json`. |
| `--model` / `--pretrained` | `ViT-B-32` / `laion2b_s34b_b79k` | open_clip model + weights. |
| `--device` | auto | Force `cpu` or `cuda`. |
| `--no-recursive` | off | Don't descend into subfolders. *(sort)* |
| `--dry-run` | off | Classify and report only. |
| `--user` | — | Instagram username to log in as. *(sync, required)* |
| `--password` / `--session-file` | — | Auth: password (or `$IG_PASSWORD`) / reusable session. *(sync)* |
| `--media-dir` | `./ig_saved_media` | Where `sync` downloads new saves. *(sync)* |
| `--state-file` | `<media-dir>/.sync_state.json` | Tracks already-synced posts. *(sync)* |
| `--limit` | — | Max new posts to download this run. *(sync)* |
| `--collection` | all saved | Fetch only this saved Collection by name. *(sync)* |
| `--list-collections` | off | Print your Collections and exit. *(sync)* |
| `--full-media` | off | Download full photos/videos instead of thumbnails. *(sync)* |
| `--no-sort` | off | `sync`: download only, skip classification. |
| `--host` / `--port` | `127.0.0.1` / `5000` | Web app bind address. *(web)* |

## Custom categories

Categories are just names mapped to descriptive phrases that CLIP scores against.
Override the built-in taxonomy with a JSON file (see
[`categories.example.json`](categories.example.json)):

```json
{
  "Food & Cooking": ["a plate of food", "a delicious meal", "dessert"],
  "Travel & Places": ["a travel photo of a famous place"],
  "Visual Art": ["a painting, drawing or illustration"]
}
```

Each phrase is also wrapped in a few prompt templates (e.g. `"a photo of {}"`)
for more robust zero-shot scoring.

## Output

Inside the output directory you get one subfolder per assigned category plus:

- **`manifest.json`** — full report: every file, its top category, the top-k
  ranked predictions with confidences, destination path, and any matched export
  metadata.
- **`manifest.csv`** — a flat, spreadsheet-friendly summary.

## Development

```bash
pip install -e ".[dev]"
pytest
```

The scanning, metadata parsing, sorting, fetching, web-app, and reporting logic
is unit tested **without** requiring torch or instagrapi — the suite uses a fake
classifier and a fake Instagram client, so you can hack on the pipeline without
the heavy ML/login installs. (`flask` is included in the `dev` extra for the web
app tests.)

## Notes & responsible use

- Only download and sort media you are authorized to access. Respect
  Instagram's Terms of Service and others' copyrights.
- Personal media and exports are git-ignored by default — don't commit them.
- CLIP zero-shot classification is good but not perfect; use `--dry-run` and the
  manifest to review, and tune `--threshold` / your categories to taste.

## License

MIT
