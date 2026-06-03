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

## Getting your saved media

The classifier works on **image/video files**, which Instagram's official
export does *not* include — the export only lists post URLs. You have two
options:

- **Download the files** using any Instagram media downloader you're authorized
  to use, then point the tool at that folder. If the downloader names files with
  the post *shortcode* (the `/p/<shortcode>/` part of the URL), pass
  `--export saved_posts.json` to attach the original URL/username to each item.
- Already have a folder of images/videos? Just sort those — the export is
  entirely optional.

To get `saved_posts.json`: Instagram → *Settings → Accounts Center → Your
information and permissions → Download your information* → request **JSON**.

## Installation

```bash
git clone <this-repo>
cd IG-Saved-Sorter

# Core CLIP stack (PyTorch is a large download)
pip install -r requirements.txt

# Or install the package with extras:
pip install -e ".[clip,video]"
```

> `torch`, `open_clip_torch`, and `Pillow` are required for classification.
> `opencv-python` is optional and only needed to classify **videos**.

## Usage

```bash
# Sort a folder of saved media (copies files into ./saved_media/sorted/)
ig-saved-sorter ./saved_media

# Choose an output location and move instead of copy
ig-saved-sorter ./saved_media -o ./organized --strategy move

# Preview decisions without touching files
ig-saved-sorter ./saved_media --dry-run

# Attach original post URLs/usernames from your IG export
ig-saved-sorter ./saved_media --export ./saved_posts.json

# Use your own categories and a higher confidence cutoff
ig-saved-sorter ./saved_media --categories-file categories.example.json --threshold 0.25

# Inspect the active categories
ig-saved-sorter --list-categories
```

You can also run it as a module: `python -m ig_saved_sorter ...`

### Key options

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
| `--no-recursive` | off | Don't descend into subfolders. |
| `--dry-run` | off | Classify and report only. |

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
