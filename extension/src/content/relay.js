// ISOLATED-world relay. The MAIN-world interceptor can't reach chrome.runtime,
// so it postMessages captures to the page; this content script (which DOES have
// chrome.runtime) forwards them to the service worker.

(() => {
  "use strict";
  if (window.__igssRelay) return;
  window.__igssRelay = true;

  window.addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.__igss !== true) return;
    if (event.source !== window) return;
    try {
      chrome.runtime.sendMessage({ type: "IG_CAPTURE", kind: d.kind, template: d.template, json: d.json });
    } catch (_) {}
  });
})();
