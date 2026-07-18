import { MSG } from "../lib/messaging.js";
import { getSettings, saveSettings } from "../lib/settings.js";
import { UNCATEGORIZED } from "../lib/categories.js";
import { getAllPosts, getThumbnail, putPost, clearAll } from "../lib/db.js";
import { getLogs, clearLogs } from "../lib/log.js";

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
    const kws = (p.keywords && p.keywords.length ? p.keywords : []).slice(0, 6);
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="thumb"><span class="none">no preview</span></div>
      <div class="meta">
        <div class="cat">${escapeHtml(p.category || UNCATEGORIZED)}${p.manualOverride ? ` <span class="manual">· edited</span>` : ""}</div>
        <ul class="kw">${kws.map((k) => `<li>${escapeHtml(k)}</li>`).join("") || `<li style="color:var(--faint)">no keywords</li>`}</ul>
        <div class="foot">
          <span class="conf"><i style="width:${conf}%"></i></span>
          ${p.permalink ? `<a class="open" href="${p.permalink}" target="_blank" rel="noopener">open ↗</a>` : ""}
        </div>
        <select class="recat" title="Re-categorize">${optionHtml(p.category || UNCATEGORIZED)}</select>
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

load();
