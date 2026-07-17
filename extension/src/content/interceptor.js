// MAIN-world interceptor. Runs in the instagram.com page context and hooks
// fetch + XMLHttpRequest so we can SEE the exact saved-feed request Instagram
// makes (endpoint-agnostic — survives their GraphQL/REST changes) and read its
// JSON response. MAIN world has no chrome.* APIs, so it hands captures to the
// ISOLATED relay via window.postMessage. Everything is wrapped in try/catch so
// it can never break the Instagram page.

(() => {
  "use strict";
  if (window.__igssIntercept) return;
  window.__igssIntercept = true;

  function post(payload) {
    try {
      window.postMessage(Object.assign({ __igss: true }, payload), "*");
    } catch (_) {}
  }

  // Does this JSON look like a page of saved posts?
  function looksSaved(j) {
    try {
      if (!j || typeof j !== "object") return false;
      if (Array.isArray(j.items) && j.items.length) {
        const m = j.items[0].media || j.items[0];
        if (m && (m.code || m.pk || m.id)) return true;
      }
      const edges =
        j.data?.user?.edge_saved_media?.edges ||
        j.data?.xdt_api__v1__feed__saved__posts_connection?.edges ||
        j.data?.saved_posts?.edges;
      if (Array.isArray(edges) && edges.length) return true;
    } catch (_) {}
    return false;
  }

  function headersToObject(h, into) {
    into = into || {};
    try {
      if (!h) return into;
      if (typeof h.forEach === "function") h.forEach((v, k) => (into[k] = v));
      else if (Array.isArray(h)) h.forEach(([k, v]) => (into[k] = v));
      else Object.assign(into, h);
    } catch (_) {}
    return into;
  }

  async function buildTemplate(input, init) {
    let method = "GET";
    let url = "";
    let headers = {};
    let body = null;
    try {
      if (input && typeof input === "object" && input.url) {
        method = input.method || "GET";
        url = input.url;
        headersToObject(input.headers, headers);
        try { body = await input.clone().text(); } catch (_) {}
      } else {
        url = String(input);
      }
      if (init) {
        if (init.method) method = init.method;
        headersToObject(init.headers, headers);
        if (init.body != null && typeof init.body === "string") body = init.body;
      }
    } catch (_) {}
    return { method, url, headers, body };
  }

  // --- fetch hook ---------------------------------------------------------
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        p.then((res) => {
          try {
            const url = typeof input === "string" ? input : input && input.url;
            if (url && /instagram\.com/.test(url)) {
              res.clone().json().then((j) => {
                if (looksSaved(j)) {
                  buildTemplate(input, init).then((template) =>
                    post({ kind: "page", template, json: j })
                  );
                }
              }).catch(() => {});
            }
          } catch (_) {}
        }).catch(() => {});
      } catch (_) {}
      return p;
    };
  }

  // --- XHR hook -----------------------------------------------------------
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const setH = XHR.prototype.setRequestHeader;
    XHR.prototype.open = function (method, url) {
      this.__igss = { method, url, headers: {} };
      return open.apply(this, arguments);
    };
    XHR.prototype.setRequestHeader = function (k, v) {
      try { if (this.__igss) this.__igss.headers[k] = v; } catch (_) {}
      return setH.apply(this, arguments);
    };
    XHR.prototype.send = function (body) {
      try {
        this.addEventListener("load", () => {
          try {
            const meta = this.__igss;
            if (!meta || !/instagram\.com/.test(meta.url)) return;
            const j = JSON.parse(this.responseText);
            if (looksSaved(j)) {
              post({
                kind: "page",
                template: {
                  method: meta.method || "GET",
                  url: meta.url,
                  headers: meta.headers || {},
                  body: typeof body === "string" ? body : null,
                },
                json: j,
              });
            }
          } catch (_) {}
        });
      } catch (_) {}
      return send.apply(this, arguments);
    };
  }

  post({ kind: "ready" });
})();
