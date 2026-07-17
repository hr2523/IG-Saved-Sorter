import { MSG } from "../lib/messaging.js";
import { getSettings, saveSettings } from "../lib/settings.js";
import { UNCATEGORIZED } from "../lib/categories.js";
import { getAllPosts, getThumbnail, putPost, clearAll } from "../lib/db.js";

const $ = (id) => document.getElementById(id);

let STATE = { posts: [], filter: "*", settings: null };
let objectUrls = [];

function releaseUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function counts(posts) {
  const c = {};
  for (const p of posts) c[p.category || UNCATEGORIZED] = (c[p.category || UNCATEGORIZED] || 0) + 1;
  return c;
}

async function load() {
  STATE.settings = await getSettings();
  STATE.posts = await getAllPosts();
  $("summary").textContent =
    `${STATE.posts.length} post(s) across ${Object.keys(counts(STATE.posts)).length} categories`;
  renderFilters();
  await renderGrid();
}

function categoryNames() {
  const names = Object.keys(STATE.settings.categories);
  if (!names.includes(UNCATEGORIZED)) names.push(UNCATEGORIZED);
  return names;
}

function renderFilters() {
  const c = counts(STATE.posts);
  const cats = Object.keys(c).sort((a, b) => c[b] - c[a]);
  const chips = [["*", "All", STATE.posts.length], ...cats.map((k) => [k, k, c[k]])];
  $("filters").innerHTML = chips
    .map(([v, label, n]) =>
      `<span class="chip ${STATE.filter === v ? "active" : ""}" data-v="${encodeURIComponent(v)}">${label} (${n})</span>`
    )
    .join("");
  $("filters").querySelectorAll(".chip").forEach((ch) => {
    ch.onclick = () => {
      STATE.filter = decodeURIComponent(ch.dataset.v);
      renderFilters();
      renderGrid();
    };
  });
}

function optionHtml(selected) {
  return categoryNames()
    .map((n) => `<option ${n === selected ? "selected" : ""}>${n}</option>`)
    .join("");
}

async function renderGrid() {
  releaseUrls();
  const grid = $("grid");
  const items = STATE.posts.filter((p) => STATE.filter === "*" || (p.category || UNCATEGORIZED) === STATE.filter);
  $("empty").style.display = STATE.posts.length ? "none" : "block";

  grid.innerHTML = "";
  for (const p of items) {
    const conf = Math.round((p.confidence || 0) * 100);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb" title="${p.permalink ? "Open on Instagram" : ""}"><span class="none">no preview</span></div>
      <div class="meta">
        <div class="cap">${escapeHtml((p.caption || "").slice(0, 120))}</div>
        <div class="conf"><i style="width:${conf}%"></i></div>
        <div class="muted">${conf}% · ${escapeHtml(p.category || UNCATEGORIZED)}${p.manualOverride ? " (manual)" : ""}</div>
        <div class="row">
          <select>${optionHtml(p.category || UNCATEGORIZED)}</select>
          ${p.permalink ? `<a href="${p.permalink}" target="_blank" rel="noopener">open ↗</a>` : `<span class="muted">no link</span>`}
        </div>
      </div>`;
    grid.appendChild(card);

    // clicking the thumbnail opens the original post
    const thumbEl = card.querySelector(".thumb");
    if (p.permalink) {
      thumbEl.style.cursor = "pointer";
      thumbEl.addEventListener("click", () => window.open(p.permalink, "_blank", "noopener"));
    }

    // thumbnail image
    getThumbnail(p.id).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      thumbEl.innerHTML = `<img loading="lazy" src="${url}" />`;
    });

    // re-categorize
    const sel = card.querySelector("select");
    sel.onchange = async () => {
      p.category = sel.value;
      p.manualOverride = true;
      p.confidence = p.confidence || 1;
      await putPost(p);
      renderFilters();
      renderGrid();
    };
  }
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

// --- sync controls (mirror the popup) -----------------------------------
function setBusy(busy) {
  $("sync").disabled = busy;
  $("cancel").style.display = busy ? "inline-block" : "none";
  $("progress").style.display = busy ? "block" : "none";
}
function setMsg(t, err = false) {
  const m = $("msg");
  m.textContent = t || "";
  m.classList.toggle("err", err);
}

$("sync").onclick = async () => {
  setBusy(true);
  setMsg("Starting…");
  $("bar").style.width = "8%";
  const limit = $("limit").value.trim() ? parseInt($("limit").value, 10) : undefined;
  await chrome.runtime.sendMessage({ type: MSG.START_SYNC, limit });
};
$("cancel").onclick = () => chrome.runtime.sendMessage({ type: MSG.CANCEL_SYNC });

chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.type) return;
  if (m.type === MSG.PROGRESS) {
    setMsg(m.message || "");
    $("bar").style.width = m.total ? Math.round((m.done / m.total) * 100) + "%" : "40%";
  } else if (m.type === MSG.DONE) {
    setBusy(false);
    $("bar").style.width = "100%";
    setMsg(`Done — ${m.total} post(s).`);
    load();
  } else if (m.type === MSG.ERROR) {
    setBusy(false);
    setMsg(`${m.where}: ${m.message}`, true);
  }
});

// --- settings drawer ----------------------------------------------------
$("settingsBtn").onclick = () => openSettings();
$("closeSettings").onclick = () => ($("drawer").hidden = true);

async function openSettings() {
  const s = STATE.settings || (await getSettings());
  $("threshold").value = s.threshold;
  $("thVal").textContent = s.threshold;
  $("captionWeight").value = s.captionWeight;
  $("cwVal").textContent = s.captionWeight;
  $("categories").value = JSON.stringify(s.categories, null, 2);
  $("drawer").hidden = false;
}
$("threshold").oninput = (e) => ($("thVal").textContent = e.target.value);
$("captionWeight").oninput = (e) => ($("cwVal").textContent = e.target.value);

$("saveSettings").onclick = async () => {
  let categories;
  try {
    categories = JSON.parse($("categories").value);
  } catch (e) {
    $("settingsMsg").textContent = "Categories must be valid JSON: " + e.message;
    return;
  }
  const captionWeight = parseFloat($("captionWeight").value);
  STATE.settings = await saveSettings({
    threshold: parseFloat($("threshold").value),
    captionWeight,
    imageWeight: 1 - captionWeight,
    categories,
  });
  $("settingsMsg").textContent = "Saved. Use “Re-classify all” to apply to existing posts.";
};

$("reclassify").onclick = async () => {
  $("settingsMsg").textContent = "Re-classifying…";
  await chrome.runtime.sendMessage({ type: MSG.RECLASSIFY_ALL });
};

$("clearData").onclick = async () => {
  if (!confirm("Delete all synced posts and thumbnails?")) return;
  await clearAll();
  $("drawer").hidden = true;
  load();
};

load();
