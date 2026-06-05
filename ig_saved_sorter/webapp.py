"""Interactive web app to review, confirm, and correct sorted media.

Reads a ``manifest.json`` produced by the sorter and serves a gallery grouped by
category. You can preview each item, filter by category, and re-categorize a
file (which physically moves it and updates the manifest). If a fetcher is wired
in, the app can also list your Instagram Collections and trigger a sync.

Flask is imported lazily inside :func:`create_app` so the rest of the package
(and the test suite) works without it installed.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Dict, List, Optional

from .categories import DEFAULT_CATEGORIES, UNCATEGORIZED
from .scanner import is_video
from .sorter import recategorize_file


@dataclass
class WebConfig:
    """Everything the web app needs, with optional Instagram hooks."""

    sorted_dir: Path
    categories: List[str] = field(default_factory=lambda: list(DEFAULT_CATEGORIES))
    # Optional hooks (None disables the sync panel):
    list_collections: Optional[Callable[[], List]] = None
    run_sync: Optional[Callable[[Optional[str], Optional[int]], Dict]] = None


def _load_manifest(path: Path) -> dict:
    if not path.exists():
        return {"total": 0, "counts": {}, "items": []}
    return json.loads(path.read_text(encoding="utf-8"))


def _save_manifest(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _recount(items: List[dict]) -> Dict[str, int]:
    counts: Dict[str, int] = {}
    for it in items:
        counts[it["category"]] = counts.get(it["category"], 0) + 1
    return counts


def create_app(config: WebConfig):
    """Build and return a Flask app for the given configuration."""
    try:
        from flask import Flask, abort, jsonify, request, send_file
    except ImportError as exc:  # pragma: no cover - needs the optional dep
        raise RuntimeError(
            "'flask' is required for the web app. Install it with: pip install flask"
        ) from exc

    sorted_dir = Path(config.sorted_dir).resolve()
    manifest_path = sorted_dir / "manifest.json"
    app = Flask(__name__)

    def _decorate(item: dict) -> dict:
        """Add a browser-servable media_url + media kind to a manifest item."""
        out = dict(item)
        dest = item.get("destination")
        out["media_url"] = None
        out["is_video"] = False
        if dest:
            dest_path = Path(dest)
            try:
                rel = dest_path.resolve().relative_to(sorted_dir)
                out["media_url"] = "/media/" + str(rel).replace("\\", "/")
                out["is_video"] = is_video(dest_path)
            except ValueError:
                pass
        return out

    @app.get("/")
    def index():
        return _PAGE

    @app.get("/api/manifest")
    def api_manifest():
        data = _load_manifest(manifest_path)
        items = [_decorate(it) for it in data.get("items", [])]
        cats = list(dict.fromkeys(list(config.categories) + [UNCATEGORIZED]))
        return jsonify(
            {
                "counts": data.get("counts", _recount(data.get("items", []))),
                "categories": cats,
                "items": items,
                "sync_enabled": config.run_sync is not None,
            }
        )

    @app.get("/media/<path:relpath>")
    def media(relpath: str):
        target = (sorted_dir / relpath).resolve()
        if not str(target).startswith(str(sorted_dir)) or not target.is_file():
            abort(404)
        return send_file(target)

    @app.post("/api/recategorize")
    def api_recategorize():
        body = request.get_json(force=True, silent=True) or {}
        dest = body.get("destination")
        new_cat = body.get("category")
        if not dest or not new_cat:
            return jsonify({"error": "destination and category are required"}), 400

        data = _load_manifest(manifest_path)
        item = next(
            (it for it in data.get("items", []) if it.get("destination") == dest), None
        )
        if item is None:
            return jsonify({"error": "item not found"}), 404
        if item["category"] == new_cat:
            return jsonify({"ok": True, "item": _decorate(item)})

        try:
            new_path = recategorize_file(dest, new_cat, sorted_dir)
        except FileNotFoundError:
            return jsonify({"error": "file missing on disk"}), 409

        item["category"] = new_cat
        item["destination"] = str(new_path)
        data["counts"] = _recount(data["items"])
        _save_manifest(manifest_path, data)
        return jsonify({"ok": True, "item": _decorate(item)})

    @app.get("/api/collections")
    def api_collections():
        if config.list_collections is None:
            return jsonify({"error": "sync is not configured"}), 400
        try:
            cols = config.list_collections()
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502
        return jsonify(
            {"collections": [{"name": n, "count": c} for n, c in cols]}
        )

    @app.post("/api/sync")
    def api_sync():
        if config.run_sync is None:
            return jsonify({"error": "sync is not configured"}), 400
        body = request.get_json(force=True, silent=True) or {}
        collection = body.get("collection") or None
        limit = body.get("limit")
        try:
            summary = config.run_sync(collection, int(limit) if limit else None)
        except Exception as exc:
            return jsonify({"error": str(exc)}), 502
        return jsonify(summary)

    return app


# Single-page UI (no external assets, works offline).
_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>IG Saved Sorter</title>
<style>
  :root { --bg:#0f1115; --card:#1a1d24; --muted:#8b93a7; --accent:#6ea8fe; --line:#262b36; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
         background:var(--bg); color:#e7ebf3; }
  header { padding:16px 20px; border-bottom:1px solid var(--line); position:sticky; top:0;
           background:var(--bg); z-index:5; }
  h1 { margin:0 0 4px; font-size:18px; }
  .sub { color:var(--muted); font-size:12px; }
  .bar { display:flex; gap:8px; flex-wrap:wrap; padding:12px 20px; border-bottom:1px solid var(--line); }
  .chip { background:var(--card); border:1px solid var(--line); color:#cdd5e6; padding:6px 10px;
          border-radius:999px; cursor:pointer; font-size:12px; }
  .chip.active { border-color:var(--accent); color:#fff; }
  .sync { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:12px 20px;
          border-bottom:1px solid var(--line); background:#12151b; }
  select, input, button { background:var(--card); color:#e7ebf3; border:1px solid var(--line);
          border-radius:8px; padding:7px 9px; font-size:13px; }
  button { cursor:pointer; }
  button.primary { background:var(--accent); color:#06122b; border-color:var(--accent); font-weight:600; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:14px; padding:18px 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden;
          display:flex; flex-direction:column; }
  .thumb { aspect-ratio:1/1; background:#0b0d11; display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .thumb img, .thumb video { width:100%; height:100%; object-fit:cover; }
  .meta { padding:10px; display:flex; flex-direction:column; gap:7px; }
  .name { font-size:12px; color:#cdd5e6; word-break:break-all; }
  .conf { height:5px; background:#0b0d11; border-radius:4px; overflow:hidden; }
  .conf > i { display:block; height:100%; background:var(--accent); }
  .row { display:flex; gap:6px; align-items:center; justify-content:space-between; }
  a { color:var(--accent); text-decoration:none; font-size:12px; }
  .muted { color:var(--muted); font-size:11px; }
  .msg { padding:10px 20px; color:#ffd479; font-size:13px; }
  .empty { padding:40px 20px; color:var(--muted); text-align:center; }
</style>
</head>
<body>
<header>
  <h1>IG Saved Sorter</h1>
  <div class="sub" id="summary">Loading…</div>
</header>
<div class="sync" id="syncPanel" style="display:none">
  <strong style="font-size:13px">Fetch from Instagram:</strong>
  <select id="collection"><option value="">All saved posts</option></select>
  <input id="limit" type="number" min="1" placeholder="limit" style="width:90px"/>
  <button class="primary" id="fetchBtn">Fetch &amp; sort new</button>
  <span class="muted" id="syncMsg"></span>
</div>
<div class="bar" id="filters"></div>
<div class="grid" id="grid"></div>
<div class="empty" id="empty" style="display:none">No media yet. Run a sort or fetch first.</div>

<script>
let STATE = { items: [], categories: [], counts: {}, filter: "*" };

async function load() {
  const r = await fetch("/api/manifest");
  const d = await r.json();
  STATE.items = d.items; STATE.categories = d.categories; STATE.counts = d.counts;
  document.getElementById("summary").textContent =
    `${d.items.length} item(s) across ${Object.keys(d.counts).length} categories`;
  if (d.sync_enabled) { document.getElementById("syncPanel").style.display = "flex"; loadCollections(); }
  renderFilters(); render();
}

function renderFilters() {
  const f = document.getElementById("filters");
  const cats = Object.keys(STATE.counts).sort((a,b)=>STATE.counts[b]-STATE.counts[a]);
  const chips = [["*","All",STATE.items.length], ...cats.map(c=>[c,c,STATE.counts[c]])];
  f.innerHTML = chips.map(([v,label,n])=>
    `<span class="chip ${STATE.filter===v?'active':''}" data-v="${encodeURIComponent(v)}">${label} (${n})</span>`).join("");
  f.querySelectorAll(".chip").forEach(ch=>ch.onclick=()=>{STATE.filter=decodeURIComponent(ch.dataset.v);renderFilters();render();});
}

function catOptions(sel) {
  const all = Array.from(new Set([...STATE.categories, ...Object.keys(STATE.counts)]));
  return all.map(c=>`<option ${c===sel?'selected':''}>${c}</option>`).join("");
}

function render() {
  const g = document.getElementById("grid");
  const items = STATE.items.filter(it=>STATE.filter==="*"||it.category===STATE.filter);
  document.getElementById("empty").style.display = STATE.items.length? "none":"block";
  g.innerHTML = items.map(it=>{
    const conf = Math.round((it.confidence||0)*100);
    const media = it.media_url
      ? (it.is_video
          ? `<video src="${it.media_url}" muted></video>`
          : `<img loading="lazy" src="${it.media_url}"/>`)
      : `<span class="muted">no preview</span>`;
    const link = (it.post && it.post.url) ? `<a href="${it.post.url}" target="_blank">open ↗</a>` : "";
    return `<div class="card">
      <div class="thumb">${media}</div>
      <div class="meta">
        <div class="name">${(it.source||"").split("/").pop()}</div>
        <div class="conf"><i style="width:${conf}%"></i></div>
        <div class="muted">${conf}% confidence</div>
        <div class="row">
          <select data-dest="${encodeURIComponent(it.destination||'')}">${catOptions(it.category)}</select>
          ${link}
        </div>
      </div></div>`;
  }).join("");
  g.querySelectorAll("select").forEach(s=>s.onchange=()=>recategorize(decodeURIComponent(s.dataset.dest), s.value));
}

async function recategorize(destination, category) {
  const r = await fetch("/api/recategorize", {method:"POST", headers:{'Content-Type':'application/json'},
    body: JSON.stringify({destination, category})});
  const d = await r.json();
  if (d.error) { alert(d.error); return; }
  const it = STATE.items.find(x=>x.destination===destination);
  if (it) { it.category = d.item.category; it.destination = d.item.destination; }
  STATE.counts = {}; STATE.items.forEach(x=>STATE.counts[x.category]=(STATE.counts[x.category]||0)+1);
  renderFilters(); render();
}

async function loadCollections() {
  try {
    const r = await fetch("/api/collections"); const d = await r.json();
    if (d.collections) {
      const sel = document.getElementById("collection");
      d.collections.forEach(c=>{
        const o=document.createElement("option"); o.value=c.name; o.textContent=`${c.name} (${c.count})`; sel.appendChild(o);
      });
    }
  } catch(e) {}
}

document.getElementById("fetchBtn").onclick = async () => {
  const btn = document.getElementById("fetchBtn"), msg = document.getElementById("syncMsg");
  btn.disabled = true; msg.textContent = "Fetching… this can take a while.";
  try {
    const collection = document.getElementById("collection").value;
    const limit = document.getElementById("limit").value;
    const r = await fetch("/api/sync", {method:"POST", headers:{'Content-Type':'application/json'},
      body: JSON.stringify({collection, limit})});
    const d = await r.json();
    msg.textContent = d.error ? ("Error: "+d.error) : `Done: ${d.new_count||0} new, ${d.skipped||0} skipped.`;
    if (!d.error) await load();
  } catch(e) { msg.textContent = "Error: "+e; }
  btn.disabled = false;
};

load();
</script>
</body>
</html>"""
