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
   using zero-shot scoring against a customizable topic taxonomy. Videos are
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
pip install -e ".[fetch]"          # the `sync` command (Instaloader)
```

> `torch`, `open_clip_torch`, and `Pillow` are required for classification.
> `opencv-python` is optional and only needed to classify **videos**.
> `instaloader` is optional and only needed for the `sync` command.

## Usage

The CLI has three subcommands: **`sort`** (local folder), **`sync`** (fetch from
Instagram, then sort), and **`categories`** (inspect the taxonomy).

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

The `sync` command logs into your account, downloads **only saved posts it
hasn't seen before**, and sorts them — so you can re-run it to keep your folders
up to date.

```bash
pip install -e ".[clip,fetch]"

# First run logs in and downloads everything saved; later runs fetch only NEW saves
ig-saved-sorter sync --user your_username

# Limit how many new posts to pull, and just download without sorting
ig-saved-sorter sync -u your_username --limit 50 --no-sort
```

**Two-factor authentication (2FA):** if your account has 2FA enabled, run the
command **in an interactive terminal** — after your password it will prompt for
the one-time code from your authenticator app or SMS, then save a session so you
won't need to repeat it. If you prefer, create the session once with Instaloader
directly (it handles 2FA too) and `sync` will reuse it:

```bash
instaloader --login=your_username      # prompts for password + 2FA code once
ig-saved-sorter sync --user your_username   # reuses that saved session
```

It keeps a small state file (`<media-dir>/.sync_state.json`) of processed
shortcodes for incremental updates, reuses a saved login session when present,
and automatically attaches each post's URL/username to the sorted results.

> [!WARNING]
> **This scrapes Instagram and is against their Terms of Service.** There is no
> official API for saved posts, so `sync` reads private endpoints by logging in
> as you. This can trigger rate limits, login challenges, or account action. Use
> it sparingly, on your **own** account, for personal organization only. The
> manual `sort` workflow avoids all of this.
>
> Credentials: pass `--password`, set `$IG_PASSWORD`, or you'll be prompted.
> Prefer a saved Instaloader **session file** (`--session-file`) so you don't
> log in repeatedly. Session files and `.sync_state.json` are git-ignored —
> never commit them.

### Key options (sort / sync)

| Option | Default | Description |
| --- | --- | --- |
| `-o, --output` | `<input>/sorted` | Destination root for category folders. |
| `--strategy` | `copy` | `copy`, `move`, or `symlink`. |
| `--threshold` | `0.15` | Min top-1 confidence (0–1); below it → `Uncategorized`. |
| `--top-k` | `3` | Number of ranked predictions recorded per item. |
| `--categories-file` | built-in | JSON taxonomy override (see below). |
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
| `--no-sort` | off | `sync`: download only, skip classification. |

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

The scanning, metadata parsing, sorting, and reporting logic is fully unit
tested **without** requiring torch (the test suite uses a fake classifier), so
you can hack on the pipeline without the heavy ML install.

## Notes & responsible use

- Only download and sort media you are authorized to access. Respect
  Instagram's Terms of Service and others' copyrights.
- Personal media and exports are git-ignored by default — don't commit them.
- CLIP zero-shot classification is good but not perfect; use `--dry-run` and the
  manifest to review, and tune `--threshold` / your categories to taste.

## License

MIT
