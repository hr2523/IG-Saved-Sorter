import { MSG } from "../lib/messaging.js";
import { getSettings, saveSettings } from "../lib/settings.js";
import { UNCATEGORIZED, cloneCategories, TAXONOMY_VERSION } from "../lib/categories.js";
import { getAllPosts, getThumbnail, putPost, clearAll } from "../lib/db.js";
import { getLogs, clearLogs } from "../lib/log.js";

const $ = (id) => document.getElementById(id);

let STATE = { posts: [], filter: "*", search: "", showKeywords: false, settings: null };
let objectUrls = [];

// Multi-label read with legacy fallback: older records have only `category`.
function postCategories(p) {
  return (p.categories && p.categories.length) ? p.categories : [p.category || UNCATEGORIZED];
}

function releaseUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function counts(posts) {
  const c = {};
  for (const p of posts) for (const cat of postCategories(p)) c[cat] = (c[cat] || 0) + 1;
  return c;
}

function applyLayout(s) {
  const r = document.documentElement.style;
  r.setProperty("--card-radius", (s.cardRadius ?? 6) + "px");
  r.setProperty("--card-min", (s.cardMinWidth ?? 210) + "px");
  r.setProperty("--grid-gap", (s.gridGap ?? 22) + "px");
}

async function load() {
  STATE.settings = await getSettings();
  applyLayout(STATE.settings);
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

function matchesSearch(p) {
  const q = STATE.search;
  if (!q) return true;
  if (p.keywords && p.keywords.some((k) => k.toLowerCase().includes(q))) return true;
  if ((p.caption || "").toLowerCase().includes(q)) return true;
  return postCategories(p).some((c) => c.toLowerCase().includes(q));
}

// Apply a manual multi-label edit and persist it (marks the post as overridden,
// so a later Re-classify all leaves it alone).
function setCategories(p, cats) {
  p.categories = cats.length ? cats : [UNCATEGORIZED];
  p.category = p.categories[0];
  p.manualOverride = true;
  p.confidence = p.confidence || 1;
  return putPost(p).then(() => { renderFilters(); renderGrid(); });
}

async function renderGrid() {
  releaseUrls();
  const grid = $("grid");
  const items = STATE.posts.filter(
    (p) => (STATE.filter === "*" || postCategories(p).includes(STATE.filter)) && matchesSearch(p)
  );
  $("empty").style.display = STATE.posts.length ? "none" : "block";

  grid.innerHTML = "";
  for (const p of items) {
    const conf = Math.round((p.confidence || 0) * 100);
    const kws = (p.keywords && p.keywords.length ? p.keywords : []).slice(0, 6);
    const cats = postCategories(p);
    const catInner = p.status === "error"
      ? `<span class="manual" title="${escapeHtml(p.error || "classification error")}">⚠ error</span>`
      : p.status === "needs_thumb"
      ? `<span class="manual">⋯ no thumbnail</span>`
      : cats.map((c) => `<span class="catchip">${escapeHtml(c)}</span>`).join("");
    const addOptions = categoryNames()
      .filter((n) => !cats.includes(n))
      .map((n) => `<option>${escapeHtml(n)}</option>`)
      .join("");
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb"><span class="none">no preview</span></div>
      <div class="meta">
        <div class="cat">${catInner}${p.manualOverride ? ` <span class="manual">· edited</span>` : ""}</div>
        <details class="kw"${STATE.showKeywords ? " open" : ""}>
          <summary>keywords${kws.length ? ` (${kws.length})` : ""}</summary>
          <ul>${kws.map((k) => `<li>${escapeHtml(k)}</li>`).join("") || `<li style="color:var(--faint)">no keywords</li>`}</ul>
        </details>
        <div class="foot">
          <span class="conf"><i style="width:${conf}%"></i></span>
          ${p.permalink ? `<a class="open" href="${p.permalink}" target="_blank" rel="noopener">open ↗</a>` : ""}
        </div>
        <div class="catedit">
          ${cats.map((c) => `<span class="catchip edit" data-c="${encodeURIComponent(c)}">${escapeHtml(c)} <b>×</b></span>`).join("")}
          <select class="addcat" title="Add category"><option value="">+ add…</option>${addOptions}</select>
        </div>
      </div>`;
    grid.appendChild(card);

    // clicking the thumbnail opens the original post
    const thumbEl = card.querySelector(".thumb");
    if (p.permalink) {
      thumbEl.addEventListener("click", () => window.open(p.permalink, "_blank", "noopener"));
    } else {
      thumbEl.style.cursor = "default";
    }

    // thumbnail image
    getThumbnail(p.id).then((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      thumbEl.innerHTML = `<img loading="lazy" src="${url}" />`;
    });

    // multi-label re-categorize: remove a chip, or add a category
    card.querySelectorAll(".catchip.edit b").forEach((x) => {
      x.parentElement.onclick = () => {
        const c = decodeURIComponent(x.parentElement.dataset.c);
        setCategories(p, postCategories(p).filter((k) => k !== c));
      };
    });
    card.querySelector(".addcat").onchange = (e) => {
      if (e.target.value) setCategories(p, [...postCategories(p), e.target.value]);
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

// keyword search over the sorter's tags (+ caption + category names); client-side,
// wired once so it survives the ~1.5s load() refreshes during a sync.
$("search").oninput = (e) => {
  STATE.search = e.target.value.trim().toLowerCase();
  renderFilters();
  renderGrid();
};

let lastRefresh = 0;
chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.type) return;
  if (m.type === MSG.PROGRESS) {
    setBusy(true);
    setMsg(m.message || "");
    $("bar").style.width = m.total ? Math.round((m.done / m.total) * 100) + "%" : "40%";
    // Refresh the grid as classification lands (throttled), so categories show
    // up progressively and don't depend on the final DONE (the SW may sleep).
    if (m.phase === "classify" && Date.now() - lastRefresh > 1500) {
      lastRefresh = Date.now();
      load();
    }
  } else if (m.type === MSG.DONE) {
    setBusy(false);
    $("reclassify").disabled = false;
    $("bar").style.width = "100%";
    setMsg(m.fetchComplete === false
      ? `Fetched ${m.fetched ?? m.total} — may be incomplete. Click Sync to resume, or “Force full re-sync” in Settings.`
      : `Done — ${m.total} post(s).`);
    load();
  } else if (m.type === MSG.ERROR) {
    setBusy(false);
    $("reclassify").disabled = false;
    setMsg(`${m.where}: ${m.message}`, true);
  }
});

// --- settings drawer ----------------------------------------------------
$("settingsBtn").onclick = () => openSettings();
$("closeSettings").onclick = () => ($("drawer").hidden = true);

async function renderLogs() {
  const logs = await getLogs();
  const el = $("logs");
  if (!logs.length) { el.textContent = "(no logs yet)"; return; }
  el.innerHTML = logs
    .map((l) => `<div class="${l.level === "error" ? "e" : ""}">${escapeHtml(l.t)}  ${escapeHtml(l.msg)}</div>`)
    .join("");
  el.scrollTop = el.scrollHeight;
}
$("copyLogs").onclick = async () => {
  const logs = await getLogs();
  const text = logs.map((l) => `${l.t} [${l.level}] ${l.msg}`).join("\n");
  try { await navigator.clipboard.writeText(text); $("settingsMsg").textContent = "Logs copied."; }
  catch (_) { $("settingsMsg").textContent = "Copy failed — select the text manually."; }
};
$("refreshLogs").onclick = () => renderLogs();
$("clearLogs").onclick = async () => { await clearLogs(); renderLogs(); };

async function openSettings() {
  renderLogs();
  const s = STATE.settings || (await getSettings());
  $("cardRadius").value = s.cardRadius; $("crVal").textContent = s.cardRadius;
  $("cardMinWidth").value = s.cardMinWidth; $("cmVal").textContent = s.cardMinWidth;
  $("gridGap").value = s.gridGap; $("ggVal").textContent = s.gridGap;
  $("threshold").value = s.threshold;
  $("thVal").textContent = s.threshold;
  $("captionWeight").value = s.captionWeight;
  $("cwVal").textContent = s.captionWeight;
  $("categories").value = JSON.stringify(s.categories, null, 2);
  $("drawer").hidden = false;
}
$("threshold").oninput = (e) => ($("thVal").textContent = e.target.value);
$("captionWeight").oninput = (e) => ($("cwVal").textContent = e.target.value);
// Layout sliders preview live on the grid behind the drawer.
function previewLayout() {
  applyLayout({
    cardRadius: +$("cardRadius").value,
    cardMinWidth: +$("cardMinWidth").value,
    gridGap: +$("gridGap").value,
  });
}
$("cardRadius").oninput = (e) => { $("crVal").textContent = e.target.value; previewLayout(); };
$("cardMinWidth").oninput = (e) => { $("cmVal").textContent = e.target.value; previewLayout(); };
$("gridGap").oninput = (e) => { $("ggVal").textContent = e.target.value; previewLayout(); };

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
    cardRadius: parseInt($("cardRadius").value, 10),
    cardMinWidth: parseInt($("cardMinWidth").value, 10),
    gridGap: parseInt($("gridGap").value, 10),
    categories,
  });
  applyLayout(STATE.settings);
  $("settingsMsg").textContent = "Saved. (Layout applies instantly; category/threshold changes need “Re-classify all”.)";
};

$("resetCats").onclick = async () => {
  STATE.settings = await saveSettings({ categories: cloneCategories(), taxonomyVersion: TAXONOMY_VERSION });
  $("categories").value = JSON.stringify(STATE.settings.categories, null, 2);
  $("settingsMsg").textContent = "Categories reset to defaults. Click “Re-classify all” to apply.";
};

$("reclassify").onclick = async () => {
  const btn = $("reclassify");
  if (btn.disabled) return;
  btn.disabled = true;
  $("settingsMsg").textContent = "Re-classifying…";
  setBusy(true);
  const res = await chrome.runtime.sendMessage({ type: MSG.RECLASSIFY_ALL });
  if (res && res.ok === false) {
    $("settingsMsg").textContent = res.error || "Could not start.";
    setBusy(false);
    btn.disabled = false;
  }
  // otherwise the DONE broadcast re-enables via the message handler
};

$("clearData").onclick = async () => {
  if (!confirm("Delete all synced posts and thumbnails?")) return;
  await clearAll();
  $("drawer").hidden = true;
  load();
};

$("resetSync").onclick = async () => {
  if (!confirm("Re-crawl all saved posts from scratch? Keeps existing posts — use this if Sync stopped short of your real total.")) return;
  await chrome.runtime.sendMessage({ type: MSG.RESET_SYNC });
  $("drawer").hidden = true;
  setBusy(true);
  setMsg("Re-syncing from scratch…");
  $("bar").style.width = "8%";
  const limit = $("limit").value.trim() ? parseInt($("limit").value, 10) : undefined;
  await chrome.runtime.sendMessage({ type: MSG.START_SYNC, limit });
};

// --- theme (auto -> light -> dark) --------------------------------------
const THEMES = ["auto", "light", "dark"];
const THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  $("themeBtn").textContent = THEME_ICON[t];
  localStorage.setItem("igss-theme", t);
}
$("themeBtn").onclick = () => {
  const cur = localStorage.getItem("igss-theme") || "auto";
  applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
};
applyTheme(localStorage.getItem("igss-theme") || "auto");

// --- keyword visibility (global show/hide; per-card <details> handles the rest) ---
function applyKwBtn() { $("kwBtn").classList.toggle("active", STATE.showKeywords); }
$("kwBtn").onclick = () => {
  STATE.showKeywords = !STATE.showKeywords;
  localStorage.setItem("igss-kw", STATE.showKeywords ? "1" : "0");
  applyKwBtn();
  renderGrid();
};
STATE.showKeywords = localStorage.getItem("igss-kw") === "1";
applyKwBtn();

load();
