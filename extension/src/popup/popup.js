import { MSG } from "../lib/messaging.js";

const $ = (id) => document.getElementById(id);
const msg = $("msg");
const progress = $("progress");
const bar = $("bar");

function setMsg(text, isErr = false) {
  msg.textContent = text || "";
  msg.classList.toggle("err", isErr);
}

function setBusy(busy) {
  $("sync").disabled = busy;
  $("cancel").style.display = busy ? "block" : "none";
  progress.style.display = busy ? "block" : "none";
}

try {
  $("ver").textContent = "v" + chrome.runtime.getManifest().version;
} catch (_) {}

async function refreshCount() {
  try {
    const s = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
    if (s && s.ok) $("count").textContent = `${s.total} post(s) stored`;
    if (s && s.syncing) setBusy(true);
  } catch (_) {}
}

$("sync").onclick = async () => {
  setBusy(true);
  setMsg("Starting…");
  bar.style.width = "8%";
  const limitVal = $("limit").value.trim();
  const limit = limitVal ? parseInt(limitVal, 10) : undefined;
  try {
    await chrome.runtime.sendMessage({ type: MSG.START_SYNC, limit });
  } catch (e) {
    setMsg(String(e.message || e), true);
    setBusy(false);
  }
};

$("cancel").onclick = async () => {
  await chrome.runtime.sendMessage({ type: MSG.CANCEL_SYNC });
  setMsg("Cancelling…");
};

$("open").onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/app/index.html") });
};

$("clear").onclick = async () => {
  if (!confirm("Delete all synced posts and thumbnails?")) return;
  await chrome.runtime.sendMessage({ type: MSG.CLEAR_DATA });
  setMsg("Cleared.");
  refreshCount();
};

$("resync").onclick = async () => {
  if (!confirm("Re-crawl all saved posts from scratch? Keeps existing posts — use this if Sync stopped short of your real total.")) return;
  await chrome.runtime.sendMessage({ type: MSG.RESET_SYNC });
  setBusy(true);
  setMsg("Re-syncing from scratch…");
  bar.style.width = "8%";
  const limitVal = $("limit").value.trim();
  const limit = limitVal ? parseInt(limitVal, 10) : undefined;
  try {
    await chrome.runtime.sendMessage({ type: MSG.START_SYNC, limit });
  } catch (e) {
    setMsg(String(e.message || e), true);
    setBusy(false);
  }
};

chrome.runtime.onMessage.addListener((m) => {
  if (!m || !m.type) return;
  if (m.type === MSG.PROGRESS) {
    setMsg(m.message || "");
    if (m.total) bar.style.width = Math.round((m.done / m.total) * 100) + "%";
    else bar.style.width = "40%";
  } else if (m.type === MSG.DONE) {
    setBusy(false);
    bar.style.width = "100%";
    setMsg(m.fetchComplete === false
      ? `Fetched ${m.fetched ?? m.total} — may be incomplete. Sync again to resume.`
      : `Done — ${m.total} post(s). Open the gallery to review.`);
    refreshCount();
  } else if (m.type === MSG.ERROR) {
    setBusy(false);
    setMsg(`${m.where}: ${m.message}`, true);
  }
});

refreshCount();
