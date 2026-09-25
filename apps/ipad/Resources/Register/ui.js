"use strict";
(() => {
  // apps/ui/public/src/routes.mjs
  var NAV = [
    { route: "bar", label: "Bar service", short: "Bar", group: "run", icon: "\u{1F378}", primary: "Open a tab and serve drinks" },
    { route: "actions", label: "Action Center", short: "Home", group: "run", icon: "\u{1F514}", primary: "Resolve what needs attention" },
    { route: "register", label: "Register", short: "Sell", group: "run", icon: "\u{1F4B3}", primary: "Start a sale" },
    { route: "scan", label: "Scan", short: "Scan", group: "run", icon: "\u{1F4F7}", primary: "Scan an item" },
    { route: "stock", label: "Stock", short: "Stock", group: "run", icon: "\u{1F4E6}", primary: "Check on-hand" },
    { route: "counts", label: "Counts", short: "Counts", group: "run", icon: "\u{1F4CB}", primary: "Start a count" },
    { route: "transfers", label: "Transfers", short: "Transfers", group: "run", icon: "\u{1F501}", primary: "Move stock" },
    { route: "shows", label: "Events", short: "Events", group: "run", icon: "\u{1F3AA}", primary: "Plan an event" },
    { route: "orders", label: "Orders", short: "Orders", group: "sell", icon: "\u{1F9FE}", primary: "Find an order" },
    { route: "buying", label: "Buying", short: "Buying", group: "sell", icon: "\u{1F6D2}", primary: "Reorder stock" },
    { route: "customers", label: "Guests", short: "Guests", group: "sell", icon: "\u{1F464}", primary: "Find a guest" },
    { route: "marketing", label: "Marketing", short: "Marketing", group: "sell", icon: "\u2709\uFE0F", primary: "Send an offer" },
    { route: "money", label: "Money", short: "Money", group: "back", icon: "\u{1F4B5}", primary: "See the numbers" },
    { route: "team", label: "Team", short: "Team", group: "back", icon: "\u{1F9D1}\u200D\u{1F91D}\u200D\u{1F9D1}", primary: "Manage the team" },
    { route: "imports", label: "Imports", short: "Imports", group: "back", icon: "\u2B07\uFE0F", primary: "Check data sync" },
    { route: "settings", label: "Settings", short: "Settings", group: "back", icon: "\u2699\uFE0F", primary: "Set things up" }
  ];
  var DEFAULT_ROUTE = "bar";
  var NAV_GROUPS = [
    { key: "run", label: "Club operations" },
    { key: "sell", label: "Guest services" },
    { key: "back", label: "Club office" }
  ];
  function parseHash(hash) {
    const raw = (hash || "").replace(/^#\/?/, "");
    const parts = raw.split("/").filter(Boolean);
    const route = parts[0] || DEFAULT_ROUTE;
    return { route, params: parts.slice(1) };
  }
  function hashFor(route, ...params) {
    return `#/${[route, ...params].filter(Boolean).join("/")}`;
  }
  function navRoutes() {
    return NAV.map((n) => n.route);
  }

  // apps/ui/public/src/format.mjs
  var PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };
  function priorityRank(priority) {
    return PRIORITY_ORDER[priority] ?? 99;
  }
  function priorityLabel(priority) {
    if (!priority) return "Normal";
    return String(priority).replace(/^\w/, (c) => c.toUpperCase());
  }
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
  }
  function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const mm = String(d.getUTCMinutes()).padStart(2, "0");
    return `${formatDate(iso)} ${hh}:${mm} UTC`;
  }
  function dataAsOf(iso) {
    return iso ? `Data as of ${formatDate(iso)}` : "Data as of \u2014 (not yet loaded)";
  }

  // apps/ui/public/js/dom.js
  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === void 0 || v === false) continue;
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "dataset") Object.assign(node.dataset, v);
      else node.setAttribute(k, v === true ? "" : String(v));
    }
    const kids = Array.isArray(children) ? children : [children];
    for (const c of kids) {
      if (c === null || c === void 0 || c === false) continue;
      node.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return node;
  }
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }
  var $ = (sel, root2 = document) => root2.querySelector(sel);
  var $$ = (sel, root2 = document) => Array.from(root2.querySelectorAll(sel));
  function announce(message) {
    const region = $("#live-region");
    if (region) {
      region.textContent = "";
      requestAnimationFrame(() => region.textContent = message);
    }
  }
  function toast(message, kind = "info", ms = 3200) {
    const root2 = $("#toast-root");
    if (!root2) return;
    const t = el("div", { class: `toast ${kind === "info" ? "" : kind}`, role: "status" }, message);
    root2.append(t);
    announce(message);
    setTimeout(() => {
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 250);
    }, ms);
  }
  function flash(kind) {
    const f = $("#scan-flash");
    if (!f) return;
    f.classList.remove("ok", "err");
    void f.offsetWidth;
    f.classList.add(kind);
    setTimeout(() => f.classList.remove(kind), 220);
  }

  // apps/ui/public/src/queue.mjs
  function initialState() {
    return { items: [] };
  }
  function enqueue(state2, m) {
    if (!m.id) throw new Error("enqueue: id required");
    if (!m.idempotencyKey) throw new Error("enqueue: idempotencyKey required");
    const item = {
      id: m.id,
      url: m.url,
      method: m.method || "POST",
      body: m.body ?? null,
      idempotencyKey: m.idempotencyKey,
      queuedAt: m.queuedAt,
      actorId: m.actorId ?? null,
      state: "queued",
      attempts: 0,
      error: null,
      conflict: null
    };
    return { ...state2, items: [...state2.items, item] };
  }
  function patch(state2, id, fields) {
    return {
      ...state2,
      items: state2.items.map((it) => it.id === id ? { ...it, ...fields } : it)
    };
  }
  function nextQueued(state2) {
    return state2.items.find((it) => it.state === "queued") ?? null;
  }
  function markInflight(state2, id) {
    return patch(state2, id, { state: "inflight", attempts: (find(state2, id)?.attempts ?? 0) + 1 });
  }
  function markSuccess(state2, id) {
    return { ...state2, items: state2.items.filter((it) => it.id !== id) };
  }
  function markFailure(state2, id, error) {
    return patch(state2, id, { state: "failed", error: error ?? "send failed" });
  }
  function markConflict(state2, id, serverBody) {
    return patch(state2, id, { state: "conflict", conflict: serverBody ?? null });
  }
  function retryAll(state2) {
    return {
      ...state2,
      items: state2.items.map(
        (it) => it.state === "failed" ? { ...it, state: "queued", error: null } : it
      )
    };
  }
  function find(state2, id) {
    return state2.items.find((it) => it.id === id) ?? null;
  }
  function conflicts(state2) {
    return state2.items.filter((it) => it.state === "conflict");
  }
  function counts(state2) {
    const c = { queued: 0, inflight: 0, failed: 0, conflict: 0 };
    for (const it of state2.items) c[it.state] = (c[it.state] ?? 0) + 1;
    return c;
  }
  function syncStatus(state2) {
    const c = counts(state2);
    if (c.failed > 0 || c.conflict > 0) return "failed";
    if (c.queued > 0 || c.inflight > 0) return "queued";
    return "synced";
  }
  function pendingCount(state2) {
    return state2.items.length;
  }

  // apps/ui/public/js/offline.js
  var DB_NAME = "mags-os";
  var STORE = "mutation-queue";
  var idb = null;
  var state = initialState();
  var listeners = /* @__PURE__ */ new Set();
  var sender = null;
  var draining = false;
  function openIdb() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
  }
  function tx(mode) {
    return idb.transaction(STORE, mode).objectStore(STORE);
  }
  async function persistItem(item) {
    if (!idb) return;
    await new Promise((res) => {
      const r = tx("readwrite").put(item);
      r.onsuccess = res;
      r.onerror = res;
    });
  }
  async function deleteItem(id) {
    if (!idb) return;
    await new Promise((res) => {
      const r = tx("readwrite").delete(id);
      r.onsuccess = res;
      r.onerror = res;
    });
  }
  async function loadAll() {
    if (!idb) return [];
    return new Promise((res) => {
      const r = tx("readonly").getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror = () => res([]);
    });
  }
  function emit() {
    const snapshot = {
      status: syncStatus(state),
      pending: pendingCount(state),
      counts: counts(state),
      conflicts: conflicts(state),
      items: state.items.slice()
    };
    listeners.forEach((fn) => {
      try {
        fn(snapshot);
      } catch {
      }
    });
  }
  function onQueueChange(fn) {
    listeners.add(fn);
    fn(currentSnapshot());
    return () => listeners.delete(fn);
  }
  function currentSnapshot() {
    return {
      status: syncStatus(state),
      pending: pendingCount(state),
      counts: counts(state),
      conflicts: conflicts(state),
      items: state.items.slice()
    };
  }
  async function initOfflineQueue(sendRaw2) {
    sender = sendRaw2;
    idb = await openIdb();
    const items = await loadAll();
    state = { items: items.map((it) => it.state === "inflight" ? { ...it, state: "queued" } : it) };
    emit();
    window.addEventListener("online", () => {
      setOfflineBadge(false);
      drain();
    });
    window.addEventListener("offline", () => setOfflineBadge(true));
    setOfflineBadge(!navigator.onLine);
    if (navigator.onLine || document.body.dataset.nativePos === "true") drain();
  }
  function setOfflineBadge(off) {
    const b = document.getElementById("offline-badge");
    if (b) b.hidden = !off || document.body.dataset.nativePos === "true";
  }
  async function queueMutation(m) {
    state = enqueue(state, m);
    await persistItem(find(state, m.id));
    emit();
    if (navigator.onLine || document.body.dataset.nativePos === "true") drain();
    return m.id;
  }
  async function drain() {
    if (draining || !sender) return;
    draining = true;
    try {
      let next;
      while (next = nextQueued(state)) {
        state = markInflight(state, next.id);
        await persistItem(find(state, next.id));
        emit();
        let result;
        try {
          result = await sender(next);
        } catch {
          state = markFailure(state, next.id, "network unavailable");
          await persistItem(find(state, next.id));
          emit();
          break;
        }
        if (result.ok) {
          state = markSuccess(state, next.id);
          await deleteItem(next.id);
        } else if (result.status === 409) {
          state = markConflict(state, next.id, result.body);
          await persistItem(find(state, next.id));
        } else {
          state = markFailure(state, next.id, describe(result));
          await persistItem(find(state, next.id));
        }
        emit();
      }
    } finally {
      draining = false;
    }
  }
  function describe(result) {
    const b = result.body;
    if (b && b.error && b.error.message) return b.error.message;
    return `server returned ${result.status}`;
  }
  async function retryFailed() {
    state = retryAll(state);
    for (const it of state.items) await persistItem(it);
    emit();
    drain();
  }

  // apps/ui/public/js/api.js
  var BASE = "/api";
  var TENANT_ID = null;
  var ACTOR_ID = null;
  function setAuthenticatedActor(id) {
    ACTOR_ID = id || null;
  }
  function authenticatedActorId() {
    return ACTOR_ID;
  }
  var ApiError = class extends Error {
    constructor(message, code, status, details) {
      super(message || "request failed");
      this.code = code || "error";
      this.status = status || 0;
      this.details = details || null;
    }
  };
  function newIdempotencyKey() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `k_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
  function buildUrl(path, query) {
    const url = path.startsWith("/api") ? path : `${BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    if (!query) return url;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === void 0 || v === null || v === "") continue;
      qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `${url}?${s}` : url;
  }
  function baseHeaders(mutating, expectedActorId = ACTOR_ID) {
    const h = { accept: "application/json" };
    if (TENANT_ID) h["x-tenant-id"] = TENANT_ID;
    if (expectedActorId) h["x-pos-expected-user-id"] = expectedActorId;
    if (mutating) h["x-mags-csrf"] = "1";
    return h;
  }
  async function parse(res) {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        return await res.json();
      } catch {
        return null;
      }
    }
    return { _text: await res.text() };
  }
  function signalExpiredSession(path, status) {
    if (status === 401 && path.startsWith("/api/") && !path.startsWith("/api/pos/auth")) {
      window.dispatchEvent(new CustomEvent("mags:auth-required"));
    }
  }
  async function apiGet(path, query) {
    const url = buildUrl(path, query);
    const res = await fetch(url, { headers: baseHeaders(false), credentials: "same-origin" });
    const body = await parse(res);
    if (!res.ok) {
      signalExpiredSession(url, res.status);
      throw fromBody(body, res.status);
    }
    return body;
  }
  async function getData(path, query) {
    return (await apiGet(path, query)).data;
  }
  async function getList(path, query) {
    const body = await apiGet(path, query);
    return { data: body.data ?? [], limit: body.limit, offset: body.offset };
  }
  function fromBody(body, status) {
    const e = body && body.error;
    return new ApiError(e?.message, e?.code, status, e?.details);
  }
  async function sendRaw(m) {
    const authRequest = m.url.startsWith("/api/pos/auth");
    if (!authRequest && !m.actorId) {
      return {
        ok: false,
        status: 409,
        body: { error: { message: "Queued change has no operator attribution; review it before retrying.", code: "operator_attribution_missing" } }
      };
    }
    const headers = baseHeaders(true, m.actorId || null);
    if (m.body !== null && m.body !== void 0) headers["content-type"] = "application/json";
    if (m.idempotencyKey) headers["idempotency-key"] = m.idempotencyKey;
    const res = await fetch(m.url, {
      method: m.method || "POST",
      headers,
      credentials: "same-origin",
      body: m.body !== null && m.body !== void 0 ? JSON.stringify(m.body) : void 0
    });
    const body = await parse(res);
    signalExpiredSession(m.url, res.status);
    return { ok: res.ok, status: res.status, body };
  }
  async function mutate(path, method, body, opts = {}) {
    const url = buildUrl(path, opts.query);
    let idempotencyKey = opts.idempotencyKey;
    if (!idempotencyKey && opts.idempotency) idempotencyKey = newIdempotencyKey();
    if (idempotencyKey && body && typeof body === "object" && opts.bodyKeyField) {
      body = { ...body, [opts.bodyKeyField]: idempotencyKey };
    }
    const mutation = {
      id: newIdempotencyKey(),
      url,
      method,
      body: body ?? null,
      idempotencyKey: idempotencyKey || newIdempotencyKey(),
      queuedAt: (/* @__PURE__ */ new Date()).toISOString(),
      actorId: ACTOR_ID
    };
    if (opts.queueable && !navigator.onLine && document.body.dataset.nativePos !== "true") {
      await queueMutation(mutation);
      return { queued: true, id: mutation.id };
    }
    try {
      const result = await sendRaw(mutation);
      if (result.ok) return result.body;
      throw fromBody(result.body, result.status);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      if (opts.queueable) {
        await queueMutation(mutation);
        return { queued: true, id: mutation.id };
      }
      throw new ApiError("network unavailable", "offline", 0);
    }
  }

  // apps/ui/public/js/audio.js
  var ctx = null;
  function context() {
    if (ctx) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch {
      ctx = null;
    }
    return ctx;
  }
  function primeAudio() {
    const c = context();
    if (c && c.state === "suspended") c.resume().catch(() => {
    });
  }
  function tone(freq, durationMs, type = "sine", gain = 0.08) {
    const c = context();
    if (!c) return;
    if (c.state === "suspended") c.resume().catch(() => {
    });
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(c.destination);
    const now = c.currentTime;
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(1e-4, now + durationMs / 1e3);
    osc.start(now);
    osc.stop(now + durationMs / 1e3);
  }
  function beepOk() {
    tone(880, 90, "sine", 0.09);
    setTimeout(() => tone(1180, 70, "sine", 0.07), 60);
  }
  function buzzError() {
    tone(200, 240, "square", 0.09);
  }

  // apps/ui/public/js/router.js
  var views = /* @__PURE__ */ new Map();
  function registerView(route, renderer) {
    views.set(route, renderer);
  }
  var root = null;
  var ctx2 = null;
  var onRoute = null;
  function startRouter(rootEl, context2, routeChanged) {
    root = rootEl;
    ctx2 = context2;
    onRoute = routeChanged;
    window.addEventListener("hashchange", render);
    if (!location.hash) location.hash = `#/${DEFAULT_ROUTE}`;
    else render();
  }
  function navigate(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }
  async function render() {
    const { route, params } = parseHash(location.hash);
    const renderer = views.get(route) || views.get(DEFAULT_ROUTE);
    if (onRoute) onRoute(route, params);
    clear(root);
    const container = el("div", { class: "view" });
    root.append(container);
    const main2 = document.getElementById("main");
    if (main2) main2.focus({ preventScroll: true });
    try {
      await renderer(container, params, ctx2);
    } catch (err) {
      clear(container);
      container.append(
        el("div", { class: "error-banner", role: "alert" }, [
          el("strong", {}, "Something went wrong loading this screen. "),
          el("span", {}, err && err.message || "Unknown error.")
        ])
      );
    }
  }
  function unregisteredNavRoutes() {
    return navRoutes().filter((r) => !views.has(r));
  }

  // apps/ui/public/js/brand.js
  function clubBrand(className = "") {
    return el("div", { class: `club-lockup ${className}` }, [
      el("img", { src: "./brand/one-club-logo.png", class: "club-crest", alt: "", width: 64, height: 64 }),
      el("div", { class: "club-wordmark" }, [
        el("strong", {}, "BAR ONE"),
        el("span", {}, "GULF SHORES")
      ])
    ]);
  }
  var paths = {
    bar: "M4 4h16l-8 9z M12 13v7 M7 20h10",
    actions: "M4 11 12 4l8 7v9h-6v-6h-4v6H4z",
    register: "M4 5h16v14H4z M4 10h16 M7 15h4",
    scan: "M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 8v8m4-8v8m4-8v8",
    stock: "m3 7 9-4 9 4v10l-9 4-9-4z M3 7l9 4 9-4 M12 11v10",
    counts: "M9 4H5v17h14V4h-4 M9 3h6v4H9z M8 12h8m-8 4h6",
    transfers: "M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4",
    shows: "M4 5h16v16H4z M8 3v4m8-4v4M4 10h16 M8 14h2m4 0h2",
    orders: "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6m-6 4h6",
    buying: "M3 4h3l2 12h10l3-8H7 M9 20h1m7 0h1",
    customers: "M15 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3",
    marketing: "M3 6h18v13H3z m0 0 9 7 9-7",
    money: "M4 20V10h4v10m4 0V4h4v16m4 0v-6",
    team: "M10 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M2 21v-4a5 5 0 0 1 10 0v4 M16 4a3 3 0 0 1 0 6m1 3a5 5 0 0 1 5 5v3",
    imports: "M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"
  };
  function navSymbol(route) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [name, value] of Object.entries({ viewBox: "0 0 24 24", width: "22", height: "22", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "nav-symbol" })) svg.setAttribute(name, value);
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", paths[route] || paths.register);
    svg.append(path);
    return svg;
  }

  // apps/ui/public/js/auth.js
  var AUTH = "/api/pos/auth";
  var identity = null;
  var signInPromise = null;
  function roleLabel(roles = []) {
    if (roles.includes("owner")) return "Owner";
    if (roles.includes("manager")) return "Manager";
    if (roles.includes("cashier")) return "Cashier";
    return "Operator";
  }
  function setHeader(operator) {
    identity = operator;
    setAuthenticatedActor(operator.id);
    const target = document.getElementById("current-user");
    if (!target) return;
    target.textContent = `${operator.name} \xB7 ${roleLabel(operator.roles)}`;
    target.title = `Signed in as ${operator.name}. Select to switch operator or manage access.`;
    target.hidden = false;
  }
  function pinInput(labelText = "PIN") {
    const input2 = el("input", {
      type: "password",
      inputmode: "numeric",
      pattern: "[0-9]{4}",
      minlength: "4",
      maxlength: "4",
      autocomplete: "off",
      required: true,
      "aria-label": labelText,
      placeholder: "4-digit PIN"
    });
    return input2;
  }
  function showError(node, error) {
    node.hidden = false;
    node.textContent = error?.message || "Sign-in failed. Try again.";
  }
  function shell(title, subtitle) {
    const dialog = el("dialog", { class: "auth-dialog", "aria-labelledby": "auth-title" });
    dialog.addEventListener("cancel", (event) => event.preventDefault());
    dialog.append(
      clubBrand("auth-brand"),
      el("h1", { id: "auth-title" }, title),
      el("p", { class: "view-sub" }, subtitle)
    );
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }
  async function operatorDirectory() {
    return (await apiGet(`${AUTH}/operators`)).data;
  }
  async function bootstrapDialog(directory) {
    const owner = directory.operators.find((operator) => operator.roles.includes("owner"));
    const dialog = shell(
      "Secure this register",
      "Create the owner PIN used to unlock the register and manage cashier access."
    );
    const pin = pinInput("New owner PIN");
    const confirm = pinInput("Confirm owner PIN");
    const error = el("div", { class: "error-banner", role: "alert", hidden: true });
    const submit = el("button", { class: "btn btn-primary auth-submit", type: "submit" }, "Secure & sign in");
    const form = el("form", { class: "auth-form" }, [
      el("div", { class: "auth-operator-selected" }, [
        el("strong", {}, owner?.name || "Owner"),
        el("span", { class: "chip chip-ok" }, "Owner")
      ]),
      el("label", { class: "field" }, [el("span", {}, "New PIN"), pin]),
      el("label", { class: "field" }, [el("span", {}, "Confirm PIN"), confirm]),
      el("p", { class: "hint" }, "Use exactly four digits. Five incorrect attempts lock the operator for five minutes."),
      error,
      submit
    ]);
    dialog.append(form);
    queueMicrotask(() => pin.focus());
    return new Promise((resolve) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        error.hidden = true;
        if (pin.value !== confirm.value) {
          showError(error, new Error("The PINs do not match."));
          confirm.focus();
          return;
        }
        submit.disabled = true;
        submit.textContent = "Securing\u2026";
        try {
          const result = await mutate(`${AUTH}/bootstrap`, "POST", { pin: pin.value });
          dialog.close();
          dialog.remove();
          resolve(result.data);
        } catch (err) {
          showError(error, err);
          submit.disabled = false;
          submit.textContent = "Secure & sign in";
        }
      });
    });
  }
  async function loginDialog(directory) {
    const configured = directory.operators.filter((operator) => operator.pinConfigured);
    const dialog = shell("Operator sign in", "Choose your name and enter your register PIN.");
    const select3 = el(
      "select",
      { required: true, "aria-label": "Register operator" },
      configured.length ? configured.map((operator) => el("option", { value: operator.id }, `${operator.name} \xB7 ${roleLabel(operator.roles)}`)) : [el("option", { value: "" }, "No PIN-enabled operators")]
    );
    const pin = pinInput();
    const error = el("div", { class: "error-banner", role: "alert", hidden: true });
    const submit = el(
      "button",
      { class: "btn btn-primary auth-submit", type: "submit", disabled: configured.length === 0 },
      "Sign in"
    );
    const form = el("form", { class: "auth-form" }, [
      el("label", { class: "field" }, [el("span", {}, "Operator"), select3]),
      el("label", { class: "field" }, [el("span", {}, "PIN"), pin]),
      configured.length === 0 ? el("div", { class: "blocked", role: "note" }, "No operator has a PIN. An owner must configure register access.") : null,
      error,
      submit
    ]);
    dialog.append(form);
    queueMicrotask(() => {
      if (!window.matchMedia("(pointer: coarse)").matches) (configured.length ? pin : select3).focus();
    });
    return new Promise((resolve) => {
      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        submit.disabled = true;
        submit.textContent = "Signing in\u2026";
        error.hidden = true;
        try {
          const result = await mutate(`${AUTH}/session`, "POST", {
            userId: select3.value,
            pin: pin.value
          });
          dialog.close();
          dialog.remove();
          resolve(result.data);
        } catch (err) {
          showError(error, err);
          pin.value = "";
          pin.focus();
          submit.disabled = false;
          submit.textContent = "Sign in";
        }
      });
    });
  }
  async function forceSignIn() {
    if (signInPromise) return signInPromise;
    signInPromise = (async () => {
      const directory = await operatorDirectory();
      const signedIn = directory.bootstrapRequired ? await bootstrapDialog(directory) : await loginDialog(directory);
      setHeader(signedIn);
      return signedIn;
    })();
    try {
      return await signInPromise;
    } finally {
      signInPromise = null;
    }
  }
  function actionButton(text, action, options = {}) {
    return el("button", {
      class: `btn${options.primary ? " btn-primary" : ""}${options.danger ? " btn-danger" : ""}`,
      type: options.submit ? "submit" : "button",
      onclick: options.submit ? null : action
    }, text);
  }
  async function changePinDialog() {
    const dialog = shell("Change my PIN", "Your other register sessions will be signed out.");
    const pin = pinInput("New PIN");
    const confirm = pinInput("Confirm new PIN");
    const error = el("div", { class: "error-banner", role: "alert", hidden: true });
    const save = actionButton("Save PIN", null, { submit: true, primary: true });
    const form = el("form", { class: "auth-form" }, [
      el("label", { class: "field" }, [el("span", {}, "New PIN"), pin]),
      el("label", { class: "field" }, [el("span", {}, "Confirm PIN"), confirm]),
      error,
      el("div", { class: "view-actions" }, [
        actionButton("Cancel", () => {
          dialog.close();
          dialog.remove();
        }),
        save
      ])
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (pin.value !== confirm.value) return showError(error, new Error("The PINs do not match."));
      save.disabled = true;
      try {
        await mutate(`${AUTH}/operators/${identity.id}/pin`, "PUT", { pin: pin.value });
        toast("Operator PIN updated.");
        dialog.close();
        dialog.remove();
      } catch (err) {
        showError(error, err);
        save.disabled = false;
      }
    });
    dialog.append(form);
    queueMicrotask(() => pin.focus());
  }
  async function addOperatorDialog() {
    const dialog = shell("Add register operator", "Create a cashier or manager with their own attributable PIN.");
    const name = el("input", { required: true, maxlength: "120", autocomplete: "off" });
    const email = el("input", { required: true, type: "email", autocomplete: "off" });
    const role = el("select", {}, [
      el("option", { value: "cashier" }, "Cashier"),
      el("option", { value: "manager" }, "Manager")
    ]);
    const pin = pinInput("Operator PIN");
    const error = el("div", { class: "error-banner", role: "alert", hidden: true });
    const add = actionButton("Add operator", null, { submit: true, primary: true });
    const form = el("form", { class: "auth-form" }, [
      el("label", { class: "field" }, [el("span", {}, "Name"), name]),
      el("label", { class: "field" }, [el("span", {}, "Email"), email]),
      el("label", { class: "field" }, [el("span", {}, "Role"), role]),
      el("label", { class: "field" }, [el("span", {}, "PIN"), pin]),
      error,
      el("div", { class: "view-actions" }, [
        actionButton("Cancel", () => {
          dialog.close();
          dialog.remove();
        }),
        add
      ])
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      add.disabled = true;
      try {
        const result = await mutate(`${AUTH}/operators`, "POST", {
          name: name.value,
          email: email.value,
          role: role.value,
          pin: pin.value
        });
        toast(`${result.data.name} can now sign in.`);
        dialog.close();
        dialog.remove();
      } catch (err) {
        showError(error, err);
        add.disabled = false;
      }
    });
    dialog.append(form);
    queueMicrotask(() => name.focus());
  }
  async function operatorMenu() {
    if (!identity) return;
    const dialog = shell(identity.name, `${roleLabel(identity.roles)} \xB7 Session expires ${new Date(identity.expiresAt).toLocaleString()}`);
    const actions = el("div", { class: "auth-menu" }, [
      actionButton("Change my PIN", () => {
        dialog.close();
        dialog.remove();
        changePinDialog();
      }),
      identity.canManageOperators ? actionButton("Add cashier or manager", () => {
        dialog.close();
        dialog.remove();
        addOperatorDialog();
      }) : null,
      actionButton("Switch operator", async () => {
        const queued = currentSnapshot();
        if (queued.items.length > 0) {
          toast(`Finish or review ${queued.items.length} unsynced change${queued.items.length === 1 ? "" : "s"} before switching operator.`, "warn");
          return;
        }
        const button2 = dialog.querySelector("button.btn-danger");
        if (button2) button2.disabled = true;
        await mutate(`${AUTH}/session`, "DELETE", null);
        identity = null;
        setAuthenticatedActor(null);
        dialog.close();
        dialog.remove();
        await forceSignIn();
        window.location.reload();
      }, { danger: true }),
      actionButton("Close", () => {
        dialog.close();
        dialog.remove();
      })
    ]);
    dialog.append(actions);
  }
  async function requireOperatorSession() {
    try {
      const response = await apiGet(`${AUTH}/session`);
      setHeader(response.data);
    } catch (error) {
      if (error?.status !== 401) throw error;
      await forceSignIn();
    }
    const target = document.getElementById("current-user");
    if (target && !target.dataset.authWired) {
      target.dataset.authWired = "true";
      target.addEventListener("click", operatorMenu);
    }
    window.addEventListener("mags:auth-required", () => {
      identity = null;
      setAuthenticatedActor(null);
      forceSignIn().catch((error) => toast(error.message, "err"));
    });
    return identity;
  }

  // apps/ui/public/js/ui.js
  function viewHeader({ title, subtitle, actions = [] }) {
    return el("div", { class: "view-header" }, [
      el("div", { class: "titles" }, [
        el("h1", {}, title),
        subtitle ? el("p", { class: "view-sub" }, subtitle) : null
      ]),
      actions.length ? el("div", { class: "view-actions" }, actions) : null
    ]);
  }
  function button(label2, { onClick, primary, danger, big, href, disabled, title } = {}) {
    const cls = ["btn", primary && "btn-primary", danger && "btn-danger", big && "btn-big"].filter(Boolean).join(" ");
    return el("button", {
      class: cls,
      type: "button",
      disabled: disabled || false,
      title: title || null,
      onclick: (e) => {
        e.preventDefault();
        if (href) return navigate(href);
        if (onClick) onClick(e);
      },
      text: label2
    });
  }
  function metricTile({ label: label2, value, foot, definition, href, source }) {
    const info = definition ? el("span", { class: "info-dot", role: "img", "aria-label": `Definition: ${definition}`, title: definition }, "i") : null;
    const inner = [
      el("div", { class: "tile-label" }, [label2, info]),
      el("div", { class: "tile-value" }, value),
      el("div", { class: "tile-foot" }, foot || (source ? `Source: ${source}` : ""))
    ];
    if (href) {
      return el("a", { class: "card tile", href, "aria-label": `${label2}: ${value}. Open detail.` }, inner);
    }
    return el("div", { class: "card tile" }, inner);
  }
  function emptyState({ icon = "\u{1F4ED}", title, message, actions = [], setup = null }) {
    const kids = [
      el("div", { class: "empty-icon", "aria-hidden": "true" }, icon),
      el("h2", {}, title),
      message ? el("p", {}, message) : null
    ];
    if (setup && setup.length) {
      kids.push(
        el(
          "ul",
          { class: "setup-list" },
          setup.map(
            (s) => el("li", {}, [
              el("span", { class: `status ${s.done ? "done" : "todo"}` }, s.done ? "\u2713" : "\u25CB"),
              el("span", {}, [el("strong", {}, s.label), s.hint ? el("div", { class: "hint" }, s.hint) : null])
            ])
          )
        )
      );
    }
    if (actions.length) kids.push(el("div", { class: "view-actions", style: "justify-content:center;margin-top:16px" }, actions));
    return el("div", { class: "empty" }, kids);
  }
  function blockedBanner(reason, missing) {
    const kids = [el("strong", {}, "Not ready yet. "), el("span", {}, reason || "A required step is missing.")];
    if (Array.isArray(missing) && missing.length) {
      kids.push(el("ul", { style: "margin:6px 0 0 18px" }, missing.map((m) => el("li", {}, m))));
    }
    return el("div", { class: "blocked", role: "note" }, kids);
  }
  function errorBanner(message) {
    return el("div", { class: "error-banner", role: "alert" }, message);
  }
  function dataTable(columns, rows, { emptyMessage = "Nothing here yet." } = {}) {
    if (!rows || rows.length === 0) {
      return el("div", { class: "card" }, el("p", { class: "view-sub", style: "margin:0" }, emptyMessage));
    }
    const thead = el(
      "thead",
      {},
      el(
        "tr",
        {},
        columns.map((c) => el("th", { class: c.num ? "num" : null, scope: "col" }, c.label))
      )
    );
    const tbody = el(
      "tbody",
      {},
      rows.map(
        (row2) => el(
          "tr",
          {},
          columns.map((c) => {
            const val = c.render ? c.render(row2) : row2[c.key];
            const cell = el("td", { class: c.num ? "num" : null });
            if (val && val.nodeType) cell.append(val);
            else cell.textContent = val === null || val === void 0 ? "" : String(val);
            return cell;
          })
        )
      )
    );
    return el("div", { class: "table-wrap" }, el("table", { class: "data" }, [thead, tbody]));
  }
  function chip(text, variant) {
    return el("span", { class: `chip ${variant ? `chip-${variant}` : ""}` }, text);
  }
  function expandable(summaryText, contentNode) {
    return el("details", { class: "expandable" }, [el("summary", {}, summaryText), contentNode]);
  }
  function detailList(pairs) {
    const dl = el("dl", { class: "detail-list" });
    for (const [k, v] of Object.entries(pairs)) {
      dl.append(el("dt", {}, k));
      const dd = el("dd", {});
      if (v && v.nodeType) dd.append(v);
      else dd.textContent = v === null || v === void 0 || v === "" ? "\u2014" : String(v);
      dl.append(dd);
    }
    return dl;
  }
  function field(label2, control, hint) {
    const id = control.id || `f_${Math.random().toString(36).slice(2)}`;
    control.id = id;
    return el("div", { class: "field" }, [
      el("label", { for: id }, label2),
      hint ? el("div", { class: "hint" }, hint) : null,
      control
    ]);
  }
  function input({ name, type = "text", value = "", placeholder = "", required = false, min } = {}) {
    return el("input", { name, type, value, placeholder, required: required || false, min: min ?? null, autocomplete: "off" });
  }
  function select(name, options, value) {
    return el(
      "select",
      { name },
      options.map(
        (o) => el("option", { value: o.value, selected: o.value === value ? true : null }, o.label)
      )
    );
  }
  function qtyStepper(initial = 1, onChange) {
    let qty = initial;
    const inp = el("input", { type: "number", min: "1", value: String(qty), "aria-label": "Quantity", inputmode: "numeric" });
    const set = (n) => {
      qty = Math.max(1, n | 0);
      inp.value = String(qty);
      if (onChange) onChange(qty);
    };
    inp.addEventListener("change", () => set(Number(inp.value) || 1));
    const wrap = el("div", { class: "qty-stepper" }, [
      el("button", { class: "btn", type: "button", "aria-label": "Decrease quantity", onclick: () => set(qty - 1) }, "\u2212"),
      inp,
      el("button", { class: "btn", type: "button", "aria-label": "Increase quantity", onclick: () => set(qty + 1) }, "+")
    ]);
    wrap.getQty = () => qty;
    return wrap;
  }
  function section(title, ...nodes) {
    return el("section", { class: "card", style: "margin-bottom:16px" }, [
      title ? el("h2", {}, title) : null,
      ...nodes
    ]);
  }
  async function withLoading(container, loader) {
    clear(container);
    container.append(el("div", { class: "loading" }, "Loading\u2026"));
    try {
      const node = await loader();
      clear(container);
      if (node) container.append(node);
    } catch (err) {
      clear(container);
      container.append(errorBanner(err && err.message || "Could not load."));
    }
  }

  // apps/ui/public/src/money.mjs
  function groupThousands(digits) {
    let out = "";
    for (let i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
      out += digits[i];
    }
    return out;
  }
  function formatCents(cents, opts = {}) {
    const symbol = opts.symbol ?? "$";
    if (!Number.isFinite(cents)) return `${symbol}0.00`;
    const n = Math.trunc(cents);
    const negative = n < 0;
    const abs = Math.abs(n);
    const dollars = Math.floor(abs / 100);
    const remainder = abs % 100;
    const centsStr = remainder < 10 ? `0${remainder}` : String(remainder);
    const body = `${symbol}${groupThousands(String(dollars))}.${centsStr}`;
    if (negative) return `-${body}`;
    if (opts.sign === "always" && n > 0) return `+${body}`;
    return body;
  }

  // apps/ui/public/src/gates.mjs
  var GATE_LABELS = {
    armed: "Sending is turned on",
    consent: "Customer consent on file",
    postal_address: "Business mailing address set",
    postalAddress: "Business mailing address set",
    from_identity: "From name and email set",
    fromIdentity: "From name and email set",
    from_email: "From email address set",
    fromEmail: "From email address set",
    provider: "Email provider connected",
    provider_credential: "Email provider connected",
    approval: "Campaign approved to send",
    quiet_hours: "Quiet hours configured",
    suppression: "Suppression list ready",
    business_identity: "Business identity complete"
  };
  function humanizeKey(key) {
    if (!key) return "Requirement";
    if (GATE_LABELS[key]) return GATE_LABELS[key];
    return String(key).replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^\w/, (c) => c.toUpperCase());
  }
  function isOpen(gate) {
    if (!gate || typeof gate !== "object") return false;
    const v = gate.open ?? gate.passed ?? gate.ok ?? gate.satisfied;
    return v === true;
  }
  function reasonOf(gate) {
    if (!gate || typeof gate !== "object") return "";
    if (typeof gate.reason === "string" && gate.reason) return gate.reason;
    if (typeof gate.detail === "string" && gate.detail) return gate.detail;
    if (typeof gate.message === "string" && gate.message) return gate.message;
    if (Array.isArray(gate.missing) && gate.missing.length) return gate.missing.join("; ");
    if (typeof gate.missing === "string" && gate.missing) return gate.missing;
    return "";
  }
  function phraseGate(key, gate) {
    const label2 = humanizeKey(gate?.label ?? key);
    const open = isOpen(gate);
    const reason = reasonOf(gate);
    const phrase = open ? `${label2}: ready.` : `${label2}: not ready${reason ? ` \u2014 ${reason}` : "."}`;
    return { key, label: label2, open, reason, phrase };
  }
  function phraseReport(report) {
    const raw = report?.gates ?? report ?? {};
    let entries;
    if (Array.isArray(raw)) {
      entries = raw.map((g, i) => [g.key ?? g.gate ?? String(i), g]);
    } else {
      entries = Object.entries(raw).filter(([, v]) => v && typeof v === "object");
    }
    const gates = entries.map(([k, g]) => phraseGate(k, g));
    const openCount = gates.filter((g) => g.open).length;
    const blockedCount = gates.length - openCount;
    return { gates, openCount, blockedCount, allOpen: gates.length > 0 && blockedCount === 0 };
  }

  // apps/ui/public/js/views/actions.js
  var PRIORITY_VARIANT = { critical: "critical", high: "high", medium: "medium", low: "low" };
  async function loadTiles() {
    let owner;
    try {
      owner = await getData("/api/dashboard/owner.json");
    } catch {
      return null;
    }
    if (!owner || owner.available === false) return null;
    const money2 = (c) => formatCents(Number(c) || 0);
    const num = (n) => (Number(n) || 0).toLocaleString("en-US");
    const tiles = [];
    if (owner.allTime) {
      tiles.push(metricTile({
        label: "All-time sales",
        value: money2(owner.allTime.grossCents),
        foot: `${num(owner.allTime.paymentCount)} payments \xB7 avg ${money2(owner.allTime.averageTicketCents)}`,
        definition: `Completed payments since ${owner.dataFirstLocalDate || "the first sale"}.`,
        href: "#/money"
      }));
    }
    if (owner.ytd) {
      const pct = owner.ytd.pctChange;
      const foot = pct == null ? `through ${owner.ytd.throughLocalDate}` : `${pct >= 0 ? "+" : ""}${pct}% vs last year (${money2(owner.ytd.lastYearGrossCents)})`;
      tiles.push(metricTile({
        label: `This year (${owner.ytd.year})`,
        value: money2(owner.ytd.grossCents),
        foot,
        definition: `Gross sales Jan 1\u2013${owner.ytd.throughLocalDate}, vs the same window a year earlier.`,
        href: "#/money"
      }));
    }
    if (owner.customers && owner.customers.available !== false) {
      tiles.push(metricTile({
        label: "Customers",
        value: num(owner.customers.total),
        foot: `${owner.customers.repeatRatePct}% repeat \xB7 ${owner.customers.emailPct}% emailable`,
        definition: "Distinct customers found in your sales history.",
        href: "#/customers"
      }));
    }
    if (owner.refunds && owner.refunds.available !== false) {
      tiles.push(metricTile({
        label: "Refunds (12 mo)",
        value: money2(owner.refunds.last12moCents),
        foot: `${num(owner.refunds.last12moCount)} returns \xB7 ${money2(owner.refunds.allTimeCents)} all-time`,
        href: "#/money"
      }));
    }
    const topItem = (owner.topItems12mo || [])[0];
    if (topItem) {
      tiles.push(metricTile({
        label: "Top seller (12 mo)",
        value: money2(topItem.revenueCents),
        foot: `${topItem.name} \xB7 ${num(topItem.quantity)} sold`,
        href: "#/stock"
      }));
    }
    const topCat = (owner.topCategories12mo || [])[0];
    if (topCat) {
      tiles.push(metricTile({
        label: "Top category (12 mo)",
        value: money2(topCat.revenueCents),
        foot: topCat.name
      }));
    }
    if (!tiles.length) return null;
    const grid = el("div", { class: "grid tiles" });
    tiles.forEach((t) => grid.append(t));
    return grid;
  }
  function actionRow(a, refresh) {
    const priority = a.priority || "medium";
    const evidence = a.evidence ? expandable("Why this is here", el("pre", { style: "white-space:pre-wrap;margin:0" }, prettyEvidence(a.evidence))) : null;
    const actionsRow = el("div", { class: "view-actions", style: "margin-top:8px" }, [
      a.deepLink ? button("Open", { href: toHash(a.deepLink) }) : null,
      button("Resolve", {
        primary: true,
        onClick: async () => {
          try {
            await mutate(`/api/actions/${a.id}/resolve`, "POST", { kind: "manual" });
            toast("Marked resolved.");
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      }),
      button("Snooze", {
        onClick: async () => {
          const reason = prompt("Snooze \u2014 why? (required)");
          if (!reason) return;
          const until = new Date(Date.now() + 24 * 3600 * 1e3).toISOString();
          try {
            await mutate(`/api/actions/${a.id}/snooze`, "POST", { until, reason });
            toast("Snoozed for 1 day.");
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      }),
      button("Assign", {
        onClick: async () => {
          const ownerUserId = prompt("Assign to which user id?");
          if (!ownerUserId) return;
          try {
            await mutate(`/api/actions/${a.id}/assign`, "POST", { ownerUserId });
            toast("Assigned.");
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      }),
      button("Comment", {
        onClick: async () => {
          const body = prompt("Add a note:");
          if (!body) return;
          try {
            await mutate(`/api/actions/${a.id}/comments`, "POST", { body });
            toast("Note added.");
          } catch (e) {
            toast(e.message, "err");
          }
        }
      })
    ]);
    return el("div", { class: "card", style: "margin-bottom:10px" }, [
      el("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" }, [
        chip(priorityLabel(priority), PRIORITY_VARIANT[priority]),
        el("strong", { style: "flex:1 1 auto" }, a.title || a.kind || "Action"),
        a.dueAt ? el("span", { class: "view-sub", style: "margin:0" }, `Due ${formatDate(a.dueAt)}`) : null
      ]),
      a.body ? el("p", { style: "margin:6px 0 0" }, a.body) : null,
      evidence,
      actionsRow
    ]);
  }
  function prettyEvidence(ev) {
    try {
      return typeof ev === "string" ? ev : JSON.stringify(ev, null, 2);
    } catch {
      return String(ev);
    }
  }
  function toHash(deepLink) {
    if (!deepLink) return "#/actions";
    if (deepLink.startsWith("#")) return deepLink;
    if (deepLink.includes("order")) return "#/orders";
    if (deepLink.includes("purchase") || deepLink.includes("po")) return "#/buying";
    if (deepLink.includes("count")) return "#/counts";
    if (deepLink.includes("show")) return "#/shows";
    if (deepLink.includes("transfer")) return "#/transfers";
    return "#/actions";
  }
  async function setupChecklist() {
    const items = [];
    try {
      const gates = await getData("/api/outreach/settings/gates");
      const report = phraseReport(gates);
      items.push({
        label: "Turn on customer email",
        done: report.allOpen,
        hint: report.allOpen ? "All email gates are open." : `${report.blockedCount} step(s) left in Marketing \u2192 Setup.`
      });
    } catch {
    }
    try {
      const locs = await getData("/api/inventory/locations");
      items.push({
        label: "Set up stock locations",
        done: Array.isArray(locs) && locs.length > 0,
        hint: Array.isArray(locs) && locs.length ? `${locs.length} location(s) ready.` : "Add warehouse / trailer in Stock."
      });
    } catch {
    }
    try {
      const backups = await getList("/api/admin/backups");
      items.push({
        label: "Take your first backup",
        done: backups.data && backups.data.length > 0,
        hint: backups.data && backups.data.length ? "Backups exist." : "Run one in Settings \u2192 Backups."
      });
    } catch {
    }
    return items;
  }
  registerView("actions", async (container) => {
    container.append(
      viewHeader({
        title: "Action Center",
        subtitle: "What needs your attention right now.",
        actions: [button("Refresh", { onClick: () => navigate("#/actions") })]
      })
    );
    const tilesSlot = el("div", { style: "margin-bottom:18px" });
    container.append(tilesSlot);
    loadTiles().then((g) => {
      if (g) tilesSlot.append(g);
    });
    const queueSlot = el("div");
    container.append(queueSlot);
    async function refresh() {
      await withLoading(queueSlot, async () => {
        try {
          await mutate("/api/actions/wake-due", "POST", {});
        } catch {
        }
        let counts2 = null;
        try {
          counts2 = await getData("/api/actions/counts");
        } catch {
        }
        const list = await getList("/api/actions", { limit: 100 });
        const rows = (list.data || []).slice().sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
        if (rows.length === 0) {
          const setup = await setupChecklist();
          const allDone = setup.every((s) => s.done);
          return emptyState({
            icon: allDone ? "\u2705" : "\u{1F9ED}",
            title: allDone ? "All clear \u2014 nothing needs attention." : "You are set up \u2014 a few things to finish",
            message: allDone ? "When something needs a decision (low stock, a mismatch, an approval), it shows up here." : "Finish these to get the most out of Bar One. Nothing here is guessed \u2014 each item is a real setup step.",
            setup: setup.length ? setup : null
          });
        }
        const wrap = el("div", {});
        if (counts2) {
          wrap.append(
            section(
              "Attention summary",
              el("div", { class: "grid tiles" }, summaryTiles(counts2))
            )
          );
        }
        wrap.append(el("h2", {}, `Queue (${rows.length})`));
        for (const a of rows) wrap.append(actionRow(a, refresh));
        return wrap;
      });
    }
    refresh();
  });
  function summaryTiles(counts2) {
    const tiles = [];
    const byPriority = counts2.byPriority || counts2.priorities || null;
    if (byPriority) {
      for (const [p, n] of Object.entries(byPriority)) {
        if (!n) continue;
        tiles.push(metricTile({ label: priorityLabel(p), value: String(n), foot: "open actions" }));
      }
    } else if (typeof counts2.total === "number") {
      tiles.push(metricTile({ label: "Open actions", value: String(counts2.total), foot: "need attention" }));
    }
    return tiles;
  }

  // apps/ui/public/src/cart.mjs
  var CART_SCHEMA_VERSION = 1;
  var REGISTER_STORAGE_KEY = "blacklabel.pos.register.v1";
  var ALLOWED_TENDERS = /* @__PURE__ */ new Set(["cash", "external"]);
  function generatedId(prefix) {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID()}`;
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }
  function isoNow(value) {
    const raw = value || (/* @__PURE__ */ new Date()).toISOString();
    const parsed = new Date(raw);
    return Number.isNaN(parsed.valueOf()) ? (/* @__PURE__ */ new Date()).toISOString() : parsed.toISOString();
  }
  function nonnegativeInteger(value, label2) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label2} must be a non-negative integer`);
    }
    return value;
  }
  function positiveInteger(value, label2) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label2} must be a positive integer`);
    }
    return value;
  }
  function rateBps(value, label2) {
    nonnegativeInteger(value, label2);
    if (value > 1e4) throw new Error(`${label2} must be between 0 and 10000 basis points`);
    return value;
  }
  function textOrNull(value) {
    const text = typeof value === "string" ? value.trim() : "";
    return text || null;
  }
  function applyDiscount(amountCents, bps, fixedCents) {
    let amount = nonnegativeInteger(amountCents, "amountCents");
    const percent = rateBps(bps || 0, "discountBps");
    const fixed = nonnegativeInteger(fixedCents || 0, "discountFixedCents");
    amount -= Math.round(amount * percent / 1e4);
    return Math.max(0, amount - fixed);
  }
  function touch(cart, patch2, now) {
    return { ...cart, ...patch2, updatedAt: isoNow(now) };
  }
  function createCart(options = {}) {
    const now = isoNow(options.now);
    return {
      version: CART_SCHEMA_VERSION,
      id: textOrNull(options.id) || generatedId("cart"),
      createdAt: now,
      updatedAt: now,
      customerId: null,
      taxBps: 0,
      discountBps: 0,
      discountFixedCents: 0,
      lines: []
    };
  }
  function parseMoneyToCents(value) {
    const raw = String(value ?? "").trim().replace(/[$,\s]/g, "");
    const match = raw.match(/^(\d+)(?:\.(\d{0,2}))?$/);
    if (!match) throw new Error("Enter a non-negative amount with no more than two decimal places");
    const dollars = Number(match[1]);
    const fraction = (match[2] || "").padEnd(2, "0");
    const cents = dollars * 100 + Number(fraction || 0);
    if (!Number.isSafeInteger(cents)) throw new Error("Amount is too large");
    return cents;
  }
  function parsePercentToBps(value) {
    const raw = String(value ?? "").trim().replace(/%\s*$/, "");
    const match = raw.match(/^(\d{1,3})(?:\.(\d{0,2}))?$/);
    if (!match) throw new Error("Enter a percent from 0 to 100 with up to two decimal places");
    const bps = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0") || 0);
    return rateBps(bps, "percent");
  }
  function normalizeLine(line) {
    if (!line || typeof line !== "object") return null;
    const description = textOrNull(line.description);
    if (!description) return null;
    try {
      const qty = positiveInteger(line.qty, "qty");
      const unitPriceCents = nonnegativeInteger(line.unitPriceCents, "unitPriceCents");
      const discountBps = rateBps(line.discountBps || 0, "discountBps");
      const discountFixedCents = nonnegativeInteger(line.discountFixedCents || 0, "discountFixedCents");
      return {
        id: textOrNull(line.id) || generatedId("line"),
        variationId: textOrNull(line.variationId),
        description,
        sku: textOrNull(line.sku),
        barcode: textOrNull(line.barcode),
        qty,
        unitPriceCents,
        discountBps,
        discountFixedCents,
        source: line.source === "catalog" && textOrNull(line.variationId) ? "catalog" : "custom"
      };
    } catch {
      return null;
    }
  }
  function normalizeCart(value, options = {}) {
    if (!value || typeof value !== "object" || value.version !== CART_SCHEMA_VERSION) {
      return createCart(options);
    }
    const fallback = createCart(options);
    const lines = Array.isArray(value.lines) ? value.lines.map(normalizeLine).filter(Boolean) : [];
    const safeRate = (candidate) => {
      try {
        return rateBps(candidate || 0, "rate");
      } catch {
        return 0;
      }
    };
    const safeCents = (candidate) => {
      try {
        return nonnegativeInteger(candidate || 0, "cents");
      } catch {
        return 0;
      }
    };
    return {
      version: CART_SCHEMA_VERSION,
      id: textOrNull(value.id) || fallback.id,
      createdAt: isoNow(value.createdAt || fallback.createdAt),
      updatedAt: isoNow(value.updatedAt || fallback.updatedAt),
      customerId: textOrNull(value.customerId),
      taxBps: safeRate(value.taxBps),
      discountBps: safeRate(value.discountBps),
      discountFixedCents: safeCents(value.discountFixedCents),
      lines
    };
  }
  function addCartLine(cartInput, lineInput, options = {}) {
    const cart = normalizeCart(cartInput);
    const normalized = normalizeLine({
      ...lineInput,
      id: options.lineId || lineInput?.id,
      source: textOrNull(lineInput?.variationId) ? "catalog" : "custom"
    });
    if (!normalized) throw new Error("A cart line needs a description, positive quantity, and integer-cent price");
    const matchIndex = normalized.variationId ? cart.lines.findIndex((line) => line.variationId === normalized.variationId && line.unitPriceCents === normalized.unitPriceCents && line.discountBps === normalized.discountBps && line.discountFixedCents === normalized.discountFixedCents) : -1;
    if (matchIndex >= 0) {
      const lines = cart.lines.map(
        (line, index) => index === matchIndex ? { ...line, qty: line.qty + normalized.qty } : line
      );
      return touch(cart, { lines }, options.now);
    }
    return touch(cart, { lines: [...cart.lines, normalized] }, options.now);
  }
  function setLineQuantity(cartInput, lineId, qty, options = {}) {
    const cart = normalizeCart(cartInput);
    if (!cart.lines.some((line) => line.id === lineId)) return cart;
    if (!Number.isSafeInteger(qty) || qty < 0) throw new Error("qty must be a non-negative integer");
    const lines = qty === 0 ? cart.lines.filter((line) => line.id !== lineId) : cart.lines.map((line) => line.id === lineId ? { ...line, qty } : line);
    return touch(cart, { lines }, options.now);
  }
  function incrementLine(cart, lineId, options = {}) {
    const line = normalizeCart(cart).lines.find((item) => item.id === lineId);
    return line ? setLineQuantity(cart, lineId, line.qty + 1, options) : normalizeCart(cart);
  }
  function decrementLine(cart, lineId, options = {}) {
    const line = normalizeCart(cart).lines.find((item) => item.id === lineId);
    return line ? setLineQuantity(cart, lineId, Math.max(0, line.qty - 1), options) : normalizeCart(cart);
  }
  function removeLine(cartInput, lineId, options = {}) {
    return setLineQuantity(cartInput, lineId, 0, options);
  }
  function setCustomer(cartInput, customerId, options = {}) {
    const cart = normalizeCart(cartInput);
    return touch(cart, { customerId: textOrNull(customerId) }, options.now);
  }
  function setCartPricing(cartInput, pricing, options = {}) {
    const cart = normalizeCart(cartInput);
    const patch2 = {};
    if (pricing.taxBps !== void 0) patch2.taxBps = rateBps(pricing.taxBps, "taxBps");
    if (pricing.discountBps !== void 0) patch2.discountBps = rateBps(pricing.discountBps, "discountBps");
    if (pricing.discountFixedCents !== void 0) {
      patch2.discountFixedCents = nonnegativeInteger(pricing.discountFixedCents, "discountFixedCents");
    }
    return touch(cart, patch2, options.now);
  }
  function cartTotals(cartInput) {
    const cart = normalizeCart(cartInput);
    const lineTotalsCents = cart.lines.map((line) => {
      const gross = Math.round(line.qty * line.unitPriceCents);
      return applyDiscount(gross, line.discountBps, line.discountFixedCents);
    });
    const subtotalCents = lineTotalsCents.reduce((sum, value) => sum + value, 0);
    const discountedCents = applyDiscount(subtotalCents, cart.discountBps, cart.discountFixedCents);
    const discountCents = subtotalCents - discountedCents;
    const taxCents = Math.round(discountedCents * cart.taxBps / 1e4);
    return {
      lineTotalsCents,
      subtotalCents,
      discountCents,
      taxCents,
      totalCents: discountedCents + taxCents
    };
  }
  function cartItemCount(cartInput) {
    return normalizeCart(cartInput).lines.reduce((sum, line) => sum + line.qty, 0);
  }
  function toOrderPayload(cartInput) {
    const cart = normalizeCart(cartInput);
    if (!cart.lines.length) throw new Error("Cart is empty");
    const payload = {
      cartId: cart.id,
      channel: "pos",
      lines: cart.lines.map((line) => {
        const out = {
          description: line.description,
          qty: line.qty,
          unitPriceCents: line.unitPriceCents
        };
        if (line.variationId) out.variationId = line.variationId;
        if (line.discountBps) out.discountBps = line.discountBps;
        if (line.discountFixedCents) out.discountFixedCents = line.discountFixedCents;
        return out;
      }),
      taxBps: cart.taxBps
    };
    if (cart.customerId) payload.customerId = cart.customerId;
    if (cart.discountBps) payload.discountBps = cart.discountBps;
    if (cart.discountFixedCents) payload.discountFixedCents = cart.discountFixedCents;
    return payload;
  }
  function buildTenderPlan(totalCents, inputs, options = {}) {
    nonnegativeInteger(totalCents, "totalCents");
    if (!Array.isArray(inputs)) throw new Error("Tenders must be an array");
    if (totalCents === 0 && inputs.length === 0) return [];
    if (inputs.length === 0) throw new Error("At least one tender is required");
    const keyFactory = options.keyFactory || (() => generatedId("tender"));
    const tenders = inputs.map((input2, index) => {
      if (!ALLOWED_TENDERS.has(input2.kind)) throw new Error(`Unsupported manual tender: ${input2.kind}`);
      const amountCents = positiveInteger(input2.amountCents, `tender ${index + 1} amountCents`);
      const out = {
        kind: input2.kind,
        amountCents,
        idempotencyKey: textOrNull(input2.idempotencyKey) || keyFactory(input2.kind, index)
      };
      if (input2.kind === "cash") {
        const cashReceivedCents = input2.cashReceivedCents === void 0 ? amountCents : nonnegativeInteger(input2.cashReceivedCents, `tender ${index + 1} cashReceivedCents`);
        if (cashReceivedCents < amountCents) throw new Error("Cash received must be at least the cash tender amount");
        out.cashReceivedCents = cashReceivedCents;
      } else if (input2.cashReceivedCents !== void 0) {
        throw new Error("cashReceivedCents is only valid for cash tenders");
      }
      const provider = textOrNull(input2.provider);
      const providerRef = textOrNull(input2.providerRef);
      if (provider) out.provider = provider;
      if (providerRef) out.providerRef = providerRef;
      return out;
    });
    const paid = tenders.reduce((sum, tender) => sum + tender.amountCents, 0);
    if (paid !== totalCents) {
      throw new Error(`Tender total (${paid}) must exactly equal sale total (${totalCents})`);
    }
    return tenders;
  }
  function createRegisterState(options = {}) {
    return {
      version: CART_SCHEMA_VERSION,
      active: normalizeCart(options.active, { id: options.cartId, now: options.now }),
      holds: Array.isArray(options.holds) ? options.holds : [],
      pendingCheckout: null,
      registerId: textOrNull(options.registerId) || generatedId("register"),
      drawerRef: textOrNull(options.drawerRef),
      cashSessionId: textOrNull(options.cashSessionId)
    };
  }
  function normalizeHold(value) {
    if (!value || typeof value !== "object") return null;
    const id = textOrNull(value.id);
    if (!id) return null;
    const cart = normalizeCart(value.cart);
    if (!cart.lines.length) return null;
    return {
      id,
      name: textOrNull(value.name) || "Held cart",
      heldAt: isoNow(value.heldAt),
      cart
    };
  }
  function normalizeRegisterState(value, options = {}) {
    if (!value || typeof value !== "object" || value.version !== CART_SCHEMA_VERSION) {
      return createRegisterState(options);
    }
    return {
      version: CART_SCHEMA_VERSION,
      active: normalizeCart(value.active, { id: options.cartId, now: options.now }),
      holds: Array.isArray(value.holds) ? value.holds.map(normalizeHold).filter(Boolean) : [],
      pendingCheckout: normalizePendingCheckout(value.pendingCheckout),
      registerId: textOrNull(value.registerId) || textOrNull(options.registerId) || generatedId("register"),
      drawerRef: textOrNull(value.drawerRef),
      cashSessionId: textOrNull(value.cashSessionId)
    };
  }
  function normalizePendingCheckout(value) {
    if (!value || typeof value !== "object") return null;
    const cartId = textOrNull(value.cartId);
    if (!cartId) return null;
    if (value.paymentKind === "card_present") {
      const orderIdempotencyKey = textOrNull(value.orderIdempotencyKey);
      const attemptIdempotencyKey = textOrNull(value.attemptIdempotencyKey);
      if (!orderIdempotencyKey || !attemptIdempotencyKey) return null;
      return {
        paymentKind: "card_present",
        orderId: textOrNull(value.orderId),
        cartId,
        orderIdempotencyKey,
        attemptIdempotencyKey,
        attemptId: textOrNull(value.attemptId),
        ...Number.isSafeInteger(value.amountCents) && value.amountCents > 0 ? { amountCents: value.amountCents } : {},
        ...value.awaitingPayment === true ? { awaitingPayment: true } : {},
        startedAt: isoNow(value.startedAt)
      };
    }
    const orderId = textOrNull(value.orderId);
    if (!orderId || !Array.isArray(value.tenders)) return null;
    try {
      const tenders = value.tenders.map((tender, index) => {
        if (!ALLOWED_TENDERS.has(tender.kind)) throw new Error("unsupported tender");
        return {
          kind: tender.kind,
          amountCents: positiveInteger(tender.amountCents, `tender ${index + 1}`),
          ...tender.kind === "cash" ? { cashReceivedCents: normalizeCashReceived(tender.cashReceivedCents, tender.amountCents) } : {},
          idempotencyKey: textOrNull(tender.idempotencyKey) || (() => {
            throw new Error("missing idempotency key");
          })(),
          ...textOrNull(tender.provider) ? { provider: textOrNull(tender.provider) } : {},
          ...textOrNull(tender.providerRef) ? { providerRef: textOrNull(tender.providerRef) } : {}
        };
      });
      return { paymentKind: "manual", orderId, cartId, tenders, startedAt: isoNow(value.startedAt) };
    } catch {
      return null;
    }
  }
  function normalizeCashReceived(value, amountCents) {
    const received = value === void 0 ? amountCents : nonnegativeInteger(value, "cashReceivedCents");
    if (received < amountCents) throw new Error("cashReceivedCents is below the tender amount");
    return received;
  }
  function holdActiveCart(stateInput, options = {}) {
    const state2 = normalizeRegisterState(stateInput);
    if (!state2.active.lines.length) throw new Error("Cart is empty");
    const heldAt = isoNow(options.now);
    const hold = {
      id: textOrNull(options.holdId) || generatedId("hold"),
      name: textOrNull(options.name) || `Held ${heldAt}`,
      heldAt,
      cart: state2.active
    };
    return {
      version: CART_SCHEMA_VERSION,
      active: createCart({ id: options.nextCartId, now: heldAt }),
      holds: [...state2.holds, hold],
      pendingCheckout: null,
      registerId: state2.registerId,
      drawerRef: state2.drawerRef,
      cashSessionId: state2.cashSessionId
    };
  }
  function resumeHeldCart(stateInput, holdId, options = {}) {
    const state2 = normalizeRegisterState(stateInput);
    if (state2.active.lines.length) throw new Error("Hold or clear the active cart before resuming another cart");
    const hold = state2.holds.find((item) => item.id === holdId);
    if (!hold) throw new Error("Held cart was not found");
    return {
      version: CART_SCHEMA_VERSION,
      active: touch(hold.cart, {}, options.now),
      holds: state2.holds.filter((item) => item.id !== holdId),
      pendingCheckout: null,
      registerId: state2.registerId,
      drawerRef: state2.drawerRef,
      cashSessionId: state2.cashSessionId
    };
  }
  function removeHeldCart(stateInput, holdId) {
    const state2 = normalizeRegisterState(stateInput);
    return { ...state2, holds: state2.holds.filter((item) => item.id !== holdId) };
  }
  function setPendingCheckout(stateInput, pending) {
    const state2 = normalizeRegisterState(stateInput);
    const normalized = normalizePendingCheckout(pending);
    if (!normalized) throw new Error("Pending checkout is invalid");
    if (normalized.cartId !== state2.active.id) throw new Error("Pending checkout does not belong to the active cart");
    return { ...state2, pendingCheckout: normalized };
  }
  function completePendingCheckout(stateInput, options = {}) {
    const state2 = normalizeRegisterState(stateInput);
    return {
      ...state2,
      active: { ...createCart({ id: options.nextCartId, now: options.now }), taxBps: state2.active.taxBps },
      pendingCheckout: null
    };
  }
  function clearPendingCheckout(stateInput) {
    const state2 = normalizeRegisterState(stateInput);
    return { ...state2, pendingCheckout: null };
  }
  function setRegisterContext(stateInput, patch2) {
    const state2 = normalizeRegisterState(stateInput);
    return {
      ...state2,
      registerId: textOrNull(patch2.registerId) || state2.registerId,
      drawerRef: patch2.drawerRef !== void 0 ? textOrNull(patch2.drawerRef) : state2.drawerRef,
      cashSessionId: patch2.cashSessionId !== void 0 ? textOrNull(patch2.cashSessionId) : state2.cashSessionId
    };
  }
  function serializeRegisterState(state2) {
    return JSON.stringify(normalizeRegisterState(state2));
  }
  function deserializeRegisterState(raw, options = {}) {
    if (!raw) return createRegisterState(options);
    try {
      return normalizeRegisterState(JSON.parse(raw), options);
    } catch {
      return createRegisterState(options);
    }
  }

  // apps/ui/public/js/views/register.js
  var POS_ORDER_ENDPOINT = "/api/pos/orders";
  var POS_CATALOG_ENDPOINT = "/api/pos/catalog";
  var POS_READINESS_ENDPOINT = "/api/pos/readiness";
  var POS_DRAWER_ENDPOINT = "/api/pos/drawer";
  registerView("register", async (container) => {
    let state2 = loadState();
    let busy = false;
    let lastSale = null;
    let readiness = null;
    let readinessError = null;
    let drawer = null;
    let drawerError = null;
    let activeCardAttempt = null;
    let cardTerminal = null;
    let splitBalance = null;
    let cardPollTimer = null;
    const screen = el("div", { class: "pos-register print-hide" });
    const receiptSlot = el("div");
    const readinessSlot = el("div");
    const pendingSlot = el("div");
    const successSlot = el("div");
    const searchResults = el("div", { "aria-live": "polite" });
    const cartSlot = el("div");
    const customerSlot = el("div");
    const drawerSlot = el("div");
    const pricingSlot = el("div");
    const checkoutSlot = el("div");
    const holdsSlot = el("div");
    const searchBox = input({ name: "catalogSearch", placeholder: "Scan barcode or search name / SKU" });
    searchBox.setAttribute("aria-label", "Barcode, item name, or SKU");
    searchBox.setAttribute("enterkeyhint", "search");
    searchBox.setAttribute("autocapitalize", "off");
    searchBox.setAttribute("spellcheck", "false");
    searchBox.style.fontSize = "1.15rem";
    searchBox.style.minHeight = "56px";
    screen.append(
      viewHeader({
        title: "Register",
        subtitle: "A warm welcome. A seamless checkout.",
        actions: [button("Orders", { href: "#/orders" })]
      }),
      readinessSlot,
      pendingSlot,
      successSlot,
      el("div", { class: "grid pos-register-grid" }, [
        el("div", {}, [
          section(
            "Add items",
            el("div", { style: "display:flex;gap:8px;align-items:end;flex-wrap:wrap" }, [
              el("div", { style: "flex:1 1 240px" }, field("Barcode, name, or SKU", searchBox)),
              button("Find item", { primary: true, big: true, onClick: searchCatalog }),
              button("Custom item", { big: true, onClick: openCustomLineDialog })
            ]),
            searchResults
          ),
          cartSlot
        ]),
        el("div", {}, [pricingSlot, checkoutSlot, drawerSlot, customerSlot, holdsSlot])
      ])
    );
    container.append(screen, receiptSlot);
    searchBox.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      searchCatalog();
    });
    persist();
    await refreshReadiness();
    await refreshDrawer();
    renderAll();
    if (state2.pendingCheckout) setTimeout(() => recoverPendingCheckout(), 0);
    else setTimeout(() => searchBox.focus(), 30);
    function loadState() {
      try {
        return deserializeRegisterState(localStorage.getItem(REGISTER_STORAGE_KEY));
      } catch {
        return deserializeRegisterState(null);
      }
    }
    function persist() {
      try {
        localStorage.setItem(REGISTER_STORAGE_KEY, serializeRegisterState(state2));
      } catch {
        toast("This browser could not save the cart locally.", "warn");
      }
    }
    function cartLocked() {
      if (!state2.pendingCheckout) return false;
      toast("Payment recovery is active. Finish or inspect that order before changing this cart.", "warn");
      return true;
    }
    function cardPresentReady() {
      const card = readiness?.tenders?.cardPresent;
      return card?.enabled === true && card?.physicalReaderVerified === true;
    }
    function updateActive(nextCart) {
      if (cartLocked()) return;
      state2 = { ...state2, active: nextCart };
      persist();
      renderAll();
    }
    function renderAll() {
      renderReadiness();
      renderDrawer();
      renderPending();
      renderSuccess();
      renderCart();
      renderCustomer();
      renderPricing();
      renderCheckout();
      renderHolds();
    }
    async function refreshDrawer() {
      if (!state2.drawerRef) {
        drawer = null;
        drawerError = null;
        if (state2.cashSessionId) {
          state2 = setRegisterContext(state2, { cashSessionId: null });
          persist();
        }
        return;
      }
      try {
        drawer = await getData(POS_DRAWER_ENDPOINT, { drawerRef: state2.drawerRef });
        drawerError = null;
        const openId = drawer?.session?.status === "open" ? drawer.session.id : null;
        if (openId !== state2.cashSessionId) {
          state2 = setRegisterContext(state2, { cashSessionId: openId });
          persist();
        }
      } catch (error) {
        drawer = null;
        drawerError = error;
        state2 = setRegisterContext(state2, { cashSessionId: null });
        persist();
      }
    }
    function hasOpenDrawer() {
      return Boolean(
        drawer?.session?.status === "open" && drawer.session.id && drawer.session.id === state2.cashSessionId
      );
    }
    function renderDrawer() {
      clear(drawerSlot);
      if (drawerError) {
        drawerSlot.append(section("Cash drawer", el("div", { class: "error-banner" }, drawerError.message || "Drawer status could not be loaded."), button("Retry", { onClick: async () => {
          await refreshDrawer();
          renderAll();
        } })));
        return;
      }
      if (!hasOpenDrawer()) {
        drawerSlot.append(section(
          "Cash drawer",
          el("p", { class: "view-sub" }, state2.drawerRef ? `No open shift for ${state2.drawerRef}. Cash tender is disabled.` : "Open a counted drawer shift before taking cash."),
          button("Open shift", { primary: true, disabled: Boolean(state2.pendingCheckout), onClick: openDrawerDialog })
        ));
        return;
      }
      const session = drawer.session;
      const reconciliation = drawer.reconciliation || {};
      drawerSlot.append(section(
        `Cash drawer \xB7 ${state2.drawerRef}`,
        el("div", { class: "blocked", style: "border-left-color:var(--ok);background:var(--ok-weak)" }, [
          el("strong", {}, "Shift open. "),
          el("span", {}, `Expected cash ${formatCents(reconciliation.effectiveExpectedCents ?? reconciliation.calculatedExpectedCents ?? 0)}.`)
        ]),
        totalRow("Opening float", reconciliation.openingFloatCents ?? session.opening_float_cents ?? 0),
        totalRow("Cash sales", reconciliation.cashSalesCents ?? 0),
        totalRow("Cash refunds", -(reconciliation.cashRefundsCents ?? 0)),
        totalRow("Paid in", reconciliation.paidInCents ?? 0),
        totalRow("Paid out / drops", -((reconciliation.paidOutCents ?? 0) + (reconciliation.dropsCents ?? 0))),
        el("div", { class: "view-actions", style: "margin-top:10px" }, [
          button("Cash movement", { disabled: Boolean(state2.pendingCheckout), onClick: openMovementDialog }),
          button("Close shift", { danger: true, disabled: Boolean(state2.pendingCheckout), onClick: openCloseDrawerDialog })
        ])
      ));
    }
    function openDrawerDialog() {
      const drawerRef = input({ name: "drawerRef", value: state2.drawerRef || "", placeholder: "Front counter drawer", required: true });
      const openingFloat = input({ name: "openingFloat", value: "0.00", required: true });
      openingFloat.setAttribute("inputmode", "decimal");
      const note2 = input({ name: "drawerNote", placeholder: "Shift note (optional)" });
      const dialog = dialogShell("Open cash drawer shift");
      dialog.append(
        field("Drawer ID", drawerRef, "Use the same physical drawer name each shift."),
        field("Opening float $", openingFloat),
        field("Note", note2),
        el("div", { class: "view-actions" }, [
          button("Cancel", { onClick: () => dialog.close() }),
          button("Open shift", { primary: true, onClick: submit })
        ])
      );
      openDialog(dialog, drawerRef);
      async function submit() {
        try {
          const ref = drawerRef.value.trim();
          if (!ref) throw new Error("Drawer ID is required");
          const response = await mutate(`${POS_DRAWER_ENDPOINT}/open`, "POST", {
            drawerRef: ref,
            registerRef: state2.registerId,
            openingFloatCents: parseMoneyToCents(openingFloat.value),
            note: note2.value.trim() || void 0
          });
          const data = response.data || response;
          state2 = setRegisterContext(state2, { drawerRef: ref, cashSessionId: data.session?.id || null });
          persist();
          dialog.close();
          await refreshDrawer();
          renderAll();
          toast("Cash drawer shift opened.");
        } catch (error) {
          toast(error.message, "err", 6e3);
        }
      }
    }
    function openMovementDialog() {
      if (!hasOpenDrawer()) return toast("Open a drawer shift first.", "warn");
      const kind = el("select", { name: "movementKind" }, [
        el("option", { value: "paid_in" }, "Paid in"),
        el("option", { value: "paid_out" }, "Paid out"),
        el("option", { value: "drop" }, "Cash drop")
      ]);
      const amount = input({ name: "movementAmount", placeholder: "0.00", required: true });
      amount.setAttribute("inputmode", "decimal");
      const note2 = input({ name: "movementNote", placeholder: "Required reason", required: true });
      const dialog = dialogShell("Record cash movement");
      dialog.append(
        field("Movement", kind),
        field("Amount $", amount),
        field("Reason", note2),
        el("div", { class: "view-actions" }, [
          button("Cancel", { onClick: () => dialog.close() }),
          button("Record movement", { primary: true, onClick: submit })
        ])
      );
      openDialog(dialog, kind);
      async function submit() {
        try {
          const amountCents = parseMoneyToCents(amount.value);
          if (amountCents <= 0) throw new Error("Movement amount must be greater than $0");
          if (!note2.value.trim()) throw new Error("A cash movement reason is required");
          await mutate(`${POS_DRAWER_ENDPOINT}/${state2.cashSessionId}/movements`, "POST", {
            kind: kind.value,
            amountCents,
            note: note2.value.trim(),
            idempotencyKey: newIdempotencyKey()
          });
          dialog.close();
          await refreshDrawer();
          renderAll();
          toast("Cash movement recorded.");
        } catch (error) {
          toast(error.message, "err", 6e3);
        }
      }
    }
    function openCloseDrawerDialog() {
      if (!hasOpenDrawer()) return toast("No drawer shift is open.", "warn");
      const counted = input({ name: "countedCents", placeholder: "0.00", required: true });
      counted.setAttribute("inputmode", "decimal");
      const note2 = input({ name: "closeNote", placeholder: "Close note (optional)" });
      const dialog = dialogShell("Close cash drawer shift");
      dialog.append(
        el("p", { class: "view-sub" }, "Count the physical drawer before viewing the final variance."),
        field("Counted cash $", counted),
        field("Note", note2),
        el("div", { class: "view-actions" }, [
          button("Cancel", { onClick: () => dialog.close() }),
          button("Close shift", { danger: true, onClick: submit })
        ])
      );
      openDialog(dialog, counted);
      async function submit() {
        try {
          const response = await mutate(`${POS_DRAWER_ENDPOINT}/${state2.cashSessionId}/close`, "POST", {
            countedCents: parseMoneyToCents(counted.value),
            note: note2.value.trim() || void 0
          });
          const data = response.data || response;
          const variance = data.reconciliation?.varianceCents;
          state2 = setRegisterContext(state2, { cashSessionId: null });
          drawer = null;
          persist();
          dialog.close();
          renderAll();
          toast(Number.isSafeInteger(variance) ? `Shift closed. Variance ${formatCents(variance)}.` : "Shift closed.");
        } catch (error) {
          toast(error.message, "err", 6e3);
        }
      }
    }
    async function refreshReadiness() {
      try {
        readiness = await getData(POS_READINESS_ENDPOINT);
        readinessError = null;
        const configuredTax = readiness?.settings?.taxBps;
        if (!state2.pendingCheckout && Number.isSafeInteger(configuredTax) && configuredTax !== state2.active.taxBps) {
          state2 = { ...state2, active: setCartPricing(state2.active, { taxBps: configuredTax }) };
          persist();
        }
      } catch (error) {
        readiness = null;
        readinessError = error;
      }
    }
    function renderReadiness() {
      clear(readinessSlot);
      if (readinessError) {
        readinessSlot.append(el("div", { class: "error-banner", role: "alert" }, `Register setup could not be verified: ${readinessError.message || "request failed"}`));
        return;
      }
      const blockers = (readiness?.blockers || []).filter((blocker) => blocker.blocking);
      if (!blockers.length) return;
      readinessSlot.append(el("div", { class: "blocked", role: "note" }, [
        el("strong", {}, "Register setup required. "),
        el("ul", { style: "margin:6px 0 0 18px" }, blockers.map((blocker) => el("li", {}, blocker.message)))
      ]));
    }
    async function searchCatalog() {
      const term = searchBox.value.trim();
      if (!term) {
        clear(searchResults);
        searchResults.append(el("p", { class: "view-sub" }, "Scan or enter an item name, SKU, or barcode."));
        return;
      }
      clear(searchResults);
      searchResults.append(el("div", { class: "loading" }, "Searching catalog\u2026"));
      try {
        const lookup = await getData(POS_CATALOG_ENDPOINT, { code: term });
        const matches = Array.isArray(lookup?.matches) ? lookup.matches.map((match) => normalizeCatalogMatch(match, term)).filter((match) => !match.archived) : [];
        clear(searchResults);
        if (!matches.length) {
          searchResults.append(
            emptyState({
              icon: "\u{1F50E}",
              title: "No sellable item found",
              message: `Nothing in this catalog matches \u201C${term}\u201D. Add a custom line only if this is intentionally off-catalog.`
            })
          );
          announce("No sellable item found");
          return;
        }
        const exact = (lookup.matchType === "barcode" || lookup.matchType === "sku") && matches.length === 1;
        if (exact && matches[0].unitPriceCents !== null) {
          addMatch(matches[0]);
          return;
        }
        searchResults.append(
          el("div", { class: "grid", style: "margin-top:10px" }, matches.map((match) => catalogResult(match)))
        );
        announce(`${matches.length} catalog match${matches.length === 1 ? "" : "es"}`);
      } catch (error) {
        clear(searchResults);
        searchResults.append(el("div", { class: "error-banner", role: "alert" }, error.message || "Catalog search failed."));
      }
    }
    function catalogResult(match) {
      const canSell = match.unitPriceCents !== null;
      return el("div", { class: "card", style: "box-shadow:none;padding:12px" }, [
        el("div", { style: "display:flex;justify-content:space-between;gap:12px;align-items:center" }, [
          el("div", {}, [
            el("strong", {}, match.description),
            match.sku ? el("div", { class: "hint" }, `SKU ${match.sku}`) : null,
            canSell ? chip(formatCents(match.unitPriceCents), "ok") : chip("Price not set", "high"),
            match.stockAvailable !== null ? el("div", { class: "hint" }, `${match.stockAvailable} available at the register location`) : null
          ]),
          button(canSell ? "Add" : "Unavailable", {
            primary: canSell,
            disabled: !canSell || Boolean(state2.pendingCheckout),
            onClick: () => addMatch(match)
          })
        ])
      ]);
    }
    function addMatch(match) {
      if (cartLocked()) return;
      if (match.unitPriceCents === null) return toast("Set an integer-cent catalog price before selling this item.", "warn");
      try {
        state2 = {
          ...state2,
          active: addCartLine(state2.active, {
            variationId: match.variationId,
            description: match.description,
            sku: match.sku,
            barcode: match.barcode,
            qty: 1,
            unitPriceCents: match.unitPriceCents
          })
        };
        persist();
        searchBox.value = "";
        clear(searchResults);
        renderAll();
        toast(`${match.description} added.`);
        announce(`${match.description} added to cart`);
        searchBox.focus();
      } catch (error) {
        toast(error.message, "err");
      }
    }
    function renderCart() {
      clear(cartSlot);
      const cart = state2.active;
      const totals = cartTotals(cart);
      const locked = Boolean(state2.pendingCheckout);
      const actions = el("div", { class: "view-actions", style: "margin-bottom:12px" }, [
        button("Hold cart", { disabled: locked || !cart.lines.length, onClick: openHoldDialog }),
        button("Clear cart", { danger: true, disabled: locked || !cart.lines.length, onClick: clearCart })
      ]);
      if (!cart.lines.length) {
        cartSlot.append(
          section(
            "Cart",
            actions,
            emptyState({ icon: "\u{1F6D2}", title: "Cart is empty", message: "Scan an item, search the catalog, or add a custom line." })
          )
        );
        return;
      }
      const lines = cart.lines.map(
        (line, index) => el("div", { style: "display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;padding:12px 0;border-bottom:1px solid var(--border)" }, [
          el("div", {}, [
            el("strong", {}, line.description),
            line.sku ? el("div", { class: "hint" }, `SKU ${line.sku}`) : null,
            el("div", { class: "view-sub" }, `${formatCents(line.unitPriceCents)} each \xB7 ${formatCents(totals.lineTotalsCents[index])}`)
          ]),
          el("div", { style: "display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end" }, [
            button("\u2212", { disabled: locked, title: `Decrease ${line.description}`, onClick: () => updateActive(decrementLine(cart, line.id)) }),
            el("strong", { style: "min-width:2ch;text-align:center;font-variant-numeric:tabular-nums", "aria-label": `Quantity ${line.qty}` }, String(line.qty)),
            button("+", { disabled: locked, title: `Increase ${line.description}`, onClick: () => updateActive(incrementLine(cart, line.id)) }),
            button("Remove", { disabled: locked, danger: true, onClick: () => updateActive(removeLine(cart, line.id)) })
          ])
        ])
      );
      cartSlot.append(section(`Cart \xB7 ${cartItemCount(cart)} item${cartItemCount(cart) === 1 ? "" : "s"}`, actions, ...lines));
    }
    function renderCustomer() {
      clear(customerSlot);
      const selected = state2.active.customerId;
      const search = input({ name: "customerSearch", placeholder: "Name, email, phone, or exact ID" });
      const results = el("div", { "aria-live": "polite" });
      customerSlot.append(
        section(
          "Guest",
          selected ? el("div", { class: "blocked", style: "border-left-color:var(--ok);background:var(--ok-weak)" }, [
            el("strong", {}, "Attached: "),
            el("span", { style: "font-family:var(--font-mono);overflow-wrap:anywhere" }, selected),
            button("Remove", { disabled: Boolean(state2.pendingCheckout), onClick: () => updateActive(setCustomer(state2.active, null)) })
          ]) : el("p", { class: "view-sub" }, "Optional. Walk-up sales remain anonymous."),
          field("Find guest", search),
          button("Search guests", { disabled: Boolean(state2.pendingCheckout), onClick: () => findCustomers(search, results) }),
          results
        )
      );
      search.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          findCustomers(search, results);
        }
      });
    }
    async function findCustomers(search, results) {
      const term = search.value.trim();
      if (!term) return toast("Enter a customer name, email, phone, or ID.", "warn");
      clear(results);
      results.append(el("div", { class: "loading" }, "Searching customers\u2026"));
      const query = { limit: 25 };
      if (term.includes("@")) query.email = term;
      else if (/^[0-9+()\-\s]+$/.test(term)) query.phone = term;
      else query.name = term;
      try {
        let rows = (await getList("/api/customers/profiles", query)).data || [];
        if (!rows.length) {
          try {
            const exact = await getData(`/api/customers/profiles/${encodeURIComponent(term)}`);
            rows = exact ? [exact] : [];
          } catch {
          }
        }
        clear(results);
        if (!rows.length) {
          results.append(el("p", { class: "view-sub", style: "margin-top:10px" }, "No customer found. This sale can remain anonymous."));
          return;
        }
        results.append(...rows.map((profile) => {
          const name = `${profile.first_name || profile.firstName || ""} ${profile.last_name || profile.lastName || ""}`.trim();
          const label2 = name || profile.email || profile.phone || profile.id;
          return el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px" }, [
            el("span", {}, label2),
            button("Attach", { onClick: () => updateActive(setCustomer(state2.active, profile.id)) })
          ]);
        }));
      } catch (error) {
        clear(results);
        results.append(el("div", { class: "error-banner" }, error.message || "Customer search failed."));
      }
    }
    function renderPricing() {
      clear(pricingSlot);
      const cart = state2.active;
      const locked = Boolean(state2.pendingCheckout);
      const tax = input({ name: "taxPercent", value: bpsText(cart.taxBps), placeholder: "0.00", type: "text" });
      tax.setAttribute("inputmode", "decimal");
      tax.readOnly = true;
      tax.setAttribute("aria-readonly", "true");
      const discountPercent = input({ name: "discountPercent", value: bpsText(cart.discountBps), placeholder: "0.00", type: "text" });
      discountPercent.setAttribute("inputmode", "decimal");
      const discountFixed = input({ name: "discountFixed", value: centsInput(cart.discountFixedCents), placeholder: "0.00", type: "text" });
      discountFixed.setAttribute("inputmode", "decimal");
      for (const control of [discountPercent, discountFixed]) control.disabled = locked;
      discountPercent.addEventListener("change", () => updatePricing({ discountBps: parsePercentToBps(discountPercent.value) }, discountPercent));
      discountFixed.addEventListener("change", () => updatePricing({ discountFixedCents: parseMoneyToCents(discountFixed.value) }, discountFixed));
      const totals = cartTotals(cart);
      pricingSlot.append(
        section(
          "Totals",
          el("details", { class: "pos-price-options" }, [
            el("summary", {}, `Tax ${bpsText(cart.taxBps)}% \xB7 Discounts`),
            el("div", { class: "pos-price-fields" }, [
              field("Tax %", tax, "Set by the owner."),
              field("Discount %", discountPercent),
              field("Discount $", discountFixed)
            ])
          ]),
          totalRow("Subtotal", totals.subtotalCents),
          totalRow("Discount", -totals.discountCents),
          totalRow("Tax", totals.taxCents),
          totalRow("Total", totals.totalCents, true)
        )
      );
    }
    function updatePricing(patch2, control) {
      try {
        updateActive(setCartPricing(state2.active, patch2));
      } catch (error) {
        control.setAttribute("aria-invalid", "true");
        toast(error.message, "err");
        renderPricing();
      }
    }
    function totalRow(label2, cents, strong = false) {
      return el("div", { style: `display:flex;justify-content:space-between;gap:12px;padding:6px 0;${strong ? "font-size:1.35rem;border-top:2px solid var(--border);margin-top:6px" : ""}` }, [
        el(strong ? "strong" : "span", {}, label2),
        el(strong ? "strong" : "span", { style: "font-variant-numeric:tabular-nums" }, formatCents(cents))
      ]);
    }
    function renderCheckout() {
      clear(checkoutSlot);
      const totals = cartTotals(state2.active);
      const pending = state2.pendingCheckout;
      const operational = readiness?.operational === true;
      const pay = button(pending?.paymentKind === "card_present" ? "Refresh card status" : pending ? "Recover payment" : `Take payment \xB7 ${formatCents(totals.totalCents)}`, {
        primary: true,
        big: true,
        disabled: busy || !pending && (!state2.active.lines.length || !operational),
        onClick: pending ? recoverPendingCheckout : () => openCheckoutDialog(totals.totalCents)
      });
      const card = readiness?.tenders?.cardPresent;
      const cardReady = cardPresentReady();
      const cardReason = (readiness?.blockers || []).find(
        (blocker) => blocker.code === "card_present_not_configured" || blocker.code === "card_reader_not_verified"
      )?.message;
      checkoutSlot.append(
        section(
          "Payment",
          cardReady ? el("div", { class: "blocked", role: "note", style: "border-left-color:var(--ok);background:var(--ok-weak)" }, [
            el("strong", {}, "Card reader verified. "),
            el("span", {}, "Online \xB7 Full or split payments available.")
          ]) : el("div", { class: "blocked", role: "note" }, [
            el("strong", {}, card?.configured ? "Card reader not verified. " : "Card reader not configured. "),
            el("span", {}, cardReason || "Connect a card reader in Settings to accept card payments.")
          ]),
          pay
        )
      );
    }
    function renderPending() {
      clear(pendingSlot);
      const pending = state2.pendingCheckout;
      if (!pending) return;
      if (pending.paymentKind === "card_present") {
        if (pending.awaitingPayment) {
          const canceling = splitBalance?.cancellationStarted;
          pendingSlot.append(section(
            canceling ? "Canceling split payment" : "Split payment",
            el("div", { class: "split-payment-summary", role: "status" }, splitBalance ? canceling ? `${formatCents(splitBalance.refundedCents)} refunded \xB7 ${formatCents(splitBalance.netPaidCents)} awaiting refund` : `${formatCents(splitBalance.capturedCents)} paid \xB7 ${formatCents(splitBalance.remainingCents)} remaining` : "Restoring the paid and remaining amounts\u2026"),
            el("p", { class: "view-sub" }, canceling ? "Refunds go to the original cards. The cart stays locked until every refund is confirmed." : "Payments already approved are saved. Complete the balance or cancel and refund the cards."),
            el("div", { class: "view-actions" }, [
              !canceling ? button("Take next payment", {
                primary: true,
                big: true,
                disabled: busy || !splitBalance,
                onClick: () => openCheckoutDialog(splitBalance.remainingCents, true)
              }) : null,
              button(canceling ? "Retry / check refunds" : "Cancel split & refund", {
                danger: true,
                disabled: busy || !splitBalance,
                onClick: cancelIncompleteSplit
              }),
              button("Refresh balance", { disabled: busy, onClick: recoverPendingCheckout }),
              button("Open order", { href: `#/orders/${pending.orderId}` })
            ])
          ));
          return;
        }
        const attempt = activeCardAttempt?.id === pending.attemptId ? activeCardAttempt : null;
        const status = attempt?.status || (pending.attemptId ? "checking" : pending.orderId ? "starting" : "preparing");
        const processing = status === "pending" || status === "processing" || status === "checking" || status === "starting" || status === "preparing";
        const failed = status === "failed";
        const canceled = status === "canceled";
        const succeeded = status === "succeeded";
        const title = failed ? "Card payment failed. " : canceled ? "Card payment canceled. " : succeeded ? "Card approved; verifying the order. " : "Terminal payment in progress. ";
        const detail = failed ? `${attempt?.failure_message || "The processor did not complete this attempt."} No sale has been completed from this attempt.` : canceled ? "The terminal attempt is canceled and no sale has been completed from it." : succeeded ? "The processor reports success, but this register will remain locked until the server also reports the order paid." : `${cardTerminal?.actionStatus ? `Terminal action: ${cardTerminal.actionStatus}. ` : ""}No payment is recorded until the server reports both a succeeded attempt and a paid order.`;
        pendingSlot.append(
          el("div", { class: failed || canceled ? "error-banner" : "blocked", role: "status" }, [
            el("strong", {}, title),
            el("span", {}, detail),
            el("div", { class: "view-actions", style: "margin-top:10px" }, [
              button("Refresh status", { primary: processing || succeeded, disabled: busy, onClick: recoverPendingCheckout }),
              pending.attemptId && (status === "pending" || status === "processing" || status === "checking") ? button("Cancel card attempt", { danger: true, disabled: busy, onClick: cancelCardPayment }) : null,
              !pending.attemptId ? button("Stop checkout", { disabled: busy, onClick: stopUnstartedCardCheckout }) : null,
              failed || canceled ? button("Return to checkout", { disabled: busy, onClick: releaseTerminalCardCheckout }) : null,
              pending.orderId ? button("Open order", { href: `#/orders/${pending.orderId}` }) : null
            ])
          ])
        );
        return;
      }
      pendingSlot.append(
        el("div", { class: "error-banner", role: "alert" }, [
          el("strong", {}, "Payment needs recovery. "),
          el("span", {}, `Order ${pending.orderId} was created. This cart is locked so retrying cannot create a duplicate sale. `),
          button("Recover now", { primary: true, disabled: busy, onClick: recoverPendingCheckout }),
          button("Open order", { href: `#/orders/${pending.orderId}` })
        ])
      );
    }
    function renderSuccess() {
      clear(successSlot);
      if (!lastSale) return;
      const order = lastSale.order;
      successSlot.append(
        section(
          "Sale complete",
          el("div", { style: "font-size:1.5rem;font-weight:800;color:var(--ok);margin-bottom:8px" }, formatCents(order.total_cents ?? order.totalCents ?? 0)),
          changeDueOf(lastSale.tenders) !== null ? el("div", { style: "font-size:1.25rem;font-weight:800;margin-bottom:8px" }, `Change due ${formatCents(changeDueOf(lastSale.tenders))}`) : null,
          el("p", { class: "view-sub" }, `Paid order ${order.id}`),
          el("div", { class: "view-actions" }, [
            button("Print receipt", { primary: true, onClick: printReceipt }),
            button("Open order", { href: `#/orders/${order.id}` })
          ])
        )
      );
    }
    function renderHolds() {
      clear(holdsSlot);
      const holds = state2.holds;
      holdsSlot.append(
        section(
          `Held carts \xB7 ${holds.length}`,
          holds.length ? el("div", {}, holds.map(
            (hold) => el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px 0;border-bottom:1px solid var(--border)" }, [
              el("div", {}, [
                el("strong", {}, hold.name),
                el("div", { class: "view-sub" }, `${cartItemCount(hold.cart)} items \xB7 ${formatCents(cartTotals(hold.cart).totalCents)} \xB7 ${new Date(hold.heldAt).toLocaleString()}`)
              ]),
              el("div", { class: "view-actions" }, [
                button("Resume", { disabled: Boolean(state2.pendingCheckout), onClick: () => resumeHold(hold.id) }),
                button("Delete", { danger: true, disabled: Boolean(state2.pendingCheckout), onClick: () => deleteHold(hold.id) })
              ])
            ])
          )) : el("p", { class: "view-sub" }, "No held carts on this device.")
        )
      );
    }
    function openCustomLineDialog() {
      if (cartLocked()) return;
      const description = input({ name: "description", placeholder: "Item or service", required: true });
      const price = input({ name: "price", placeholder: "0.00", required: true });
      price.setAttribute("inputmode", "decimal");
      const qty = input({ name: "qty", type: "number", value: "1", min: 1, required: true });
      const dialog = dialogShell("Add custom item");
      const form = el("form", { method: "dialog" }, [
        field("Description", description),
        field("Unit price $", price, "Enter the price for one item."),
        field("Quantity", qty),
        el("div", { class: "view-actions" }, [
          button("Cancel", { onClick: () => dialog.close() }),
          button("Add to cart", { primary: true, onClick: submit })
        ])
      ]);
      dialog.append(form);
      openDialog(dialog, description);
      function submit() {
        try {
          const quantity = Number(qty.value);
          state2 = {
            ...state2,
            active: addCartLine(state2.active, {
              description: description.value.trim(),
              qty: quantity,
              unitPriceCents: parseMoneyToCents(price.value)
            })
          };
          persist();
          dialog.close();
          renderAll();
        } catch (error) {
          toast(error.message, "err");
        }
      }
    }
    function openHoldDialog() {
      if (cartLocked() || !state2.active.lines.length) return;
      const name = input({ name: "holdName", placeholder: "Customer name or pickup note" });
      const dialog = dialogShell("Hold this cart");
      dialog.append(
        field("Cart label", name, "Optional. Kept only on this device."),
        el("div", { class: "view-actions" }, [
          button("Cancel", { onClick: () => dialog.close() }),
          button("Hold cart", { primary: true, onClick: () => {
            try {
              state2 = holdActiveCart(state2, { name: name.value });
              persist();
              dialog.close();
              renderAll();
              searchBox.focus();
            } catch (error) {
              toast(error.message, "err");
            }
          } })
        ])
      );
      openDialog(dialog, name);
    }
    function resumeHold(id) {
      try {
        state2 = resumeHeldCart(state2, id);
        persist();
        renderAll();
      } catch (error) {
        toast(error.message, "warn");
      }
    }
    async function deleteHold(id) {
      const accepted = await confirmAction({
        title: "Delete held cart?",
        message: "This held cart will be removed from this device. This action cannot be undone.",
        confirmLabel: "Delete held cart",
        cancelLabel: "Keep cart",
        danger: true
      });
      if (!accepted) return;
      state2 = removeHeldCart(state2, id);
      persist();
      renderHolds();
    }
    async function clearCart() {
      if (cartLocked() || !state2.active.lines.length) return;
      const accepted = await confirmAction({
        title: "Clear this cart?",
        message: "Every item in the active cart will be removed. This action cannot be undone.",
        confirmLabel: "Clear cart",
        cancelLabel: "Keep items",
        danger: true
      });
      if (!accepted) return;
      state2 = { ...state2, active: setCartPricing(createCart(), { taxBps: state2.active.taxBps }) };
      persist();
      clear(searchResults);
      renderAll();
      searchBox.focus();
    }
    function openCheckoutDialog(totalCents, resumeSplit = false) {
      if (!state2.active.lines.length || !resumeSplit && cartLocked()) return;
      const dialog = dialogShell("Take payment");
      const cashOpen = hasOpenDrawer();
      const cardReady = cardPresentReady();
      const mode = el("select", { name: "tenderMode" }, [
        el("option", { value: "cash", disabled: !cashOpen }, cashOpen ? "Cash" : "Cash \u2014 open drawer first"),
        el("option", { value: "external" }, "External payment \u2014 manually verified"),
        el("option", { value: "card_present", disabled: !cardReady }, cardReady ? "Card \u2014 verified reader" : "Card \u2014 verified reader required"),
        el("option", { value: "split_card_cash", disabled: !cardReady || !cashOpen }, "Split cash + card"),
        el("option", { value: "split_cards", disabled: !cardReady }, "Split across cards"),
        el("option", { value: "split", disabled: !cashOpen }, cashOpen ? "Split cash + external" : "Split \u2014 open drawer first")
      ]);
      mode.value = cashOpen ? "cash" : "external";
      const controls = el("div");
      const complete = button(`Complete ${formatCents(totalCents)} sale`, { primary: true, big: true, onClick: submit });
      const actions = el("div", { class: "view-actions" }, [
        button("Cancel", { onClick: () => dialog.close() }),
        complete
      ]);
      dialog.append(
        el("p", { style: "font-size:1.35rem;font-weight:800" }, `Amount due ${formatCents(totalCents)}`),
        field("Tender", mode),
        controls,
        actions
      );
      mode.addEventListener("change", paintControls);
      paintControls();
      openDialog(dialog, mode);
      function paintControls() {
        clear(controls);
        complete.textContent = mode.value === "card_present" ? `Send ${formatCents(totalCents)} to reader` : `Complete ${formatCents(totalCents)} sale`;
        if (mode.value === "cash") {
          const received = input({ name: "cashReceived", value: centsInput(totalCents), required: true });
          received.setAttribute("inputmode", "decimal");
          controls.append(field("Cash received $", received, `Amount due ${formatCents(totalCents)}. Change is calculated before recording.`));
          return;
        }
        if (mode.value === "split_card_cash" || mode.value === "split_cards") {
          const portion = input({ name: "splitPortion", value: centsInput(Math.floor(totalCents / 2)), required: true });
          portion.setAttribute("inputmode", "decimal");
          const hint = el("p", { class: "split-payment-summary", role: "status" });
          const update = () => {
            try {
              const entered = parseMoneyToCents(portion.value);
              const cardAmount = mode.value === "split_card_cash" ? totalCents - entered : entered;
              hint.textContent = `First card ${formatCents(cardAmount)} \xB7 Remaining ${formatCents(totalCents - cardAmount)}`;
            } catch {
              hint.textContent = "Enter the split amount.";
            }
          };
          portion.addEventListener("input", update);
          controls.append(
            field(mode.value === "split_card_cash" ? "Cash portion $" : "First card amount $", portion),
            hint,
            el("p", { class: "view-sub" }, "Process the first card, then collect the remaining balance. Each payment is saved separately.")
          );
          complete.textContent = "Start split payment";
          update();
          return;
        }
        if (mode.value === "card_present") {
          const card = readiness?.tenders?.cardPresent;
          controls.append(el("div", { class: "blocked", role: "note", style: "border-left-color:var(--ok);background:var(--ok-weak)" }, [
            el("strong", {}, `${card?.readerId || "Card reader"} verified. `),
            el("span", {}, "The next screen will remain in processing until the server confirms the card attempt succeeded and the order is paid.")
          ]));
          return;
        }
        const provider = input({ name: "externalProvider", placeholder: "Check, bank transfer, invoice, etc.", required: true });
        const reference = input({ name: "externalReference", placeholder: "Required transaction / check reference", required: true });
        controls.append(field("External payment source", provider), field("Reference", reference));
        if (mode.value === "split") {
          const cash = input({ name: "cashAmount", placeholder: "0.00" });
          cash.setAttribute("inputmode", "decimal");
          const received = input({ name: "cashReceived", placeholder: "0.00" });
          received.setAttribute("inputmode", "decimal");
          controls.prepend(
            field("Cash amount $", cash, "The remainder is recorded as external payment."),
            field("Cash received $", received, "Must be at least the cash amount.")
          );
        }
      }
      let confirming = false;
      async function submit() {
        if (confirming) return;
        try {
          if (["card_present", "split_card_cash", "split_cards"].includes(mode.value)) {
            let amountCents;
            if (mode.value !== "card_present") {
              const portion = parseMoneyToCents(controls.querySelector('[name="splitPortion"]').value);
              if (portion <= 0 || portion >= totalCents) throw new Error("The split amount must be greater than zero and below the balance due");
              amountCents = mode.value === "split_card_cash" ? totalCents - portion : portion;
            }
            if (!cardPresentReady()) throw new Error("The card reader is not currently online and verified");
            dialog.close();
            if (resumeSplit) continueCardSplit(amountCents);
            else beginCardCheckout(amountCents);
            return;
          }
          const plan = tenderInputs(mode.value, controls, totalCents);
          const changeDue = plannedChangeDue(plan);
          if (changeDue !== null) {
            const cashTender = plan.find((tender) => tender.kind === "cash");
            confirming = true;
            complete.disabled = true;
            const accepted = await confirmAction({
              title: "Confirm cash and change",
              message: `Cash received ${formatCents(cashTender.cashReceivedCents)}. Give the customer ${formatCents(changeDue)} in change, then complete the sale.`,
              confirmLabel: "Complete sale",
              cancelLabel: "Review payment"
            });
            confirming = false;
            complete.disabled = false;
            if (!accepted) return;
          }
          dialog.close();
          if (resumeSplit) finishSplitWithManual(plan);
          else beginCheckout(plan);
        } catch (error) {
          confirming = false;
          complete.disabled = false;
          toast(error.message, "err");
        }
      }
    }
    function tenderInputs(mode, controls, totalCents) {
      if (totalCents === 0) return buildTenderPlan(0, []);
      if (mode === "cash") {
        if (!hasOpenDrawer()) throw new Error("Open a cash drawer shift before taking cash");
        const cashReceivedCents2 = parseMoneyToCents(controls.querySelector('[name="cashReceived"]')?.value || "");
        if (cashReceivedCents2 < totalCents) throw new Error("Cash received must be at least the amount due");
        return buildTenderPlan(totalCents, [{ kind: "cash", amountCents: totalCents, cashReceivedCents: cashReceivedCents2 }], { keyFactory: newIdempotencyKey });
      }
      const provider = controls.querySelector('[name="externalProvider"]')?.value.trim();
      const providerRef = controls.querySelector('[name="externalReference"]')?.value.trim();
      if (!provider) throw new Error("External payment source is required");
      if (!providerRef) throw new Error("External payment reference is required");
      if (mode === "external") {
        return buildTenderPlan(totalCents, [{ kind: "external", amountCents: totalCents, provider, providerRef }], { keyFactory: newIdempotencyKey });
      }
      if (!hasOpenDrawer()) throw new Error("Open a cash drawer shift before taking split cash");
      const cashCents = parseMoneyToCents(controls.querySelector('[name="cashAmount"]')?.value || "");
      if (cashCents <= 0 || cashCents >= totalCents) throw new Error("Split cash must be greater than $0 and less than the amount due");
      const cashReceivedCents = parseMoneyToCents(controls.querySelector('[name="cashReceived"]')?.value || "");
      if (cashReceivedCents < cashCents) throw new Error("Cash received must be at least the cash portion");
      return buildTenderPlan(totalCents, [
        { kind: "cash", amountCents: cashCents, cashReceivedCents },
        { kind: "external", amountCents: totalCents - cashCents, provider, providerRef }
      ], { keyFactory: newIdempotencyKey });
    }
    function beginCardCheckout(amountCents) {
      if (busy || state2.pendingCheckout) return;
      if (!cardPresentReady()) return toast("The card reader is not currently online and verified.", "warn");
      activeCardAttempt = null;
      cardTerminal = null;
      state2 = setPendingCheckout(state2, {
        paymentKind: "card_present",
        ...amountCents === void 0 ? {} : { amountCents },
        orderId: null,
        cartId: state2.active.id,
        orderIdempotencyKey: newIdempotencyKey(),
        attemptIdempotencyKey: newIdempotencyKey(),
        attemptId: null,
        startedAt: (/* @__PURE__ */ new Date()).toISOString()
      });
      persist();
      renderAll();
      recoverPendingCheckout();
    }
    async function recoverCardCheckout(pending) {
      let current = pending;
      if (!current.orderId) {
        await refreshReadiness();
        if (!cardPresentReady()) throw new Error("The verified card reader is no longer available. Refresh when it is online, or stop this checkout.");
        const expectedTotalCents = cartTotals(state2.active).totalCents;
        const orderPayload = {
          ...toOrderPayload(state2.active),
          registerId: state2.registerId,
          ...hasOpenDrawer() ? { cashSessionId: state2.cashSessionId } : {}
        };
        const createdBody = await mutate(POS_ORDER_ENDPOINT, "POST", orderPayload, {
          idempotencyKey: current.orderIdempotencyKey
        });
        const order = createdBody.data || createdBody;
        const authoritativeTotalCents = order.total_cents ?? order.totalCents;
        if (!Number.isSafeInteger(authoritativeTotalCents) || authoritativeTotalCents < 0) {
          throw new Error("Server did not return an integer-cent order total");
        }
        if (authoritativeTotalCents <= 0) {
          state2 = clearPendingCheckout(state2);
          persist();
          throw new Error("This order has no positive card balance. Choose another completion method.");
        }
        if (authoritativeTotalCents !== expectedTotalCents) {
          const accepted = await confirmAction({
            title: "Confirm updated card total",
            message: `The total changed from ${formatCents(expectedTotalCents)} to ${formatCents(authoritativeTotalCents)} after current pricing, promotions, and tax were applied.`,
            confirmLabel: "Send updated total",
            cancelLabel: "Stop payment"
          });
          if (!accepted) {
            try {
              await mutate(`/api/pos/orders/${order.id}/cancel`, "POST", {});
            } catch {
            }
            state2 = clearPendingCheckout(state2);
            persist();
            throw new Error("Card payment stopped before contacting the reader");
          }
        }
        current = { ...current, orderId: order.id };
        state2 = setPendingCheckout(state2, current);
        persist();
        renderPending();
      }
      if (current.awaitingPayment) {
        splitBalance = await getData(`/api/pos/orders/${current.orderId}/balance`);
        if (isPaidStatus(splitBalance.status)) await finishSale(await getData(`/api/orders/orders/${current.orderId}`));
        else if (splitBalance.status === "canceled" && splitBalance.netPaidCents === 0) await finishCanceledSplit();
        return;
      }
      if (!current.attemptId) {
        const attempts = await getData(`/api/pos/orders/${current.orderId}/payment-attempts`);
        const prior = (Array.isArray(attempts) ? attempts : []).find(
          (attempt2) => attempt2.idempotency_key === current.attemptIdempotencyKey
        );
        if (prior) {
          current = bindCardAttempt(current, prior);
        } else {
          await refreshReadiness();
          if (!cardPresentReady()) throw new Error("The verified card reader is no longer available. No card attempt was started.");
          const startedBody = await mutate(`/api/pos/orders/${current.orderId}/card-payments`, "POST", {
            idempotencyKey: current.attemptIdempotencyKey,
            ...current.amountCents === void 0 ? {} : { amountCents: current.amountCents }
          }, {
            idempotencyKey: current.attemptIdempotencyKey
          });
          const started = startedBody.data || startedBody;
          const attempt2 = started.attempt || started;
          if (!attempt2?.id) throw new Error("The server did not return a durable card payment attempt");
          cardTerminal = started.terminal || attempt2.provider_data?.terminal || null;
          current = bindCardAttempt(current, attempt2);
        }
      } else {
        const attempt2 = await getData(`/api/pos/payment-attempts/${current.attemptId}`);
        activeCardAttempt = attempt2;
        cardTerminal = attempt2?.provider_data?.terminal || cardTerminal;
      }
      const attempt = activeCardAttempt;
      if (!attempt || attempt.id !== current.attemptId) throw new Error("Card payment status could not be verified");
      if (attempt.status === "succeeded") {
        const order = await getData(`/api/orders/orders/${current.orderId}`);
        if (!isPaidStatus(order.status)) {
          splitBalance = await getData(`/api/pos/orders/${current.orderId}/balance`);
          if (splitBalance.status === "canceled" && splitBalance.netPaidCents === 0) {
            await finishCanceledSplit();
            return;
          }
          if (splitBalance.remainingCents > 0 && splitBalance.capturedCents > 0) {
            state2 = setPendingCheckout(state2, { ...current, awaitingPayment: true });
            persist();
            announce(`Payment approved. ${formatCents(splitBalance.remainingCents)} remaining.`);
            return;
          }
          throw new Error(`Card attempt succeeded, but order status is ${order.status}. Refresh payment status.`);
        }
        await finishSale(order);
        return;
      }
      if (attempt.status === "failed" || attempt.status === "canceled") return;
      if (attempt.status !== "pending" && attempt.status !== "processing") {
        throw new Error(`Unknown card payment status: ${attempt.status}`);
      }
      scheduleCardPoll();
    }
    function bindCardAttempt(pending, attempt) {
      const next = { ...pending, attemptId: attempt.id };
      state2 = setPendingCheckout(state2, next);
      activeCardAttempt = attempt;
      cardTerminal = attempt?.provider_data?.terminal || cardTerminal;
      persist();
      renderPending();
      return next;
    }
    function scheduleCardPoll(delay = 2500) {
      if (cardPollTimer) clearTimeout(cardPollTimer);
      cardPollTimer = setTimeout(() => {
        cardPollTimer = null;
        if (!container.isConnected || state2.pendingCheckout?.paymentKind !== "card_present") return;
        recoverPendingCheckout();
      }, delay);
    }
    async function finishCanceledSplit() {
      if (cardPollTimer) clearTimeout(cardPollTimer);
      cardPollTimer = null;
      state2 = completePendingCheckout(state2);
      activeCardAttempt = null;
      cardTerminal = null;
      splitBalance = null;
      persist();
      await refreshDrawer();
      toast("Split canceled. All approved card payments were refunded.");
      announce("Split canceled and refunded");
    }
    async function cancelIncompleteSplit() {
      const pending = state2.pendingCheckout;
      if (busy || !pending?.awaitingPayment || !splitBalance) return;
      busy = true;
      renderAll();
      try {
        if (!splitBalance.cancellationStarted && !await confirmAction({
          title: "Cancel split and refund cards?",
          message: `Refund ${formatCents(splitBalance.netPaidCents)} to the original cards and cancel this sale.`,
          confirmLabel: "Refund and cancel",
          cancelLabel: "Continue sale",
          danger: true
        })) return;
        await mutate(`/api/pos/orders/${pending.orderId}/cancel-split`, "POST", {});
        splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
        if (splitBalance.status === "canceled" && splitBalance.netPaidCents === 0) await finishCanceledSplit();
        else toast("Refunds requested. Waiting for processor confirmation.", "warn");
      } catch (error) {
        try {
          splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
        } catch {
        }
        toast(error.message || "Refund status needs another check.", "err", 6e3);
      } finally {
        busy = false;
        renderAll();
      }
    }
    async function cancelCardPayment() {
      const pending = state2.pendingCheckout;
      if (busy || pending?.paymentKind !== "card_present" || !pending.attemptId) return;
      if (cardPollTimer) clearTimeout(cardPollTimer);
      cardPollTimer = null;
      busy = true;
      renderAll();
      try {
        const accepted = await confirmAction({
          title: "Cancel card payment?",
          message: "Ask the customer to stop using the reader. The cart stays locked until the processor confirms cancellation.",
          confirmLabel: "Cancel card payment",
          cancelLabel: "Keep processing",
          danger: true
        });
        if (!accepted) return;
        const canceledBody = await mutate(`/api/pos/payment-attempts/${pending.attemptId}/cancel`, "POST", {});
        activeCardAttempt = canceledBody.data || canceledBody;
        cardTerminal = activeCardAttempt?.provider_data?.terminal || cardTerminal;
        if (activeCardAttempt?.status !== "canceled") {
          throw new Error(`Cancel was not confirmed (attempt status: ${activeCardAttempt?.status || "unknown"})`);
        }
        toast("Card attempt canceled. No payment was recorded.");
      } catch (error) {
        toast(error.message || "Card attempt could not be canceled.", "err", 6e3);
      } finally {
        busy = false;
        renderAll();
        if (state2.pendingCheckout?.paymentKind === "card_present" && (activeCardAttempt?.status === "pending" || activeCardAttempt?.status === "processing")) scheduleCardPoll();
      }
    }
    async function stopUnstartedCardCheckout() {
      const pending = state2.pendingCheckout;
      if (busy || pending?.paymentKind !== "card_present" || pending.attemptId) return;
      busy = true;
      renderAll();
      try {
        if (pending.orderId) {
          const attempts = await getData(`/api/pos/orders/${pending.orderId}/payment-attempts`);
          const prior = (Array.isArray(attempts) ? attempts : []).find(
            (attempt) => attempt.idempotency_key === pending.attemptIdempotencyKey
          );
          if (prior) {
            const bound = bindCardAttempt(pending, prior);
            await recoverCardCheckout(bound);
            if (state2.pendingCheckout?.paymentKind === "card_present") {
              toast("A durable card attempt already exists. Its current status has been restored.", "warn", 6e3);
            }
            return;
          }
        }
        if (pending.orderId) {
          splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
          if (splitBalance.capturedCents > 0) {
            state2 = setPendingCheckout(state2, { ...pending, awaitingPayment: true });
            persist();
            return;
          }
        }
        state2 = clearPendingCheckout(state2);
        activeCardAttempt = null;
        cardTerminal = null;
        persist();
        toast("Card checkout stopped before a terminal attempt was created.");
      } catch (error) {
        toast(error.message || "Card checkout status could not be verified.", "err", 6e3);
      } finally {
        busy = false;
        renderAll();
      }
    }
    async function releaseTerminalCardCheckout() {
      const pending = state2.pendingCheckout;
      if (pending?.paymentKind !== "card_present") return;
      if (activeCardAttempt?.status !== "failed" && activeCardAttempt?.status !== "canceled") return;
      try {
        splitBalance = await getData(`/api/pos/orders/${pending.orderId}/balance`);
        if (splitBalance.capturedCents > 0) {
          state2 = setPendingCheckout(state2, { ...pending, awaitingPayment: true });
          persist();
          renderAll();
          return;
        }
      } catch (error) {
        toast(error.message, "err");
        return;
      }
      state2 = clearPendingCheckout(state2);
      activeCardAttempt = null;
      cardTerminal = null;
      persist();
      renderAll();
      toast("Cart unlocked. Choose a new payment method or start a new card attempt.");
    }
    function continueCardSplit(amountCents) {
      const pending = state2.pendingCheckout;
      if (busy || !pending?.awaitingPayment) return;
      const next = {
        ...pending,
        awaitingPayment: false,
        attemptId: null,
        attemptIdempotencyKey: newIdempotencyKey()
      };
      delete next.amountCents;
      if (amountCents !== void 0) next.amountCents = amountCents;
      state2 = setPendingCheckout(state2, next);
      activeCardAttempt = null;
      cardTerminal = null;
      persist();
      renderAll();
      recoverPendingCheckout();
    }
    function finishSplitWithManual(tenders) {
      const pending = state2.pendingCheckout;
      if (busy || !pending?.awaitingPayment) return;
      state2 = setPendingCheckout(state2, {
        paymentKind: "manual",
        orderId: pending.orderId,
        cartId: pending.cartId,
        tenders,
        startedAt: pending.startedAt
      });
      persist();
      renderAll();
      recoverPendingCheckout();
    }
    async function beginCheckout(tenders) {
      if (busy || state2.pendingCheckout) return;
      busy = true;
      renderCheckout();
      try {
        const expectedTotalCents = cartTotals(state2.active).totalCents;
        const usesCash = tenders.some((tender) => tender.kind === "cash");
        if (usesCash && !hasOpenDrawer()) throw new Error("The cash drawer shift is no longer open");
        const orderPayload = {
          ...toOrderPayload(state2.active),
          registerId: state2.registerId,
          ...hasOpenDrawer() ? { cashSessionId: state2.cashSessionId } : {}
        };
        const createdBody = await mutate(POS_ORDER_ENDPOINT, "POST", orderPayload, { idempotency: true });
        const order = createdBody.data || createdBody;
        const authoritativeTotalCents = order.total_cents ?? order.totalCents;
        if (!Number.isSafeInteger(authoritativeTotalCents) || authoritativeTotalCents < 0) {
          throw new Error("Server did not return an integer-cent order total");
        }
        const authoritativeTenders = repriceTenderPlan(tenders, authoritativeTotalCents);
        if (authoritativeTotalCents !== expectedTotalCents) {
          const changeDue = plannedChangeDue(authoritativeTenders);
          const cashMessage = changeDue === null ? "" : ` Cash received ${formatCents(authoritativeTenders.find((tender) => tender.kind === "cash").cashReceivedCents)}; change due ${formatCents(changeDue)}.`;
          const accepted = await confirmAction({
            title: "Confirm updated total",
            message: `The total changed from ${formatCents(expectedTotalCents)} to ${formatCents(authoritativeTotalCents)} after current pricing, promotions, and tax were applied.${cashMessage}`,
            confirmLabel: "Continue to payment",
            cancelLabel: "Stop payment"
          });
          if (!accepted) {
            try {
              await mutate(`/api/pos/orders/${order.id}/cancel`, "POST", {});
            } catch {
            }
            throw new Error("Payment stopped before tender capture");
          }
        }
        state2 = setPendingCheckout(state2, {
          paymentKind: "manual",
          orderId: order.id,
          cartId: state2.active.id,
          tenders: authoritativeTenders,
          startedAt: (/* @__PURE__ */ new Date()).toISOString()
        });
        persist();
        renderPending();
        await payPending(order.id, authoritativeTenders);
      } catch (error) {
        toast(error.message || "Sale could not be completed.", "err", 6e3);
      } finally {
        busy = false;
        renderAll();
      }
    }
    async function recoverPendingCheckout() {
      if (busy || !state2.pendingCheckout) return;
      if (cardPollTimer) clearTimeout(cardPollTimer);
      cardPollTimer = null;
      busy = true;
      renderAll();
      const pending = state2.pendingCheckout;
      try {
        if (pending.paymentKind === "card_present") {
          await recoverCardCheckout(pending);
        } else {
          const order = await getData(`/api/orders/orders/${pending.orderId}`);
          if (isPaidStatus(order.status)) await finishSale(order);
          else if (order.status === "draft" || order.status === "reserved") await payPending(pending.orderId, pending.tenders);
          else throw new Error(`Order is ${order.status}; open it before taking another payment`);
        }
      } catch (error) {
        toast(error.message || "Payment recovery failed.", "err", 6e3);
        if (state2.pendingCheckout?.paymentKind === "card_present" && (activeCardAttempt?.status === "pending" || activeCardAttempt?.status === "processing")) scheduleCardPoll(5e3);
      } finally {
        busy = false;
        renderAll();
      }
    }
    async function payPending(orderId, tenders) {
      if (tenders.some((tender) => tender.kind === "cash") && !hasOpenDrawer()) {
        throw new Error("Reopen or recover the recorded cash drawer shift before retrying this cash payment");
      }
      await mutate(`/api/pos/orders/${orderId}/pay`, "POST", { tenders });
      const paid = await getData(`/api/orders/orders/${orderId}`);
      if (!isPaidStatus(paid.status)) throw new Error(`Payment did not complete (order status: ${paid.status})`);
      await finishSale(paid);
    }
    async function finishSale(order) {
      if (cardPollTimer) clearTimeout(cardPollTimer);
      cardPollTimer = null;
      let tenders = [];
      let receipt = null;
      try {
        receipt = await getData(`/api/pos/receipts/${order.id}`);
        order = receipt?.order || order;
        tenders = receipt?.tenders || [];
      } catch {
        try {
          tenders = await getData(`/api/orders/orders/${order.id}/tenders`) || [];
        } catch {
        }
      }
      lastSale = { order, tenders, receipt };
      state2 = completePendingCheckout(state2);
      activeCardAttempt = null;
      cardTerminal = null;
      persist();
      await refreshDrawer();
      renderReceipt(receiptSlot, order, tenders, receipt);
      toast("Sale complete.");
      announce("Sale complete");
    }
    function printReceipt() {
      if (!lastSale) return;
      document.body.dataset.print = "receipt";
      window.print();
    }
  });
  function normalizeCatalogMatch(match, searchTerm) {
    if (match?.variationId && !match?.variation) {
      const variationName2 = match.variationName && String(match.variationName).toLowerCase() !== "regular" ? match.variationName : "";
      return {
        variationId: match.variationId,
        description: variationName2 ? `${match.name} \u2014 ${variationName2}` : match.name || `Item ${searchTerm}`,
        sku: match.sku || null,
        barcode: match.barcode || null,
        unitPriceCents: Number.isSafeInteger(match.unitPriceCents) && match.unitPriceCents >= 0 ? match.unitPriceCents : null,
        stockAvailable: Number.isFinite(match.stock?.available) ? match.stock.available : null,
        archived: false
      };
    }
    const variation = match?.variation || match || {};
    const product = match?.product || {};
    const barcode = match?.barcode || {};
    const productName = product.name || match?.productName || "";
    const variationName = variation.name || match?.variationName || "";
    const description = productName ? variationName && variationName.toLowerCase() !== "regular" ? `${productName} \u2014 ${variationName}` : productName : variationName || `Item ${searchTerm}`;
    const rawPrice = variation.price_cents ?? variation.priceCents ?? match?.priceCents;
    return {
      variationId: variation.id || match?.variationId || null,
      description,
      sku: variation.sku || null,
      barcode: barcode.code_raw || barcode.codeRaw || null,
      unitPriceCents: Number.isSafeInteger(rawPrice) && rawPrice >= 0 ? rawPrice : null,
      stockAvailable: null,
      archived: variation.archived === 1 || variation.archived === true || product.archived === 1 || product.archived === true
    };
  }
  function repriceTenderPlan(tenders, totalCents) {
    if (totalCents === 0) return buildTenderPlan(0, []);
    if (tenders.length === 1) {
      return buildTenderPlan(totalCents, [{ ...tenders[0], amountCents: totalCents }]);
    }
    const cash = tenders.find((tender) => tender.kind === "cash");
    const external = tenders.find((tender) => tender.kind === "external");
    if (!cash || !external || cash.amountCents >= totalCents) {
      throw new Error("The authoritative total no longer supports the selected split; choose payment again");
    }
    return buildTenderPlan(totalCents, [
      cash,
      { ...external, amountCents: totalCents - cash.amountCents }
    ]);
  }
  function plannedChangeDue(tenders) {
    const cash = tenders.find((tender) => tender.kind === "cash");
    return cash ? cash.cashReceivedCents - cash.amountCents : null;
  }
  function changeDueOf(tenders) {
    const cash = (tenders || []).find((tender) => tender.kind === "cash");
    if (!cash) return null;
    const stored = cash.change_due_cents ?? cash.changeDueCents;
    if (Number.isSafeInteger(stored)) return stored;
    const received = cash.cash_received_cents ?? cash.cashReceivedCents;
    const amount = cash.amount_cents ?? cash.amountCents;
    return Number.isSafeInteger(received) && Number.isSafeInteger(amount) ? received - amount : 0;
  }
  function bpsText(bps) {
    const whole = Math.floor(bps / 100);
    const fraction = bps % 100;
    return fraction ? `${whole}.${String(fraction).padStart(2, "0").replace(/0$/, "")}` : String(whole);
  }
  function centsInput(cents) {
    const whole = Math.floor(cents / 100);
    return `${whole}.${String(cents % 100).padStart(2, "0")}`;
  }
  function dialogShell(title) {
    return el("dialog", {
      "aria-label": title,
      style: "width:min(560px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:20px;box-shadow:var(--shadow)"
    }, el("h2", {}, title));
  }
  function openDialog(dialog, focusTarget) {
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    setTimeout(() => focusTarget?.focus(), 0);
  }
  var dialogSequence = 0;
  function confirmAction({ title, message, confirmLabel, cancelLabel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
      const dialog = dialogShell(title);
      const titleNode = dialog.querySelector("h2");
      const titleId = `pos-confirm-title-${++dialogSequence}`;
      const messageId = `pos-confirm-message-${dialogSequence}`;
      titleNode.id = titleId;
      dialog.removeAttribute("aria-label");
      dialog.setAttribute("aria-labelledby", titleId);
      dialog.setAttribute("aria-describedby", messageId);
      dialog.setAttribute("data-pos-confirmation", "true");
      const messageNode = el("p", { id: messageId, class: "view-sub" }, message);
      const cancelButton = button(cancelLabel, { onClick: () => dialog.close("cancel") });
      const confirmButton = button(confirmLabel, {
        primary: !danger,
        danger,
        onClick: () => dialog.close("confirm")
      });
      dialog.append(
        messageNode,
        el("div", { class: "view-actions" }, [cancelButton, confirmButton])
      );
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true });
      openDialog(dialog, cancelButton);
    });
  }
  function isPaidStatus(status) {
    return ["paid", "partially_fulfilled", "fulfilled", "partially_returned", "returned"].includes(status);
  }
  function renderReceipt(slot, order, tenders, projection) {
    clear(slot);
    const lines = order.lines || [];
    const receipt = el("article", { class: "printable", "aria-label": `Receipt for order ${order.id}` }, [
      clubBrand("receipt-brand"),
      el("h1", {}, projection?.merchant?.name || "Receipt"),
      projection?.merchant?.name ? el("h2", {}, "Receipt") : null,
      el("p", {}, `Receipt ${order.receipt_number || order.receiptNumber || order.id}`),
      el("p", {}, new Date(order.paid_at || order.paidAt || order.created_at || order.createdAt || Date.now()).toLocaleString()),
      projection?.cashier?.name ? el("p", {}, `Cashier: ${projection.cashier.name}`) : null,
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Item"), el("th", {}, "Qty"), el("th", {}, "Amount")])),
        el("tbody", {}, lines.map((line) => el("tr", {}, [
          el("td", {}, line.description || "Item"),
          el("td", {}, String(line.qty)),
          el("td", {}, formatCents(line.line_total_cents ?? line.lineTotalCents ?? Math.round(line.qty * (line.unit_price_cents ?? line.unitPriceCents ?? 0))))
        ])))
      ]),
      receiptMoneyRow("Subtotal", order.subtotal_cents ?? order.subtotalCents ?? 0),
      receiptMoneyRow("Discount", -(order.discount_cents ?? order.discountCents ?? 0)),
      receiptMoneyRow("Tax", order.tax_cents ?? order.taxCents ?? 0),
      receiptMoneyRow("Total", order.total_cents ?? order.totalCents ?? 0, true),
      tenders.length ? el("div", { style: "margin-top:12px" }, [
        el("strong", {}, "Payment"),
        ...tenders.flatMap((tender) => {
          const rows = [receiptMoneyRow(tender.kind === "provider" || tender.kind === "card" ? "Card" : tender.kind === "cash" ? "Cash" : "External payment", tender.amount_cents ?? tender.amountCents ?? 0)];
          if (tender.kind === "cash") {
            rows.push(receiptMoneyRow("Cash received", tender.cash_received_cents ?? tender.cashReceivedCents ?? tender.amount_cents ?? tender.amountCents ?? 0));
            rows.push(receiptMoneyRow("Change due", changeDueOf([tender]), true));
          }
          return rows;
        })
      ]) : null,
      projection?.merchant?.receiptFooter ? el("p", { style: "margin-top:16px" }, projection.merchant.receiptFooter) : null
    ]);
    slot.append(receipt);
  }
  function receiptMoneyRow(label2, cents, strong = false) {
    return el("div", { style: `display:flex;justify-content:space-between;gap:20px;padding-top:4px;${strong ? "font-weight:800;border-top:1px solid #000;margin-top:4px" : ""}` }, [
      el("span", {}, label2),
      el("span", {}, formatCents(cents))
    ]);
  }

  // apps/ui/public/js/drink-recipes.js
  var DRINK_RECIPES = [
    { name: "Old Fashioned", family: "Whiskey", glass: "Rocks glass", ingredients: ["2 oz bourbon or rye", "1/4 oz simple syrup", "2 dashes aromatic bitters"], steps: ["Add whiskey, syrup and bitters to a mixing glass with ice.", "Stir until chilled, then strain over a large ice cube.", "Express an orange peel over the drink and garnish."] },
    { name: "Margarita", family: "Tequila", glass: "Rocks glass", ingredients: ["2 oz blanco tequila", "1 oz fresh lime juice", "3/4 oz orange liqueur"], steps: ["Salt half the rim if requested.", "Shake all ingredients with ice.", "Strain over fresh ice and garnish with lime."] },
    { name: "Paloma", family: "Tequila", glass: "Highball", ingredients: ["2 oz tequila", "1/2 oz fresh lime juice", "3 oz grapefruit soda"], steps: ["Add tequila and lime to an ice-filled glass.", "Top with grapefruit soda and stir gently.", "Garnish with lime or grapefruit. Salt the rim only if requested."] },
    { name: "Gin Martini", family: "Gin", glass: "Chilled martini glass", ingredients: ["2 1/2 oz gin", "1/2 oz dry vermouth"], steps: ["Confirm olive or lemon twist and the guest\u2019s dryness preference.", "Stir gin and vermouth with ice until very cold.", "Strain into the chilled glass and garnish. Dirty martini: follow the approved house olive-brine measure."] },
    { name: "Vodka Martini", family: "Vodka", glass: "Chilled martini glass", ingredients: ["2 1/2 oz vodka", "1/2 oz dry vermouth"], steps: ["Confirm olive or lemon twist and any dirty request.", "Stir with ice until very cold; shake if requested.", "Strain into the chilled glass and garnish."] },
    { name: "Espresso Martini", family: "Vodka", glass: "Chilled coupe", ingredients: ["2 oz vodka", "1 oz fresh espresso, cooled", "1/2 oz coffee liqueur", "1/4 oz simple syrup"], steps: ["Add all ingredients to a shaker with ice.", "Shake hard until chilled and foamy.", "Double-strain into the coupe; garnish with coffee beans if available."] },
    { name: "Moscow Mule", family: "Vodka", glass: "Mule mug or highball", ingredients: ["2 oz vodka", "1/2 oz fresh lime juice", "4 oz ginger beer"], steps: ["Fill the serving glass with ice.", "Add vodka and lime; top with ginger beer.", "Stir gently and garnish with lime."] },
    { name: "White Russian", family: "Vodka", glass: "Rocks glass", ingredients: ["2 oz vodka", "1 oz coffee liqueur", "1 oz cream"], steps: ["Add vodka and coffee liqueur to an ice-filled glass.", "Float cream on top or stir gently as requested."] },
    { name: "Gin & Tonic", family: "Gin", glass: "Highball", ingredients: ["2 oz gin", "4 oz tonic water"], steps: ["Fill the glass with fresh ice.", "Add gin, top with tonic and stir gently.", "Garnish with lime; cucumber also suits Hendrick\u2019s."] },
    { name: "Negroni", family: "Gin", glass: "Rocks glass", ingredients: ["1 oz gin", "1 oz Campari", "1 oz sweet red vermouth"], steps: ["Stir all ingredients with ice until chilled.", "Strain over a large ice cube.", "Garnish with orange peel. Use sweet vermouth; dry vermouth is a different recipe."] },
    { name: "Aperol Spritz", family: "Aperitif", glass: "Wine glass", ingredients: ["3 oz prosecco", "2 oz Aperol", "1 oz soda water"], steps: ["Fill a wine glass with ice.", "Add prosecco, Aperol and soda water.", "Stir gently and garnish with an orange slice."] },
    { name: "Whiskey Sour", family: "Whiskey", glass: "Rocks glass", ingredients: ["2 oz bourbon", "3/4 oz fresh lemon juice", "3/4 oz simple syrup"], steps: ["Shake all ingredients with ice.", "Strain over fresh ice.", "Garnish with a cherry and lemon. This reference uses no egg white."] },
    { name: "Manhattan", family: "Whiskey", glass: "Chilled coupe", ingredients: ["2 oz rye or bourbon", "1 oz sweet red vermouth", "2 dashes aromatic bitters"], steps: ["Stir all ingredients with ice until chilled.", "Strain into the chilled glass.", "Garnish with a cocktail cherry."] },
    { name: "Amaretto Sour", family: "Liqueur", glass: "Rocks glass", ingredients: ["1 1/2 oz amaretto", "1 oz fresh lemon juice", "1/4 oz simple syrup"], steps: ["Shake ingredients with ice.", "Strain over fresh ice.", "Garnish with lemon and a cherry. Adjust sweetness only to the approved house spec."] },
    { name: "French 75", family: "Gin", glass: "Flute", ingredients: ["1 oz gin", "1/2 oz fresh lemon juice", "1/2 oz simple syrup", "3 oz sparkling wine"], steps: ["Shake gin, lemon and syrup with ice.", "Strain into the flute.", "Top slowly with sparkling wine and garnish with a lemon twist."] },
    { "name": "Pi\xF1a Colada", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["2 oz white rum", "3 oz pineapple juice", "1 oz cream of coconut", "1 cup ice"], "steps": ["Add rum, pineapple juice, cream of coconut and ice to a blender. Cream of coconut is sweetened; plain coconut milk is not an equal substitute.", "Blend until smooth. Add a little more ice if too thin.", "Pour into the glass and garnish with pineapple and a cherry. For a shaken version, shake the liquids with ice and strain over crushed ice."] },
    { "name": "Virgin Pi\xF1a Colada", "family": "No alcohol", "glass": "Hurricane glass", "ingredients": ["4 oz pineapple juice", "1 oz cream of coconut", "1 cup ice"], "steps": ["Blend pineapple juice, cream of coconut and ice until smooth.", "Pour into the glass and garnish with pineapple.", "Use this alcohol-free recipe only; do not use a prebatched alcoholic colada mix."] },
    { "name": "Classic Daiquiri", "family": "Rum", "glass": "Chilled coupe", "ingredients": ["2 oz white rum", "1 oz fresh lime juice", "3/4 oz simple syrup"], "steps": ["Shake all ingredients with ice until cold.", "Double-strain into the chilled coupe.", "This classic version is shaken, not frozen."] },
    { "name": "Strawberry Daiquiri", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["2 oz white rum", "1 oz fresh lime juice", "3/4 oz simple syrup", "1/2 cup strawberries", "1 cup ice"], "steps": ["Blend all ingredients until smooth.", "Check the texture and pour into the glass.", "Garnish with a strawberry or lime."] },
    { "name": "Frozen Margarita", "family": "Tequila", "glass": "Margarita or rocks glass", "ingredients": ["2 oz blanco tequila", "1 oz fresh lime juice", "3/4 oz orange liqueur", "1/4 oz agave syrup", "1 cup ice"], "steps": ["Salt the rim if requested.", "Blend all ingredients until smooth.", "Pour into the prepared glass and garnish with lime."] },
    { "name": "Strawberry Margarita", "family": "Tequila", "glass": "Margarita glass", "ingredients": ["2 oz blanco tequila", "1 oz fresh lime juice", "3/4 oz orange liqueur", "1/2 oz agave syrup", "1/2 cup strawberries", "1 cup ice"], "steps": ["Salt or sugar the rim if requested.", "Blend all ingredients until smooth.", "Pour and garnish with strawberry and lime."] },
    { "name": "Miami Vice", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["1 oz white rum for the colada layer", "1 1/2 oz pineapple juice", "1/2 oz cream of coconut", "1 oz white rum for the strawberry layer", "1/2 oz lime juice", "1/2 oz simple syrup", "1/4 cup strawberries", "1 cup ice, divided"], "steps": ["Blend the colada rum, pineapple juice, cream of coconut and half the ice; hold separately.", "Blend the remaining rum, lime, syrup, strawberries and remaining ice.", "Layer both mixtures in one glass. Total rum is 2 oz; do not combine two full-strength cocktails."] },
    { "name": "Mojito", "family": "Rum", "glass": "Highball", "ingredients": ["2 oz white rum", "1 oz fresh lime juice", "3/4 oz simple syrup", "8 mint leaves", "2 oz soda water"], "steps": ["Gently press mint with syrup and lime in the glass; do not shred it.", "Add rum and crushed ice; stir to lift the mint.", "Top with soda and garnish with a mint sprig and lime."] },
    { "name": "Cuba Libre", "family": "Rum", "glass": "Highball", "ingredients": ["2 oz rum", "1/2 oz fresh lime juice", "4 oz cola"], "steps": ["Fill the glass with ice.", "Add rum and lime, then cola.", "Stir gently and garnish with lime."] },
    { "name": "Mai Tai", "family": "Rum", "glass": "Rocks glass", "ingredients": ["2 oz aged rum", "3/4 oz fresh lime juice", "1/2 oz orange cura\xE7ao", "1/2 oz orgeat", "1/4 oz simple syrup"], "steps": ["Shake the liquids with ice.", "Pour over crushed ice.", "Garnish with mint and a spent lime shell. Orgeat is commonly almond-based; follow the guest\u2019s ingredient requirements."] },
    { "name": "Bahama Mama", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["1 oz dark rum", "1 oz coconut rum", "2 oz pineapple juice", "2 oz orange juice", "1/2 oz grenadine"], "steps": ["Shake rum and juices with ice.", "Pour over fresh ice.", "Add grenadine and garnish with pineapple and a cherry."] },
    { "name": "Rum Runner", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["1 oz white rum", "1 oz dark rum", "1/2 oz banana liqueur", "1/2 oz blackberry liqueur", "1 oz orange juice", "1 oz pineapple juice", "1/2 oz lime juice"], "steps": ["Shake all ingredients with ice.", "Strain over fresh ice.", "Garnish with orange and a cherry. For frozen service, follow the approved blender batch size."] },
    { "name": "Painkiller", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["2 oz dark rum", "4 oz pineapple juice", "1 oz orange juice", "1 oz cream of coconut"], "steps": ["Shake all liquids hard with ice.", "Pour over crushed ice.", "Finish with freshly grated nutmeg and a pineapple garnish."] },
    { "name": "Blue Hawaiian", "family": "Rum", "glass": "Hurricane glass", "ingredients": ["1 oz white rum", "1 oz blue cura\xE7ao", "2 oz pineapple juice", "1 oz cream of coconut", "1 cup ice"], "steps": ["Blend all ingredients until smooth.", "Pour into the glass.", "Garnish with pineapple and a cherry."] },
    { "name": "Sex on the Beach", "family": "Vodka", "glass": "Highball", "ingredients": ["1 1/2 oz vodka", "1/2 oz peach schnapps", "1 1/2 oz orange juice", "1 1/2 oz cranberry juice"], "steps": ["Add all ingredients to an ice-filled glass.", "Stir gently.", "Garnish with an orange slice."] },
    { "name": "Tequila Sunrise", "family": "Tequila", "glass": "Highball", "ingredients": ["2 oz tequila", "4 oz orange juice", "1/2 oz grenadine"], "steps": ["Add tequila and orange juice to an ice-filled glass; stir.", "Slowly pour grenadine down the inside of the glass so it settles.", "Leave the color layers visible; garnish with orange and a cherry."] },
    { "name": "Long Island Iced Tea", "family": "Mixed spirits", "glass": "Highball", "ingredients": ["1/2 oz vodka", "1/2 oz gin", "1/2 oz white rum", "1/2 oz blanco tequila", "1/2 oz triple sec", "3/4 oz lemon juice", "1/2 oz simple syrup", "1 oz cola"], "steps": ["Measure the five spirits/liqueurs carefully; each measure is only 1/2 oz.", "Shake everything except cola briefly with ice and pour into the glass.", "Top with cola and garnish with lemon."] },
    { "name": "Cosmopolitan", "family": "Vodka", "glass": "Chilled coupe", "ingredients": ["1 1/2 oz vodka", "3/4 oz orange liqueur", "1 oz cranberry juice", "1/2 oz fresh lime juice"], "steps": ["Shake all ingredients with ice.", "Double-strain into the chilled coupe.", "Garnish with an orange or lime twist."] },
    { "name": "Lemon Drop Martini", "family": "Vodka", "glass": "Chilled martini glass", "ingredients": ["2 oz vodka", "1/2 oz orange liqueur", "1 oz fresh lemon juice", "1/2 oz simple syrup"], "steps": ["Sugar the rim if requested.", "Shake all ingredients with ice.", "Double-strain and garnish with a lemon twist."] },
    { "name": "Dirty Shirley", "family": "Vodka", "glass": "Highball", "ingredients": ["1 1/2 oz vodka", "4 oz lemon-lime soda", "1/2 oz grenadine"], "steps": ["Build over ice.", "Stir gently.", "Garnish with a cherry."] },
    { "name": "Bloody Mary", "family": "Vodka", "glass": "Highball", "ingredients": ["1 1/2 oz vodka", "3 oz tomato juice", "1/2 oz lemon juice", "2 dashes Worcestershire sauce", "2 dashes hot sauce", "Pinch of celery salt and black pepper"], "steps": ["Add ingredients to an ice-filled mixing glass.", "Roll gently between two mixing tins; avoid making it foamy.", "Pour into the serving glass and garnish according to the house standard. Confirm spice preference."] },
    { "name": "Screwdriver", "family": "Vodka", "glass": "Highball", "ingredients": ["2 oz vodka", "4 oz orange juice"], "steps": ["Build in an ice-filled glass.", "Stir and garnish with orange."] },
    { "name": "Cape Codder", "family": "Vodka", "glass": "Highball", "ingredients": ["2 oz vodka", "4 oz cranberry juice", "Lime wedge"], "steps": ["Build vodka and cranberry juice over ice.", "Stir and garnish with lime."] },
    { "name": "Bay Breeze", "family": "Vodka", "glass": "Highball", "ingredients": ["1 1/2 oz vodka", "3 oz cranberry juice", "1 1/2 oz pineapple juice"], "steps": ["Build over ice.", "Stir gently and garnish with lime or pineapple."] },
    { "name": "Sea Breeze", "family": "Vodka", "glass": "Highball", "ingredients": ["1 1/2 oz vodka", "3 oz cranberry juice", "1 1/2 oz grapefruit juice"], "steps": ["Build over ice.", "Stir gently and garnish with lime."] },
    { "name": "Tom Collins", "family": "Gin", "glass": "Collins glass", "ingredients": ["2 oz gin", "1 oz lemon juice", "1/2 oz simple syrup", "2 oz soda water"], "steps": ["Shake gin, lemon and syrup with ice.", "Strain over fresh ice in the serving glass.", "Top with soda and garnish with lemon and a cherry."] },
    { "name": "Gimlet", "family": "Gin", "glass": "Chilled coupe", "ingredients": ["2 oz gin", "3/4 oz fresh lime juice", "3/4 oz simple syrup"], "steps": ["Shake with ice.", "Double-strain into the chilled coupe.", "Garnish with lime."] },
    { "name": "Bee's Knees", "family": "Gin", "glass": "Chilled coupe", "ingredients": ["2 oz gin", "3/4 oz fresh lemon juice", "3/4 oz honey syrup"], "steps": ["Use pourable honey syrup, not undiluted honey.", "Shake all ingredients with ice.", "Double-strain and garnish with a lemon twist."] },
    { "name": "Boulevardier", "family": "Whiskey", "glass": "Rocks glass", "ingredients": ["1 1/2 oz bourbon or rye", "1 oz Campari", "1 oz sweet red vermouth"], "steps": ["Stir ingredients with ice until chilled.", "Strain over a large ice cube.", "Express an orange peel and garnish."] },
    { "name": "Mint Julep", "family": "Whiskey", "glass": "Julep cup or rocks glass", "ingredients": ["2 1/2 oz bourbon", "1/2 oz simple syrup", "8 mint leaves", "Crushed ice"], "steps": ["Gently press mint with syrup in the serving cup.", "Add bourbon and fill with crushed ice.", "Stir until frosty, mound more crushed ice and garnish with mint."] },
    { "name": "Irish Coffee", "family": "Coffee", "glass": "Heat-safe coffee glass", "ingredients": ["1 1/2 oz Irish whiskey", "4 oz hot coffee", "2 tsp brown sugar", "1 oz lightly whipped cream"], "steps": ["Warm the glass, then discard the warming water.", "Stir coffee, sugar and whiskey until sugar dissolves.", "Float the cream over the back of a spoon. Serve without stirring the cream through."] },
    { "name": "Irish Mule", "family": "Whiskey", "glass": "Mule mug or highball", "ingredients": ["2 oz Irish whiskey", "1/2 oz lime juice", "4 oz ginger beer"], "steps": ["Build whiskey and lime over ice.", "Top with ginger beer and stir gently.", "Garnish with lime."] },
    { "name": "Green Tea Shot", "family": "Shots", "glass": "2 oz shooter glass", "ingredients": ["1/2 oz Irish whiskey", "1/2 oz peach schnapps", "1/2 oz sour mix", "Small splash lemon-lime soda"], "steps": ["Shake whiskey, schnapps and sour mix with ice.", "Strain into the shooter glass.", "Top with a small splash of soda. This recipe makes one shot."] },
    { "name": "Lemon Drop Shot", "family": "Shots", "glass": "Shot glass", "ingredients": ["3/4 oz vodka", "1/2 oz lemon juice", "1/4 oz simple syrup"], "steps": ["Sugar the rim if requested.", "Shake the ingredients with ice and strain.", "This recipe makes one 1 1/2 oz shot."] },
    { "name": "Shirley Temple", "family": "No alcohol", "glass": "Highball", "ingredients": ["4 oz ginger ale or lemon-lime soda", "1/2 oz grenadine", "1/4 oz lime juice"], "steps": ["Build over ice.", "Stir gently and garnish with a cherry.", "This is the alcohol-free recipe; Dirty Shirley is a separate drink."] }
  ];
  function recipeInstructions(recipe) {
    return `STANDARD REFERENCE \u2014 confirm the house recipe.
Glass: ${recipe.glass}
${recipe.ingredients.join("\n")}

${recipe.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`;
  }
  var normalize = (value) => value.normalize("NFD").replace(new RegExp("\\p{Diacritic}", "gu"), "").toLowerCase().trim();
  function findDrinkRecipes(query, family = "All recipes") {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    return DRINK_RECIPES.filter((recipe) => {
      const text = normalize(`${recipe.name} ${recipe.family} ${recipe.ingredients.join(" ")}`);
      return (family === "All recipes" || recipe.family === family) && words.every((word) => text.includes(word));
    });
  }

  // apps/ui/public/js/printing.js
  var amountRow = (label2, cents) => {
    const amount = formatCents(cents);
    return label2.length + amount.length <= 42 ? label2 + " ".repeat(42 - label2.length - amount.length) + amount : `${label2}
${amount.padStart(42)}`;
  };
  function ticketPrintDocument(ticket) {
    const t = ticket.value;
    const role = t.station === "kitchen" ? "kitchen" : "bar";
    return {
      documentId: `ticket:${ticket.id}`,
      role,
      revision: ticket.version,
      text: [
        ticket.version > 1 ? "UPDATED TICKET" : "NEW TICKET",
        `${role.toUpperCase()} \xB7 ${t.tabName}`,
        t.table || "Bar",
        `Ticket ${ticket.id}`,
        new Date(ticket.createdAt).toLocaleString(),
        "",
        ...t.items.flatMap((i) => [
          `${i.voided ? "VOID \u2014 " : ""}${i.name} \xB7 Seat ${i.seat}`,
          ...i.modifiers || [],
          ...i.instructions ? [i.instructions] : [],
          ""
        ])
      ].join("\n")
    };
  }
  function receiptPrintDocument(receipt) {
    const { order, tenders, merchant } = receipt;
    return {
      documentId: `receipt:${order.id}`,
      role: "receipt",
      text: [
        merchant.name,
        `Receipt ${order.receipt_number}`,
        order.status.toUpperCase(),
        "",
        ...order.note?.startsWith("Bill:") ? [order.note, ""] : [],
        ...order.lines.map((l) => amountRow(`${l.qty ?? 1} \xD7 ${l.description}`, l.line_total_cents)),
        amountRow("Tax", order.tax_cents),
        amountRow("Tip", order.tip_cents),
        amountRow("TOTAL", order.total_cents),
        "",
        amountRow("Paid", receipt.amountPaidCents),
        amountRow("Refunded", receipt.amountRefundedCents),
        ...tenders.filter((t) => ["captured", "partially_refunded", "refunded"].includes(t.status)).flatMap((t) => [
          amountRow(t.kind === "provider" ? "Card" : t.kind === "cash" ? "Cash" : "Payment", t.amount_cents),
          ...t.provider_ref ? [`Transaction ID: ${t.provider_ref}`] : [],
          ...t.kind === "cash" ? [amountRow("Cash received", t.cash_received_cents), amountRow("Change given", t.change_due_cents)] : []
        ]),
        "",
        merchant.receiptFooter || ""
      ].join("\n")
    };
  }
  function createPrintClient({ getBridge, now = Date.now, randomID = () => crypto.randomUUID(), onChange = () => {
  } }) {
    let tail = Promise.resolve(), pumping = false;
    let configuration = { configuredRoles: [], automaticRoles: [] };
    const outcomes = /* @__PURE__ */ new Map();
    const enqueue2 = (action) => {
      const next = tail.then(action, action);
      tail = next.catch(() => {
      });
      return next;
    };
    function remember(key, result) {
      outcomes.set(key, { ...result, checkedAt: now() });
      onChange();
    }
    const keyFor = (ticket) => `ticket:${ticket.id}:${ticket.version}`;
    async function manual(document2, reprint = false) {
      const bridge = getBridge();
      if (!bridge) return { status: "browser" };
      return enqueue2(() => bridge.print({ id: randomID(), ...document2, automatic: false, reprint }));
    }
    async function pump(tickets) {
      const bridge = getBridge();
      if (!bridge || pumping) return;
      pumping = true;
      try {
        configuration = await bridge.status();
        const candidates = tickets.filter((t) => t.value.status === "queued" && configuration.automaticRoles.includes(t.value.station || "bar") && configuration.configuredRoles.includes(t.value.station || "bar")).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        let attempted = 0;
        for (const ticket of candidates) {
          const key = keyFor(ticket), previous = outcomes.get(key);
          if (previous && (["submitted", "alreadySubmitted", "unknown"].includes(previous.status) || now() - previous.checkedAt < 3e4)) continue;
          if (attempted++ >= 3) break;
          try {
            const result = await enqueue2(() => bridge.print({ id: key, ...ticketPrintDocument(ticket), automatic: true, reprint: false }));
            remember(key, result);
          } catch (error) {
            remember(key, { status: "failed", message: error.message || String(error) });
          }
        }
      } catch (error) {
        configuration = { configuredRoles: [], automaticRoles: [], error: error.message || String(error) };
      } finally {
        pumping = false;
      }
    }
    return { manual, pump, status: (ticket) => outcomes.get(keyFor(ticket)), configuration: () => configuration };
  }

  // apps/ui/public/js/views/bar.js
  var API = "/api/pos/bar";
  var money = (v) => parseMoneyToCents(v || "0");
  var row = (...kids) => el("div", { class: "bar-row" }, kids.map((k) => typeof k === "string" || typeof k === "number" ? el("span", {}, String(k)) : k));
  var note = (text) => el("p", { class: "bar-note" }, text);
  var select2 = (label2, options, value) => el("select", { "aria-label": label2 }, options.map(([id, name]) => el("option", { value: id, selected: String(id) === String(value) }, name)));
  var menuPrice = (m) => m.priceCents === null ? "Set price" : formatCents(m.happyHour && m.happyHourPriceCents !== null ? m.happyHourPriceCents : m.priceCents);
  var preparationNotes = (instructions) => instructions ? el("details", { class: "bar-preparation" }, [el("summary", {}, "How to make / serve"), el("p", { class: "bar-instructions" }, instructions)]) : null;
  var doneStatuses = ["paid", "fulfilled", "partially_fulfilled", "returned", "partially_returned", "canceled"];
  registerView("bar", async (container) => {
    let data, readiness, drawer, busy = false, selectedTab = null, selectedCheck = null;
    let category = "All items", search = "", tabQuery = "", seat = 1, mode = "service", ticketStation = "kitchen", connectionError = "";
    let setupDoc, recipeSearch = "", recipeFamily = "All recipes", lastAddedMenuId = null;
    const normalizedName = (name) => name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    function showInstructions(item) {
      const d = dialog(item.name);
      if (item.description) d.append(note(item.description));
      d.append(el("p", { class: "bar-instructions" }, item.instructions || "Add the house preparation instructions in Menu & stock."));
    }
    function renderRecipes() {
      screen.append(el("h2", {}, "Bartender drink guide"), note("Standard reference recipes \xB7 1 oz \u2248 30 ml. Drinks on the selling menu can be added to a bill below."));
      const searchBox = input({ placeholder: "Find a drink, spirit or ingredient\u2026", value: recipeSearch });
      searchBox.setAttribute("aria-label", "Find a drink recipe");
      const cards = el("div", { class: "bar-recipe-grid" });
      function draw() {
        clear(cards);
        const matches = findDrinkRecipes(recipeSearch, recipeFamily);
        for (const recipe of matches) {
          const card = el("section", { class: "bar-recipe-card" }, [el("h3", {}, recipe.name), note(`${recipe.family} \xB7 ${recipe.glass}`), el("h4", {}, "Ingredients"), el("ul", {}, recipe.ingredients.map((i) => el("li", {}, i))), el("h4", {}, "Make it"), el("ol", {}, recipe.steps.map((step) => el("li", {}, step)))]);
          const selling = data.menu.find((m) => normalizedName(m.value.name) === normalizedName(recipe.name))?.value;
          if (selling) card.append(action(`Add to bill \xB7 ${menuPrice(selling)}`, () => addDrink(selling), { primary: true, disabled: busy || !selling.available || selling.priceCents === null || !!pending }));
          else if (data.canManage) card.append(action("Create menu item", () => menuEditor(null, { name: recipe.name, category: ["No alcohol", "Shots"].includes(recipe.family) ? recipe.family : "Cocktails", prepStation: "bar", priceCents: null, instructions: recipeInstructions(recipe) })));
          cards.append(card);
        }
        if (!matches.length) cards.append(note("No matching recipe. Search by spirit or ingredient."));
      }
      searchBox.addEventListener("input", () => {
        recipeSearch = searchBox.value;
        draw();
      });
      const families = ["All recipes", ...new Set(DRINK_RECIPES.map((r) => r.family).sort())];
      screen.append(searchBox, el("div", { class: "bar-categories" }, families.map((family) => action(family, () => {
        recipeFamily = family;
        render2();
      }, { primary: recipeFamily === family }))), cards);
      draw();
    }
    const selected = /* @__PURE__ */ new Set();
    const station = "one-club-bar";
    const selectionKey = `one-club-bar-selection:${station}:${authenticatedActorId()}`;
    let newBill = false, refreshRequest = 0, stateFingerprint = "";
    try {
      const saved = JSON.parse(sessionStorage.getItem(selectionKey) || "null");
      if (saved) {
        selectedTab = saved.tabId;
        selectedCheck = saved.checkId;
        newBill = saved.newBill === true;
      }
    } catch {
    }
    const pendingKey = `one-club-bar-pending:${station}`;
    let pending;
    try {
      pending = JSON.parse(sessionStorage.getItem(pendingKey) || "null");
    } catch {
      pending = null;
    }
    const stationName = () => "Bar One bar";
    const screen = el("div", { class: "bar-workspace" });
    container.append(screen);
    const printers = createPrintClient({ getBridge: () => window.barOnePrint, onChange: () => {
      if (mode === "tickets" && data && !busy && container.isConnected && !container.querySelector("dialog[open]")) render2();
    } });
    const tab = () => data?.tabs.find((t) => t.id === selectedTab);
    const check = () => tab()?.value.checks.find((c) => c.id === selectedCheck);
    const currentPath = () => `${API}/tabs/${tab().id}`;
    const failure = (e) => toast(e.message || "The request could not be confirmed.", "err", 6500);
    const action = (label2, fn, options = {}) => button(label2, { disabled: busy, ...options, onClick: () => {
      if (!busy) return Promise.resolve().then(fn).catch(failure);
    } });
    function pick(t) {
      newBill = false;
      selectedTab = t.id;
      selectedCheck = t.value.checks[0]?.id;
      selected.clear();
      lastAddedMenuId = null;
      render2();
    }
    function working() {
      busy = true;
      ++refreshRequest;
      screen.setAttribute("aria-busy", "true");
      for (const control of screen.querySelectorAll("button,input,select")) control.disabled = true;
    }
    async function refresh() {
      const request = ++refreshRequest;
      const [state2, ready, cash] = await Promise.all([getData(`${API}/state`), getData("/api/pos/readiness"), getData("/api/pos/drawer", { drawerRef: station })]);
      if (request !== refreshRequest) return;
      state2.menu.sort((a, b) => a.value.category.localeCompare(b.value.category) || a.value.name.localeCompare(b.value.name));
      const fingerprint = JSON.stringify([state2, ready, cash], (key, value) => ["asOf", "checkedAt"].includes(key) ? void 0 : value);
      const changed = fingerprint !== stateFingerprint || !!connectionError;
      stateFingerprint = fingerprint;
      data = state2;
      readiness = ready;
      drawer = cash;
      connectionError = "";
      if (!tab() && !newBill) {
        selectedTab = data.tabs.find((t) => t.value.status === "open")?.id;
      }
      if (!check()) selectedCheck = tab()?.value.checks[0]?.id;
      if (changed) render2();
      if (container.isConnected) void printers.pump(data.tickets);
    }
    async function send(path, body, after) {
      if (busy) return;
      if (connectionError) throw new Error("Reconnect to confirm the latest tabs before continuing.");
      if (pending) throw new Error("Recover the previous action before starting another.");
      pending = { path, body, key: newIdempotencyKey(), actor: authenticatedActorId() };
      sessionStorage.setItem(pendingKey, JSON.stringify(pending));
      return replay(after);
    }
    async function replay(after) {
      if (!pending || busy) return;
      if (pending.actor !== authenticatedActorId()) throw new Error("Sign in as the operator who started this action to recover it.");
      working();
      try {
        const response = await mutate(pending.path, "POST", pending.body, { idempotencyKey: pending.key });
        pending = null;
        sessionStorage.removeItem(pendingKey);
        if (after) await after(response.data);
        await refresh();
        return response.data;
      } catch (e) {
        if (e.status >= 400 && e.status < 500 && e.status !== 401) {
          pending = null;
          sessionStorage.removeItem(pendingKey);
        }
        await refresh().catch(() => {
        });
        throw e;
      } finally {
        busy = false;
        render2();
      }
    }
    async function command(cmd, after) {
      return send(`${currentPath()}/commands`, { version: tab().version, ...cmd }, after);
    }
    async function saveAndNext() {
      if (busy || pending || !tab()) return;
      const current = tab(), bill = check();
      working();
      try {
        await refresh();
        const saved = data.tabs.find((t) => t.id === current.id);
        if (!saved || saved.version < current.version || !saved.value.checks.some((c) => c.id === bill?.id)) throw new Error("The saved bill could not be confirmed. Reconnect and try again.");
        newBill = true;
        selectedTab = null;
        selectedCheck = null;
        lastAddedMenuId = null;
        selected.clear();
        seat = 1;
        mode = "service";
        toast(`${bill?.name || current.value.name} saved. Ready for the next guest.`);
      } finally {
        busy = false;
        render2();
      }
    }
    function dialog(title, description) {
      const d = el("dialog", { class: "bar-dialog", "aria-label": title });
      d.append(row(el("h2", {}, title), action("Close", () => d.close())));
      if (description) d.append(note(description));
      container.append(d);
      d.addEventListener("close", () => d.remove(), { once: true });
      d.showModal();
      return d;
    }
    function formDialog(title, fields, submitLabel, submit, description) {
      const d = dialog(title, description);
      const controls = {};
      const form = el("form");
      for (const f of fields) {
        const control = f.options ? select2(f.label, f.options, f.value) : input({ name: f.name, value: f.value ?? "", placeholder: f.placeholder ?? "", type: f.type ?? "text" });
        control.setAttribute("aria-label", f.label);
        if (f.numeric) control.setAttribute("inputmode", "decimal");
        if (f.selectOnFocus) control.addEventListener("click", () => control.select(), { once: true });
        controls[f.name] = control;
        form.append(field(f.label, control));
      }
      const submitButton = action(submitLabel, save, { primary: true });
      form.append(submitButton);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        save().catch(failure);
      });
      d.append(form);
      async function save() {
        if (busy || submitButton.disabled) return;
        submitButton.disabled = true;
        try {
          await submit(Object.fromEntries(Object.entries(controls).map(([k, v]) => [k, v.value])));
          d.close();
        } finally {
          submitButton.disabled = false;
        }
      }
      return d;
    }
    function printButton(label2, document2) {
      let printing = false;
      const button2 = action(label2, async () => {
        if (printing) return;
        printing = true;
        button2.disabled = true;
        try {
          const result = await printers.manual(document2);
          if (result.status === "browser") {
            documentBodyPrint();
          } else if (["alreadySubmitted", "unknown"].includes(result.status)) {
            const review = dialog("Print another copy?", result.message);
            review.append(note("Check the paper first. An additional copy will be labeled REPRINT."), action("Print another copy", async () => {
              const copy = await printers.manual(document2, true);
              if (copy.status !== "submitted") throw new Error(copy.message || "The additional copy was not confirmed.");
              review.close();
              toast(copy.message);
            }, { primary: true }));
          } else if (result.status === "submitted") {
            toast(result.message || "Sent to printer.");
          }
        } finally {
          printing = false;
          button2.disabled = busy;
        }
      }, { primary: true });
      return button2;
    }
    function documentBodyPrint() {
      document.body.classList.add("printing-bar");
      try {
        window.print();
      } finally {
        document.body.classList.remove("printing-bar");
      }
    }
    function createTab() {
      formDialog("Open a tab", [{ name: "name", label: "Guest or tab name", placeholder: "Guest name / walk-in" }, { name: "table", label: "Table or bar seat", placeholder: "Patio 7" }, { name: "billName", label: "Bill name", placeholder: "Optional \xB7 guest or group name" }], "Open tab", (v) => send(`${API}/tabs`, { ...v, billName: v.billName.trim() || void 0 }, (t) => pick(t)), "Open tabs stay saved while staff switch on this iPad.");
    }
    function render2() {
      if (busy && data) return;
      const scroll = [...screen.querySelectorAll("[data-scroll]")].map((node) => [node.dataset.scroll, node.scrollLeft, node.scrollTop]);
      const active = screen.contains(document.activeElement) ? document.activeElement : null;
      const focus = active?.getAttribute("aria-label");
      const range = active?.tagName === "INPUT" ? [active.selectionStart, active.selectionEnd] : null;
      const pagePosition = [window.scrollX, window.scrollY];
      try {
        drawScreen();
      } finally {
        screen.removeAttribute("aria-busy");
        sessionStorage.setItem(selectionKey, JSON.stringify({ tabId: selectedTab, checkId: selectedCheck, newBill }));
        for (const [key, left, top] of scroll) {
          const node = screen.querySelector(`[data-scroll="${CSS.escape(key)}"]`);
          if (node) {
            node.scrollLeft = left;
            node.scrollTop = top;
          }
        }
        if (focus) {
          const node = screen.querySelector(`[aria-label="${CSS.escape(focus)}"]`);
          node?.focus({ preventScroll: true });
          if (range && range[0] !== null && node?.setSelectionRange) node.setSelectionRange(...range);
        }
        if (window.scrollX !== pagePosition[0] || window.scrollY !== pagePosition[1]) window.scrollTo(...pagePosition);
      }
    }
    function drawScreen() {
      screen.classList.toggle("bar-service", mode === "service");
      clear(screen);
      if (!data) {
        screen.append(note("Loading the bar\u2026"));
        return;
      }
      const open = data.tabs.filter((t) => t.value.status === "open");
      screen.append(el("div", { class: "bar-heading" }, [
        el("div", {}, [el("p", { class: "bar-eyebrow" }, "BAR ONE \xB7 BAR SERVICE"), el("h1", {}, "A round well served."), note(`${open.length} open tabs \xB7 ${data.summary.queuedTickets} prep tickets to make`)]),
        row(
          action("Service", () => {
            mode = "service";
            render2();
          }, { primary: mode === "service" }),
          action("Bar & kitchen", () => {
            mode = "tickets";
            render2();
          }, { primary: mode === "tickets" }),
          action("Drink guide", () => {
            mode = "recipes";
            render2();
          }, { primary: mode === "recipes" }),
          data.canManage ? action("Menu & stock", () => {
            mode = "manage";
            render2();
          }, { primary: mode === "manage" }) : null,
          data.canManage ? action("Setup", setupDialog) : null
        )
      ]));
      screen.append(el("div", { class: "bar-connection", role: "status" }, [note(connectionError || `${stationName()} \xB7 Updated ${new Date(data.asOf).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`), connectionError ? action("Reconnect", refresh) : null]));
      if (pending && !busy) screen.append(el("div", { class: "bar-alert", role: "status" }, [note("An action is awaiting confirmation. Recover it before continuing."), action("Recover last action", () => replay())]));
      if (!readiness.operational) screen.append(el("div", { class: "bar-alert" }, [note(`You can add items and name bills. ${(readiness.blockers || []).filter((b) => b.blocking).map((b) => b.message).join(" ")} Sending and payment need completed setup.`), button("Open settings", { href: "#/settings" })]));
      if (mode === "recipes") return renderRecipes();
      if (mode === "tickets") return renderTickets();
      if (mode === "manage") return renderManage();
      const tabs = el("aside", { class: "bar-tabs", "aria-label": "Open tabs" }, [row(el("h2", {}, "Tabs"), action("+ New", createTab, { primary: true }))]);
      const tabSearch = input({ placeholder: "Find tab", value: tabQuery });
      tabSearch.setAttribute("aria-label", "Find tab");
      tabs.append(tabSearch);
      const tabList = el("div", { class: "bar-tab-list", "data-scroll": "tabs" });
      tabs.append(tabList);
      const drawTabs = () => {
        clear(tabList);
        for (const t of open.filter((t2) => `${t2.value.name} ${t2.value.table} ${t2.value.checks.map((c) => c.name).join(" ")}`.toLowerCase().includes(tabSearch.value.toLowerCase()))) {
          tabList.append(el("button", { type: "button", class: `bar-tab ${t.id === selectedTab ? "active" : ""}`, onclick: () => pick(t) }, [el("strong", {}, t.value.name), el("span", {}, t.value.table || "Bar tab"), el("span", {}, t.value.checks.map((c) => c.name).join(" \xB7 ")), el("b", {}, `${formatCents(t.remainingCents)}${t.taxPending ? " + tax" : ""}`)]));
        }
        if (!open.length) tabList.append(note("Open a guest tab to begin."));
      };
      tabSearch.addEventListener("input", () => {
        tabQuery = tabSearch.value;
        drawTabs();
      });
      drawTabs();
      tabs.append(action("Recent checks", historyDialog));
      const menu = el("section", { class: "bar-menu", "aria-label": "Food & drinks menu" });
      const searchBox = input({ placeholder: "Find food or drinks\u2026", value: search });
      searchBox.setAttribute("aria-label", "Find food or drinks");
      const seats = select2("Seat for new items", Array.from({ length: 20 }, (_, n) => [n + 1, `Seat ${n + 1}`]), seat);
      seats.addEventListener("change", () => {
        seat = Number(seats.value);
      });
      menu.append(row(searchBox, seats));
      const categories = ["All items", ...new Set(data.menu.map((m) => m.value.category))];
      if (!categories.includes(category)) category = "All items";
      const chips = el("div", { class: "bar-categories", "data-scroll": "categories" });
      const tiles = el("div", { class: "bar-tiles", "data-scroll": "menu" });
      function drawMenu() {
        const chipLeft = chips.scrollLeft;
        clear(chips);
        clear(tiles);
        for (const c of categories) chips.append(action(c, () => {
          category = c;
          drawMenu();
        }, { primary: category === c }));
        const matches = data.menu.map((d) => d.value).filter((m) => (category === "All items" || m.category === category) && `${m.name} ${m.category}`.toLowerCase().includes(search.toLowerCase()));
        for (const m of matches) {
          const tile = el("button", {
            type: "button",
            class: `bar-drink ${!m.available ? "unavailable" : ""}`,
            disabled: busy || !m.available || m.priceCents === null || tab()?.value.status === "open" && !!check()?.orderId || !!pending,
            onclick: () => addDrink(m).catch(failure)
          }, [el("span", { class: "bar-drink-category" }, `${m.category}${m.prepStation === "kitchen" ? " \xB7 Kitchen" : ""}`), el("strong", {}, m.name), el("span", { class: "bar-drink-bottom" }, [el("b", {}, menuPrice(m)), el("span", {}, m.priceCents === null ? "Price needed" : !m.available ? "Sold out" : m.happyHour ? "Happy hour" : "+")])]);
          const entry = el("div", { class: "bar-menu-entry" }, [tile]);
          if (m.instructions) {
            const help = action("How to serve", () => showInstructions(m));
            help.classList.add("bar-recipe-link");
            help.setAttribute("aria-label", `How to serve ${m.name}`);
            entry.append(help);
          }
          tiles.append(entry);
        }
        if (!matches.length) tiles.append(note(data.menu.length ? "No matching drinks." : "Add the venue\u2019s drinks and prices in Menu & stock."));
        chips.scrollLeft = chipLeft;
      }
      searchBox.addEventListener("input", () => {
        search = searchBox.value;
        drawMenu();
      });
      drawMenu();
      menu.append(chips, tiles);
      const order = el("section", { class: "bar-check", "aria-label": "Current check" });
      renderCheck(order);
      screen.append(el("div", { class: "bar-layout" }, [tabs, menu, order]));
    }
    function renderCheck(target) {
      const t = tab(), c = check();
      if (!t) {
        target.append(el("h2", {}, newBill ? "Next guest" : "Start a bill"), note("Tap an item to start a saved walk-in tab, or open a named tab."), action("Open a tab", createTab, { primary: true }));
        return;
      }
      const heading = el("div", { class: "bar-check-heading" });
      target.append(heading);
      heading.append(row(el("div", {}, [el("h2", {}, c?.name || t.value.name), note(`${t.value.name}${t.value.table ? " \xB7 " + t.value.table : ""}`)]), action("Manage", tabDialog)));
      const checks = select2("Current check", t.value.checks.map((c2) => [c2.id, `${c2.name} \xB7 ${formatCents(c2.totalCents)}`]), selectedCheck);
      checks.addEventListener("change", () => {
        selectedCheck = checks.value;
        selected.clear();
        render2();
      });
      if (t.value.checks.length > 1) heading.append(checks);
      if (!c) return;
      if (!c.orderId && t.value.status === "open") heading.append(action("Name bill", () => formDialog("Name bill", [{ name: "name", label: "Bill name", value: c.name, selectOnFocus: true }], "Save bill name", (v) => command({ action: "rename_check", checkId: c.id, name: v.name }))));
      const body = el("div", { class: "bar-check-body", "data-scroll": `bill:${c.id}` });
      target.append(body);
      const lines = el("div", { class: "bar-lines" });
      for (const a of c.allocations) {
        const i = t.value.items.find((i2) => i2.id === a.itemId);
        const chosen = el("input", { type: "checkbox", checked: selected.has(i.id), disabled: !!c.orderId, "aria-label": `Select ${i.name}`, onchange: (e) => {
          e.target.checked ? selected.add(i.id) : selected.delete(i.id);
          target.querySelector(".bar-selection-count").textContent = `${selected.size} items selected`;
        } });
        lines.append(el("label", { class: `bar-line ${i.voided ? "voided" : ""}` }, [chosen, el("div", {}, [el("strong", {}, i.name), note(`Seat ${i.seat}${a.share < 0.99999 ? ` \xB7 Shared ${Math.round(a.share * 100)}%` : ""} \xB7 ${i.voided ? "Void" : i.comped ? "Comp" : i.sentAt ? "Sent" : "New"}`), i.modifiers.length ? note(i.modifiers.join(" \xB7 ")) : null]), el("b", {}, formatCents(a.netCents))]));
      }
      for (const a of c.allocations) {
        const item = t.value.items.find((i) => i.id === a.itemId);
        if (item?.instructions) lines.append(el("div", {}, [note(item.name), preparationNotes(item.instructions)]));
      }
      if (!c.allocations.length) lines.append(note("Tap food or a drink to add it to this check."));
      body.append(lines);
      if (!c.orderId && t.value.status === "open") body.append(el("p", { class: "bar-note bar-selection-count" }, `${selected.size} items selected`), row(action("Split", splitDialog), action("Move", moveDialog), data.canManage ? action("Comp / void", overrideDialog) : null));
      const unsent = t.value.items.filter((i) => !i.sentAt && !i.voided).length;
      if (t.value.status === "open") body.append(row(action(`Send round${unsent ? ` \xB7 ${unsent}` : ""}`, () => command({ action: "send" }), { primary: true, disabled: busy || !unsent || !!t.taxPending || !readiness.operational }), action("Repeat", repeatDialog)));
      const footer = el("div", { class: "bar-check-footer" });
      target.append(footer);
      footer.append(el("div", { class: "bar-totals" }, [row("Items", formatCents(c.subtotalCents)), row("Tax", c.taxPending ? "Pending setup" : formatCents(c.taxCents)), c.tipCents ? row("Tip", formatCents(c.tipCents)) : null, row(el("strong", {}, c.taxPending ? "Before tax" : "Total"), el("strong", {}, formatCents(c.totalCents)))]));
      const billActions = el("div", { class: "bar-bill-actions" });
      footer.append(billActions);
      if (t.value.status === "open") billActions.append(action("Save & next", saveAndNext, { primary: true, disabled: busy || !!pending }));
      if (doneStatuses.includes(c.status)) billActions.append(action("Receipt & refund", () => receiptDialog(c.orderId)));
      else billActions.append(action(c.orderId ? `Continue payment \xB7 ${formatCents(c.remainingCents)}` : `Pay check \xB7 ${formatCents(c.totalCents)}`, paymentDialog, { disabled: busy || !c.allocations.length || !!c.taxPending || !readiness.operational }));
      if (!c.orderId && t.value.status === "open" && lastAddedMenuId) {
        const item = data.menu.find((m) => m.id === lastAddedMenuId)?.value;
        const suggestions = item ? upsellsFor(item) : [];
        if (suggestions.length) body.append(el("section", { class: "bar-upsells", "aria-label": "Suggested add-ons" }, [el("h3", {}, "Add to this bill"), ...suggestions.map((m) => action(`Add ${m.name} \xB7 ${menuPrice(m)}`, () => addDrink(m)))]));
      }
      if (t.value.status === "open" && t.value.checks.every((c2) => !c2.allocations.length || doneStatuses.includes(c2.status))) body.append(action("Close tab", () => command({ action: "close" }, () => {
        selectedTab = null;
        selectedCheck = null;
        selected.clear();
      })));
    }
    async function addDrink(m) {
      if (busy || pending) return;
      const destination = tab()?.value.status === "open" ? { tabId: tab().id, checkId: check()?.id } : null;
      if (destination && check()?.orderId) throw new Error("This bill is being paid. Add a new bill from Manage first.");
      const itemSeat = seat;
      const add = async (selections2 = {}, prepNote2 = "", quantity2 = 1, extras2 = []) => {
        const item = { menuId: m.id, selections: selections2, note: prepNote2, quantity: quantity2, seat: itemSeat };
        const after = (t) => {
          newBill = false;
          selectedTab = t.id;
          selectedCheck = destination?.checkId ?? t.value.checks[0].id;
          selected.clear();
          lastAddedMenuId = m.id;
          mode = "service";
        };
        if (destination) {
          const current = data.tabs.find((t) => t.id === destination.tabId);
          if (!current) throw new Error("This tab is no longer available. Select an open tab.");
          await send(`${API}/tabs/${destination.tabId}/commands`, { action: "add", ...item, extras: extras2, checkId: destination.checkId, version: current.version }, after);
        } else await send(`${API}/tabs`, { name: "Walk-in", billName: "Walk-in", initialItems: [item, ...extras2] }, after);
        toast(`Added ${quantity2 > 1 ? quantity2 + " \xD7 " : ""}${m.name} to ${check()?.name || "the bill"}.`);
      };
      if (!m.modifiers.length && m.prepStation !== "kitchen") return add();
      const d = dialog(m.name, destination ? `Adding to ${check().name} \xB7 ${tab().value.name}` : "Starts a saved walk-in tab. You can name the bill after adding.");
      const form = el("form", { class: "bar-item-form", id: `add-item-${newIdempotencyKey()}` });
      d.append(form);
      const selections = {}, extras = /* @__PURE__ */ new Map();
      const quantity = select2("Quantity", Array.from({ length: 10 }, (_, i) => [i + 1, String(i + 1)]), 1);
      form.append(field("Quantity", quantity));
      const submitButton = el("button", { type: "submit", class: "btn btn-primary bar-add-submit", form: form.id }, "Add to bill");
      const updatePrice = () => {
        let price = m.happyHour && m.happyHourPriceCents !== null ? m.happyHourPriceCents : m.priceCents;
        for (const g of m.modifiers) price += g.choices.find((c) => c.id === selections[g.id])?.priceCents || 0;
        const extraPrice = [...extras.values()].reduce((s, e) => s + (e.happyHour && e.happyHourPriceCents !== null ? e.happyHourPriceCents : e.priceCents), 0);
        submitButton.textContent = `Add to bill \xB7 ${formatCents(price * Number(quantity.value) + extraPrice)}`;
      };
      quantity.addEventListener("change", updatePrice);
      for (const g of m.modifiers) {
        const group = el("fieldset", { class: "bar-option-group" }, [el("legend", {}, `${g.name}${g.required ? " \xB7 choose one" : " \xB7 optional"}`)]);
        const choices = g.required ? g.choices : [{ id: "", name: "Standard", priceCents: 0 }, ...g.choices];
        const defaultChoice = g.choices.find((c) => c.id === "included")?.id;
        if (defaultChoice) selections[g.id] = defaultChoice;
        for (const choice of choices) {
          const radio = el("input", {
            type: "radio",
            name: `option-${g.id}`,
            value: choice.id,
            required: g.required,
            checked: choice.id === (defaultChoice ?? (g.required ? null : "")),
            onchange: () => {
              selections[g.id] = choice.id;
              updatePrice();
            }
          });
          group.append(el("label", { class: "bar-option" }, [radio, el("span", {}, choice.name), el("b", {}, choice.priceCents ? `+${formatCents(choice.priceCents)}` : "Included")]));
        }
        form.append(group);
      }
      const suggestions = upsellsFor(m);
      if (suggestions.length) {
        const group = el("fieldset", { class: "bar-option-group" }, [el("legend", {}, "Add a drink or extra \xB7 optional")]);
        for (const extra of suggestions) group.append(el("label", { class: "bar-option" }, [el("input", { type: "checkbox", onchange: (e) => {
          e.target.checked ? extras.set(extra.id, extra) : extras.delete(extra.id);
          updatePrice();
        } }), el("span", {}, extra.name), el("b", {}, `+${menuPrice(extra)}`)]));
        form.append(group);
      }
      const prepNote = input({ placeholder: "No onions / allergy information" });
      prepNote.setAttribute("aria-label", "Preparation note");
      form.append(field("Preparation note", prepNote));
      d.append(submitButton);
      updatePrice();
      let submitting = false;
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (submitting || busy || !form.reportValidity()) return;
        submitting = true;
        submitButton.disabled = true;
        try {
          await add(Object.fromEntries(Object.entries(selections).filter(([, v]) => v)), prepNote.value, Number(quantity.value), [...extras.keys()].map((menuId) => ({ menuId, seat: itemSeat })));
          d.close();
        } catch (error) {
          failure(error);
        } finally {
          submitting = false;
          submitButton.disabled = false;
        }
      });
    }
    function upsellsFor(item) {
      const preferred = item.prepStation === "kitchen" ? ["Bottled Water", "Coca-Cola", "House Lager"] : ["Bottled Water", "Spinach & Artichoke Dip", "Club Soda"];
      return preferred.map((name) => data.menu.find((m) => normalizedName(m.value.name) === normalizedName(name))?.value).filter((m) => m && m.id !== item.id && m.available && m.priceCents !== null && !m.modifiers.some((g) => g.required));
    }
    function splitDialog() {
      const d = dialog("Split this check", "Select items on the check to move them, or share every item equally.");
      d.append(action(`Move ${selected.size} selected to a new check`, async () => {
        if (!selected.size) throw new Error("Select drinks first.");
        await command({ action: "split", checkId: check().id, itemIds: [...selected], name: `Check ${tab().value.checks.length + 1}` }, (t) => {
          selectedCheck = t.value.checks.at(-1).id;
        });
        selected.clear();
        d.close();
      }));
      const count = select2("Number of equal checks", Array.from({ length: 9 }, (_, i) => [i + 2, `${i + 2} checks`]), 2);
      d.append(field("Share equally", count), action("Split equally", async () => {
        await command({ action: "equal", checkId: check().id, count: Number(count.value) });
        selected.clear();
        d.close();
      }, { primary: true }));
    }
    function moveDialog() {
      if (!selected.size) throw new Error("Select drinks on the check first.");
      formDialog("Move selected drinks", [{ name: "checkId", label: "Destination check", value: selectedCheck, options: tab().value.checks.filter((c) => !c.orderId).map((c) => [c.id, c.name]) }, { name: "seat", label: "Seat", value: seat, type: "number" }], "Move drinks", (v) => command({ action: "move", itemIds: [...selected], checkId: v.checkId, seat: Number(v.seat) }, () => selected.clear()));
    }
    function overrideDialog() {
      if (selected.size !== 1) throw new Error("Select one drink for a comp or void.");
      formDialog("Manager adjustment", [{ name: "action", label: "Adjustment", options: [["comp", "Comp \u2014 served free"], ["void", "Void \u2014 remove charge"]] }, { name: "reason", label: "Reason" }], "Apply adjustment", (v) => command({ ...v, itemId: [...selected][0] }, () => selected.clear()), "Poured drinks remain deducted from stock.");
    }
    function repeatDialog() {
      const rounds = [...new Set(tab().value.items.map((i) => i.roundId).filter(Boolean))];
      if (!rounds.length) throw new Error("Send the first round before repeating it.");
      formDialog("Repeat a round", [{ name: "roundId", label: "Round", value: rounds.at(-1), options: rounds.map((id, n) => [id, `Round ${n + 1}`]) }], "Add another round", (v) => command({ action: "repeat", roundId: v.roundId, checkId: check().id }), "The current menu prices and availability apply. Review and send the new round.");
    }
    function tabDialog() {
      const d = dialog("Manage tab");
      d.append(
        action("Rename / change table", () => {
          d.close();
          formDialog("Tab details", [{ name: "name", label: "Guest or tab name", value: tab().value.name }, { name: "table", label: "Table", value: tab().value.table }], "Save details", (v) => command({ action: "rename", ...v }));
        }),
        action("Add a check", async () => {
          await send(`${currentPath()}/new-check`, { version: tab().version, name: `Check ${tab().value.checks.length + 1}` }, (t) => {
            selectedCheck = t.value.checks.at(-1).id;
          });
          d.close();
        }),
        action("Merge into another tab", () => {
          const others = data.tabs.filter((t) => t.value.status === "open" && t.id !== selectedTab);
          if (!others.length) throw new Error("Open another tab first.");
          d.close();
          formDialog("Merge tabs", [{ name: "targetId", label: "Destination tab", options: others.map((t) => [t.id, t.value.name]) }], "Merge tabs", (v) => {
            const target = data.tabs.find((t) => t.id === v.targetId);
            return send(`${currentPath()}/merge`, { version: tab().version, targetId: target.id, targetVersion: target.version }, pick);
          });
        }),
        data.canManage ? action("Cancel unpaid tab", () => {
          d.close();
          formDialog("Cancel unpaid tab", [{ name: "reason", label: "Reason" }], "Cancel tab", (v) => command({ action: "cancel", reason: v.reason }, () => {
            newBill = true;
            selectedTab = null;
            selectedCheck = null;
            lastAddedMenuId = null;
            selected.clear();
          }));
        }, { danger: true }) : document.createTextNode("")
      );
    }
    function renderTickets() {
      const automatic = printers.configuration().automaticRoles.includes(ticketStation);
      screen.append(
        row(action("Kitchen", () => {
          ticketStation = "kitchen";
          render2();
        }, { primary: ticketStation === "kitchen" }), action("Bar", () => {
          ticketStation = "bar";
          render2();
        }, { primary: ticketStation === "bar" })),
        note(ticketStation === "kitchen" ? "Food is routed here with its seat, options and preparation notes." : "Drinks are routed here separately from the food."),
        note(automatic ? "Automatic printing is enabled for this station. Check each ticket\u2019s print status below." : "Print tickets manually, or choose a station printer and enable automatic printing in Receipt printer.")
      );
      const tickets = data.tickets.filter((t) => t.value.status === "queued" && (t.value.station || "bar") === ticketStation).reverse();
      const board = el("div", { class: "bar-ticket-grid" });
      for (const t of tickets) board.append(el("section", { class: "bar-ticket" }, [
        row(el("h2", {}, t.value.tabName), el("span", {}, new Date(t.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))),
        note(`${t.value.table || "Bar"} \xB7 ${ticketStation === "kitchen" ? "KITCHEN" : "BAR"}`),
        ...t.value.items.map((i) => el("div", { class: `bar-ticket-line ${i.voided ? "voided" : ""}` }, [el("strong", {}, `${i.voided ? "VOID \u2014 " : ""}${i.name}`), note(`Seat ${i.seat}${i.modifiers.length ? " \xB7 " + i.modifiers.join(" \xB7 ") : ""}`), preparationNotes(i.instructions)])),
        printers.status(t) ? note(["submitted", "alreadySubmitted"].includes(printers.status(t).status) ? "Sent to printer" : printers.status(t).message || "Printing needs attention") : null,
        action("Mark ready", () => send(`${API}/tickets/${t.id}/ready`, {}), { primary: true }),
        action("Print ticket", () => ticketReceipt(t))
      ]));
      if (!tickets.length) board.append(note("All caught up. New orders will appear here."));
      screen.append(board);
      const ready = data.tickets.filter((t) => t.value.status === "ready" && (t.value.station || "bar") === ticketStation).slice(0, 10);
      if (ready.length) screen.append(el("h2", {}, "Ready for pickup"), ...ready.map((t) => note(`${t.value.tabName} \xB7 ${t.value.items.filter((i) => !i.voided).map((i) => i.name).join(", ")}`)));
    }
    function ticketReceipt(t) {
      const d = dialog("Kitchen / bar ticket");
      d.append(el("div", { class: "bar-receipt" }, [el("h2", {}, `${(t.value.station || "bar").toUpperCase()} \xB7 ${t.value.tabName}`), note(t.value.table || "Bar"), note(`Ticket ${t.id} \xB7 ${new Date(t.createdAt).toLocaleString()}`), ...t.value.items.map((i) => el("div", {}, [el("h3", {}, `${i.voided ? "VOID \u2014 " : ""}${i.name} \xB7 Seat ${i.seat}`), note(i.modifiers.join(" \xB7 ")), i.instructions ? el("p", { class: "bar-instructions" }, i.instructions) : null]))]));
      d.append(printButton("Print ticket", ticketPrintDocument(t)));
    }
    function historyDialog() {
      const d = dialog("Recent checks");
      const checks = data.tabs.flatMap((t) => t.value.checks.filter((c) => c.orderId).map((c) => ({ t, c })));
      if (!checks.length) d.append(note("No checks have reached payment yet."));
      for (const { t, c } of checks) d.append(action(`${t.value.name} \xB7 ${c.name} \xB7 ${formatCents(c.totalCents)} \xB7 ${c.status}`, () => {
        pick(t);
        selectedCheck = c.id;
        render2();
        d.close();
      }));
    }
    async function paymentDialog() {
      if (!check().orderId) {
        const d2 = dialog("Review check", "Set the tip before payment. For multiple cards, collect one portion at a time; cash can pay the final balance.");
        const tip = input({ name: "tip", value: (check().tipCents / 100).toFixed(2) });
        tip.setAttribute("aria-label", "Tip amount");
        tip.setAttribute("inputmode", "decimal");
        const buttons = row(...[0, 18, 20, 25].map((p) => action(`${p}%`, () => {
          tip.value = (Math.round(check().subtotalCents * p / 100) / 100).toFixed(2);
        })));
        d2.append(buttons, field("Tip $", tip));
        d2.append(note(drawer ? "This check will use the open drawer if cash is collected." : "Open a drawer before checkout if any guest will pay cash."), action("Continue to payment", async () => {
          if (money(tip.value) !== check().tipCents) await command({ action: "tip", checkId: check().id, tipCents: money(tip.value) });
          await send(`${currentPath()}/checks/${check().id}/checkout`, { version: tab().version, registerId: station, ...drawer ? { cashSessionId: drawer.session.id } : {} });
          d2.close();
          await paymentDialog();
        }, { primary: true }));
        return;
      }
      const orderId = check().orderId;
      const d = dialog("Take payment");
      const slot = el("div");
      d.append(slot);
      let pollBusy = false;
      async function updatePayment() {
        if (!d.isConnected || pollBusy) return;
        pollBusy = true;
        try {
          const [balance, attempts] = await Promise.all([getData(`/api/pos/orders/${orderId}/balance`), getData(`/api/pos/orders/${orderId}/payment-attempts`)]);
          const oldCard = slot.querySelector('[name="cardAmount"]')?.value;
          const oldCash = slot.querySelector('[name="cashReceived"]')?.value;
          if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName) && slot.contains(document.activeElement) && !attempts.some((a) => !["succeeded", "failed", "canceled"].includes(a.status))) return;
          const focus = slot.contains(document.activeElement) ? document.activeElement.name : null;
          clear(slot);
          slot.append(el("h3", {}, `Balance ${formatCents(balance.remainingCents)}`), note(`${formatCents(balance.capturedCents)} collected \xB7 ${balance.status}`));
          if (doneStatuses.includes(balance.status)) {
            slot.append(action("View receipt", () => {
              d.close();
              return receiptDialog(orderId);
            }, { primary: true }));
            await refresh();
            return;
          }
          const pendingAttempt = attempts.find((a) => !["succeeded", "failed", "canceled"].includes(a.status));
          if (pendingAttempt) {
            slot.append(note(`Reader payment: ${pendingAttempt.status}. Payment is complete only after confirmation.`), action("Cancel reader attempt", () => send(`/api/pos/payment-attempts/${pendingAttempt.id}/cancel`, {})));
          } else if (!balance.cancellationStarted) {
            const cardAmount = input({ name: "cardAmount", value: oldCard ?? (balance.remainingCents / 100).toFixed(2) });
            cardAmount.setAttribute("aria-label", "Card payment amount");
            cardAmount.setAttribute("inputmode", "decimal");
            slot.append(field("Charge this card $", cardAmount), action("Send to card reader", async () => {
              const amountCents = money(cardAmount.value);
              if (amountCents <= 0 || amountCents > balance.remainingCents) throw new Error("Enter an amount within the remaining balance.");
              await send(`/api/pos/orders/${orderId}/card-payments`, { amountCents, idempotencyKey: newIdempotencyKey() });
              await updatePayment();
            }, { primary: true, disabled: busy || !readiness?.tenders?.cardPresent?.enabled || balance.remainingCents <= 0 }));
            if (!readiness?.tenders?.cardPresent?.enabled) slot.append(note("Connect the approved merchant account and reader to enable cards."));
            const cashReceived = input({ name: "cashReceived", value: oldCash ?? (balance.remainingCents / 100).toFixed(2) });
            cashReceived.setAttribute("aria-label", "Cash received");
            cashReceived.setAttribute("inputmode", "decimal");
            const change = note("");
            const updateChange = () => {
              try {
                change.textContent = `Change to give: ${formatCents(Math.max(0, money(cashReceived.value) - balance.remainingCents))}`;
              } catch {
                change.textContent = "Enter the cash received.";
              }
            };
            cashReceived.addEventListener("input", updateChange);
            updateChange();
            slot.append(field("Cash received $", cashReceived), change, action(balance.remainingCents === 0 ? "Complete zero-balance check" : "Collect cash & give change", async () => {
              const received = money(cashReceived.value);
              if (received < balance.remainingCents) throw new Error("Cash received is below the balance. Use card portions first, then collect the cash remainder.");
              if (drawer && balance.remainingCents > 0) await send(`${currentPath()}/checks/${check().id}/drawer`, { cashSessionId: drawer.session.id, registerId: station });
              await send(`/api/pos/orders/${orderId}/pay`, { tenders: balance.remainingCents ? [{ kind: "cash", amountCents: balance.remainingCents, cashReceivedCents: received, idempotencyKey: newIdempotencyKey() }] : [] });
              await updatePayment();
            }, { disabled: busy || !drawer && balance.remainingCents > 0 }));
          }
          if (!drawer && balance.remainingCents > 0) slot.append(action("Open drawer for cash", drawerDialog));
          if (data.canManage) slot.append(action("Cancel check / reverse partial payment", () => {
            const confirm = dialog("Reverse this check?", `Collected card portions will be refunded to the original cards. Check total: ${formatCents(check().totalCents)}.`);
            confirm.append(action("Reverse check", async () => {
              await send(`/api/pos/orders/${orderId}/cancel-split`, {});
              confirm.close();
              await updatePayment();
            }, { danger: true }));
          }, { danger: true }));
          if (focus) slot.querySelector(`[name="${focus}"]`)?.focus({ preventScroll: true });
        } finally {
          pollBusy = false;
        }
      }
      await updatePayment();
      async function poll2() {
        if (!d.isConnected) return;
        if (!busy) await updatePayment().catch(failure);
        setTimeout(poll2, 2500);
      }
      d.append(action("Refresh payment status", updatePayment));
      setTimeout(poll2, 2500);
    }
    async function receiptDialog(orderId) {
      const r = await getData(`/api/pos/receipts/${orderId}`);
      const d = dialog("Receipt & refunds");
      const receipt = el("div", { class: "bar-receipt" }, [el("h2", {}, r.merchant.name), note(`Receipt ${r.order.receipt_number} \xB7 ${r.order.status}`), r.order.note?.startsWith("Bill:") ? el("p", { class: "bar-instructions" }, r.order.note) : null, ...r.order.lines.map((l) => row(l.description, formatCents(l.line_total_cents))), row("Tax", formatCents(r.order.tax_cents)), row("Tip", formatCents(r.order.tip_cents)), row(el("strong", {}, "Total"), el("strong", {}, formatCents(r.order.total_cents))), note(`Paid ${formatCents(r.amountPaidCents)} \xB7 Refunded ${formatCents(r.amountRefundedCents)}`), note(r.merchant.receiptFooter || "")]);
      d.append(receipt);
      for (const t of r.tenders.filter((t2) => ["captured", "partially_refunded", "refunded"].includes(t2.status))) {
        receipt.append(row(t.kind === "provider" ? "Card" : t.kind === "cash" ? "Cash" : "Payment", formatCents(t.amount_cents)));
        if (t.provider_ref) receipt.append(note(`Transaction ID: ${t.provider_ref}`));
        if (t.kind === "cash") receipt.append(row("Cash received", formatCents(t.cash_received_cents)), row("Change given", formatCents(t.change_due_cents)));
      }
      d.append(printButton("Print receipt", receiptPrintDocument(r)));
      if (data.canManage) for (const tender of r.tenders.filter((t) => t.amount_cents > t.refunded_cents && ["captured", "partially_refunded"].includes(t.status))) {
        d.append(action(`Refund ${tender.kind === "provider" ? "card" : tender.kind} payment`, () => {
          formDialog("Refund original payment", [{ name: "amount", label: "Refund amount $", value: ((tender.amount_cents - tender.refunded_cents) / 100).toFixed(2), numeric: true }, { name: "reason", label: "Reason" }], "Issue refund", async (v) => {
            await send(`/api/pos/orders/${orderId}/refunds`, { tenderId: tender.id, idempotencyKey: newIdempotencyKey(), amountCents: money(v.amount), reason: v.reason, lines: [], ...tender.kind === "cash" && drawer ? { cashSessionId: drawer.session.id } : {} });
            d.close();
            await receiptDialog(orderId);
          }, "Refunds return money to the original payment. Poured stock stays consumed.");
        }));
      }
    }
    function drawerDialog() {
      if (!drawer) return formDialog("Open drawer shift", [{ name: "float", label: "Opening float $", value: "0.00", numeric: true }], "Open drawer", (v) => send("/api/pos/drawer/open", { drawerRef: station, registerRef: station, openingFloatCents: money(v.float) }));
      const d = dialog("Drawer shift");
      d.append(note(stationName()), note(`Expected cash: ${formatCents(drawer.reconciliation.effectiveExpectedCents)}`), action("Cash in / out", () => {
        d.close();
        formDialog("Cash movement", [{ name: "kind", label: "Movement", options: [["paid_in", "Paid in"], ["paid_out", "Paid out"], ["drop", "Cash drop"]] }, { name: "amount", label: "Amount $", numeric: true }, { name: "note", label: "Reason" }], "Save movement", (v) => send(`/api/pos/drawer/${drawer.session.id}/movements`, { kind: v.kind, amountCents: money(v.amount), note: v.note, idempotencyKey: newIdempotencyKey() }));
      }), action("Close drawer", () => {
        d.close();
        formDialog("Close drawer shift", [{ name: "counted", label: "Cash counted $", numeric: true }, { name: "note", label: "Closing note" }], "Close shift", (v) => send(`/api/pos/drawer/${drawer.session.id}/close`, { countedCents: money(v.counted), note: v.note }));
      }), button("Money & reconciliation", { href: "#/money" }));
    }
    function download(name, content, type = "text/csv") {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const link = el("a", { href: url, download: name });
      container.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    }
    function exportMenu() {
      const cell = (v) => `"${String(v).replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
      download("one-club-menu.csv", ["name,category,price,station", ...data.menu.map((m) => [m.value.name, m.value.category, m.value.priceCents === null ? "" : (m.value.priceCents / 100).toFixed(2), m.value.prepStation || "bar"].map(cell).join(","))].join("\r\n"));
    }
    function importMenuDialog() {
      const d = dialog("Import menu", "Paste the menu CSV below. Review every price and preparation station before adding the items. Existing items are kept; duplicate names stop the entire import.");
      const csv = el("textarea", { "aria-label": "Menu CSV", rows: 9, placeholder: "name,category,price,station\nHouse Lager,Beer,6.00,bar\nBurger,Food,16.00,kitchen" });
      d.append(csv);
      const preview = el("div");
      d.append(preview);
      d.append(action("Review import", async () => {
        const result = await mutate(`${API}/menu-import-preview`, "POST", { csv: csv.value });
        clear(preview);
        for (const m of result.data.items) preview.append(row(m.name, m.category, m.prepStation, menuPrice(m)));
        preview.append(action(`Add ${result.data.items.length} items`, async () => {
          const imported = await send(`${API}/menu-import`, { items: result.data.items });
          d.close();
          toast(`${imported.added} items added.`);
        }, { primary: true }));
      }, { primary: true }));
      csv.addEventListener("input", () => clear(preview));
    }
    async function setupDialog() {
      setupDoc = await getData(`${API}/setup`);
      const d = dialog("Set up the bar", "Prepare the venue now. Equipment details stay marked pending until we can inspect and connect the actual devices.");
      const v = setupDoc?.value;
      d.append(el("h3", {}, "One bar register"), note("One iPad, one cash drawer, and a card reader. Each bartender signs in with their own four-digit PIN."));
      const venue = input({ value: v?.venueName || "ONE Club" }), phone = input({ value: v?.supportPhone || "" }), processor = input({ value: v?.processorName || "" });
      d.append(field("Venue name", venue), field("Support phone", phone), field("Existing processor name (when known)", processor));
      d.append(el("h3", {}, "Equipment to reuse"));
      const devices = [];
      const deviceSlot = el("div");
      d.append(deviceSlot);
      const addDevice = (value = {}) => {
        const name = input({ value: value.name || "", placeholder: "Bar iPad" }), model = input({ value: value.model || "", placeholder: "Model when known" });
        const kind = select2("Equipment type", [["ipad", "iPad"], ["reader", "Card reader"], ["printer", "Printer (kitchen / receipt)"], ["drawer", "Cash drawer"]], value.kind || "ipad");
        const connection = select2("Connection", [["unknown", "Connection unknown"], ["usb", "USB"], ["bluetooth", "Bluetooth"], ["network", "Network"]], value.connection || "unknown");
        const access = select2("Equipment access", [["pending", "Access pending"], ["available", "Access available"]], value.access || "pending");
        const section2 = el("div", { class: "bar-option-group" });
        const device = { id: value.id || newIdempotencyKey(), name, model, kind, connection, access };
        devices.push(device);
        section2.append(field("Equipment name", name), row(kind, connection), field("Model", model), row(access, action("Remove equipment", () => {
          devices.splice(devices.indexOf(device), 1);
          section2.remove();
        })));
        deviceSlot.append(section2);
      };
      for (const device of v?.devices || []) addDevice(device);
      d.append(action("Add equipment", () => addDevice()), action("Save venue & equipment", async () => {
        await send(`${API}/setup`, { expectedVersion: setupDoc?.version || 0, venueName: venue.value, supportPhone: phone.value, processorName: processor.value, devices: devices.map((v2) => ({ id: v2.id, name: v2.name.value, kind: v2.kind.value, model: v2.model.value, connection: v2.connection.value, access: v2.access.value })) });
        d.close();
        toast("Venue setup saved.");
      }, { primary: true }));
      d.append(el("h3", {}, "Payments & receipts"), note(readiness?.tenders?.cardPresent?.enabled ? "The configured reader adapter is responding. Practice mode still uses simulated payments." : "Card payments await the merchant account and a compatible, provisioned reader."), note("Open tabs currently track food and drinks. Holding a card, adding to its authorization, and changing tips after payment require processor support and are not enabled."));
      const settings = readiness.settings;
      const tax = input({ value: settings.taxBps === null ? "" : (settings.taxBps / 100).toFixed(2) }), footer = input({ value: settings.receiptFooter || "" });
      d.append(field("Sales tax % (venue-confirmed rate)", tax), field("Receipt footer", footer), action("Save tax & receipt", async () => {
        if (!/^\d+(\.\d{1,2})?$/.test(tax.value.trim())) throw new Error("Enter a tax percentage such as 10.00.");
        await mutate("/api/pos/settings", "PUT", { taxBps: money(tax.value), receiptFooter: footer.value });
        await refresh();
        toast("Tax and receipt settings saved.");
      }));
      d.append(el("h3", {}, "Opening shift"), note("1. Sign in with your four-digit PIN.\n2. Choose Cash shift below and count the opening cash.\n3. Open a tab, choose seats, food and drinks, then Send round.\n4. Split or pay each check, then close the tab.\n5. Count cash and close the shift at shift end."), action("Cash shift", () => {
        d.close();
        drawerDialog();
      }), button("Staff & PIN access", { onClick: () => {
        d.close();
        document.querySelector("#current-user")?.click();
      } }), button("More venue settings", { href: "#/settings" }));
    }
    function renderManage() {
      const menu = el("section", { class: "bar-manage-section" }, [row(el("h2", {}, "Food & drinks menu"), action("Add food / drink", () => menuEditor(), { primary: true }))]);
      for (const m of data.menu) menu.append(row(el("div", {}, [el("strong", {}, m.value.name), note(`${m.value.category} \xB7 ${m.value.prepStation === "kitchen" ? "Kitchen" : "Bar"} \xB7 ${menuPrice(m.value)} \xB7 ${m.value.available ? "Available" : "Sold out"}`)]), action("Edit", () => menuEditor(m))));
      const stock = el("section", { class: "bar-manage-section" }, [row(el("h2", {}, "Ingredients & counts"), action("Add ingredient", () => stockEditor(), { primary: true }))]);
      for (const i of data.ingredients) stock.append(row(el("div", {}, [el("strong", {}, i.value.name), note(`${i.value.onHand} ${i.value.unit}`)]), action("Count", () => stockEditor(i))));
      screen.append(row(action("Import menu CSV", importMenuDialog), action("Export menu CSV", exportMenu), action("Export menu & recipes", () => download("one-club-menu-recipes.json", JSON.stringify({ exportedAt: (/* @__PURE__ */ new Date()).toISOString(), menu: data.menu, ingredients: data.ingredients }, null, 2), "application/json"))), el("div", { class: "bar-manage-grid" }, [menu, stock]));
    }
    function stockEditor(doc) {
      formDialog(doc ? "Count ingredient" : "Add ingredient", [{ name: "name", label: "Ingredient name", value: doc?.value.name }, { name: "unit", label: "Stock unit", value: doc?.value.unit, options: [["ml", "Milliliters"], ["unit", "Units / bottles / cans"]] }, { name: "onHand", label: "Count on hand", value: doc?.value.onHand ?? 0, type: "number" }, { name: "reason", label: "Reason" }], "Save count", (v) => send(`${API}/stock`, { ...doc ? { id: doc.id, expectedVersion: doc.version } : {}, ...v, onHand: Number(v.onHand) }));
    }
    function optionRecipe(choice) {
      const d = dialog("Extra ingredients", "Ingredients consumed when this option is selected. Quantities add to the base recipe.");
      const rows = [], slot = el("div");
      d.append(slot);
      const add = (value = {}) => {
        const ingredient = select2("Ingredient", data.ingredients.map((i) => [i.id, `${i.value.name} (${i.value.unit})`]), value.ingredientId);
        const quantity = input({ type: "number", value: value.quantity || 1 });
        quantity.setAttribute("aria-label", "Extra ingredient quantity");
        const entry = { ingredient, quantity }, line = row(ingredient, quantity);
        rows.push(entry);
        line.append(action("Remove", () => {
          rows.splice(rows.indexOf(entry), 1);
          line.remove();
        }));
        slot.append(line);
      };
      for (const value of choice.recipe) add(value);
      d.append(action("Add ingredient", () => {
        if (!data.ingredients.length) throw new Error("Add ingredients in Menu & stock first.");
        add();
      }), action("Use these ingredients", () => {
        const recipe = rows.map((r) => ({ ingredientId: r.ingredient.value, quantity: Number(r.quantity.value) }));
        if (recipe.some((r) => !Number.isInteger(r.quantity) || r.quantity <= 0)) throw new Error("Use positive whole quantities.");
        choice.recipe = recipe;
        d.close();
      }, { primary: true }));
    }
    function menuEditor(doc, preset) {
      const m = doc?.value || preset;
      const d = dialog(doc ? "Edit menu item" : "Add food / drink");
      const name = input({ value: m?.name ?? "" });
      const cat = input({ value: m?.category ?? "Cocktails" });
      const price = input({ value: m?.priceCents == null ? "" : (m.priceCents / 100).toFixed(2), placeholder: "Set price" });
      price.setAttribute("aria-label", "Price $");
      const description = input({ value: m?.description || "" });
      const instructions = el("textarea", { rows: 6, "aria-label": "Preparation instructions" });
      instructions.value = m?.instructions || "";
      const prep = select2("Send to", [["bar", "Bar \u2014 drinks"], ["kitchen", "Kitchen \u2014 food"]], m?.prepStation || "bar");
      const availability = select2("Availability", [["yes", "Available"], ["no", "Sold out"]], m?.available === false ? "no" : "yes");
      const happy = select2("Happy hour", [["no", "Regular pricing"], ["yes", "Happy hour active"]], m?.happyHour ? "yes" : "no");
      const happyPrice = input({ value: m?.happyHourPriceCents == null || !m ? "" : (m.happyHourPriceCents / 100).toFixed(2) });
      d.append(field("Item name", name), field("Send to", prep), row(field("Category", cat), field("Price $", price)), row(field("Availability", availability), field("Pricing", happy)), field("Happy hour price $", happyPrice), el("h3", {}, "Recipe"));
      d.append(note("Leave an unknown price blank. The item stays on the menu but cannot be sold until priced."), field("Description / included sides", description), field("Preparation instructions", instructions));
      const recipeRows = [];
      const recipes = el("div");
      d.append(recipes);
      const addRecipe = (r = {}) => {
        const ingredient = select2("Ingredient", data.ingredients.map((i) => [i.id, `${i.value.name} (${i.value.unit})`]), r.ingredientId);
        const quantity = input({ value: r.quantity ?? 1, type: "number" });
        quantity.setAttribute("aria-label", "Recipe quantity");
        const line = row(ingredient, quantity);
        const entry = { ingredient, quantity, line };
        recipeRows.push(entry);
        line.append(action("Remove", () => {
          recipeRows.splice(recipeRows.indexOf(entry), 1);
          line.remove();
        }));
        recipes.append(line);
      };
      for (const r of m?.recipe ?? []) addRecipe(r);
      d.append(action("Add ingredient to recipe", () => {
        if (!data.ingredients.length) throw new Error("Add ingredients in stock first.");
        addRecipe();
      }));
      d.append(el("h3", {}, "Preparation options"), note("Examples: spirit, mixer, side dish, or cooking preference. Each group allows one choice."));
      const groups = [];
      const groupSlot = el("div");
      d.append(groupSlot);
      const addGroup = (g = {}) => {
        const groupName = input({ value: g.name ?? "" });
        const required = select2("Choice required", [["no", "Optional"], ["yes", "Required"]], g.required ? "yes" : "no");
        const group = el("div", { class: "bar-option-group" });
        const choices = [];
        const choiceSlot = el("div");
        const entry = { id: g.id || newIdempotencyKey(), groupName, required, choices, group };
        groups.push(entry);
        group.append(row(field("Option group", groupName), required, action("Remove group", () => {
          groups.splice(groups.indexOf(entry), 1);
          group.remove();
        })), choiceSlot);
        const addChoice = (v = {}) => {
          const choiceName = input({ value: v.name ?? "", placeholder: "Choice name" });
          choiceName.setAttribute("aria-label", "Choice name");
          const extra = input({ value: ((v.priceCents ?? 0) / 100).toFixed(2) });
          extra.setAttribute("aria-label", "Extra price $");
          const line = row(choiceName, extra);
          const choice = { id: v.id || newIdempotencyKey(), choiceName, extra, recipe: v.recipe ?? [] };
          choices.push(choice);
          line.append(action("Extra ingredients", () => optionRecipe(choice)), action("Remove", () => {
            choices.splice(choices.indexOf(choice), 1);
            line.remove();
          }));
          choiceSlot.append(line);
        };
        for (const v of g.choices ?? []) addChoice(v);
        group.append(action("Add choice", () => addChoice()));
        groupSlot.append(group);
      };
      for (const g of m?.modifiers ?? []) addGroup(g);
      d.append(action("Add option group", () => addGroup()), action("Save menu item", async () => {
        await send(`${API}/menu`, { ...doc ? { id: doc.id, expectedVersion: doc.version } : {}, name: name.value, category: cat.value, prepStation: prep.value, priceCents: price.value.trim() ? money(price.value) : null, description: description.value, instructions: instructions.value, available: availability.value === "yes", happyHour: happy.value === "yes", happyHourPriceCents: happyPrice.value.trim() ? money(happyPrice.value) : null, recipe: recipeRows.map((r) => ({ ingredientId: r.ingredient.value, quantity: Number(r.quantity.value) })), modifiers: groups.map((g) => ({ id: g.id, name: g.groupName.value, required: g.required.value === "yes", choices: g.choices.map((c) => ({ id: c.id, name: c.choiceName.value, priceCents: money(c.extra.value), recipe: c.recipe })) })) });
        d.close();
      }, { primary: true }));
    }
    await refresh().catch(() => {
      connectionError = "Connection unavailable. Reload to reconnect.";
      screen.append(note(connectionError), action("Reconnect", refresh));
    });
    async function poll() {
      if (!container.isConnected) return;
      if (!busy && !container.querySelector("dialog[open]") && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) await refresh().catch(() => {
        connectionError = "Connection lost \xB7 Reconnect before taking another order.";
        render2();
      });
      setTimeout(poll, 5e3);
    }
    setTimeout(poll, 5e3);
  });

  // apps/ui/public/src/scan.mjs
  var DEFAULT_WINDOW_MS = 3e3;
  function aggregateScan(lines, scan, windowMs = DEFAULT_WINDOW_MS) {
    const list = lines.map((l) => ({ ...l }));
    const add = scan.qty && scan.qty > 0 ? scan.qty : 1;
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].code === scan.code && scan.at - list[i].lastAt <= windowMs) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      list[idx].qty += add;
      list[idx].lastAt = scan.at;
      return { lines: list, changed: "bumped", index: idx };
    }
    list.push({ code: scan.code, qty: add, firstAt: scan.at, lastAt: scan.at });
    return { lines: list, changed: "added", index: list.length - 1 };
  }

  // apps/ui/public/js/views/scan.js
  var REASON = { receive: "received", sell: "sold", count: "counted" };
  registerView("scan", async (container) => {
    container.append(viewHeader({ title: "Scan", subtitle: "Scan an item, then choose what happened." }));
    let locations = [];
    try {
      locations = await getData("/api/inventory/locations") || [];
    } catch {
      locations = [];
    }
    if (!locations.length) {
      container.append(
        emptyState({
          icon: "\u{1F4CD}",
          title: "Add a stock location first",
          message: "Scanning records stock moving in and out of a place \u2014 a warehouse, the trailer, a show. Create one in Stock, then come back.",
          actions: [button("Go to Stock", { primary: true, href: "#/stock" })]
        })
      );
      return;
    }
    let currentLocation = locations[0].id;
    const locSelect = el(
      "select",
      { "aria-label": "Location", onchange: (e) => currentLocation = e.target.value },
      locations.map((l) => el("option", { value: l.id }, `${l.name} (${l.kind})`))
    );
    const scanInput = el("input", {
      type: "text",
      class: "scan-box",
      placeholder: "Scan or type a barcode, then Enter",
      "aria-label": "Barcode",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      style: "font-size:1.3rem;height:64px"
    });
    const resultSlot = el("div", { style: "margin-top:14px" });
    const recentSlot = el("div", { style: "margin-top:18px" });
    let pending = [];
    let lastMatch = null;
    container.append(
      section(
        null,
        el("div", { class: "field" }, [el("label", { for: "loc" }, "Location"), locSelect]),
        scanInput,
        el("p", { class: "hint" }, "Tip: the scanner types the code and presses Enter for you.")
      ),
      resultSlot,
      recentSlot
    );
    const refocus = () => {
      if (document.activeElement === document.body) scanInput.focus();
    };
    scanInput.addEventListener("blur", () => setTimeout(refocus, 60));
    const clickRefocus = (e) => {
      if (!e.target.closest("button") && !e.target.closest("select") && !e.target.closest("a")) scanInput.focus();
    };
    container.addEventListener("click", clickRefocus);
    setTimeout(() => scanInput.focus(), 30);
    scanInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const code = scanInput.value.trim();
        scanInput.value = "";
        if (code) onScan(code);
      }
    });
    async function onScan(code) {
      const at = Date.now();
      const agg = aggregateScan(pending, { code, at }, DEFAULT_WINDOW_MS);
      pending = agg.lines;
      try {
        const match = await getData("/api/catalog/lookup", { code });
        lastMatch = normalizeMatch(match, code);
        beepOk();
        flash("ok");
        announce(`Found ${lastMatch.name}`);
        renderResult(lastMatch, agg.changed === "bumped" ? aggQty(code) : 1);
      } catch (err) {
        buzzError();
        flash("err");
        announce("Not found");
        renderNotFound(code, err);
      }
      renderRecent();
    }
    function aggQty(code) {
      const line = [...pending].reverse().find((l) => l.code === code);
      return line ? line.qty : 1;
    }
    async function loadStock(variationId) {
      try {
        const rows = await getData("/api/inventory/stock", { variationId }) || [];
        return Array.isArray(rows) ? rows : rows.rows || [];
      } catch {
        return [];
      }
    }
    async function renderResult(match, initialQty) {
      clear(resultSlot);
      const stepper = qtyStepper(initialQty || 1);
      const stockRows = await loadStock(match.variationId);
      const stockTable = dataTable(
        [
          { key: "location", label: "Location", render: (r) => r.locationName || r.locationId || "\u2014" },
          { key: "onHand", label: "On hand", num: true, render: (r) => onHandOf(r) }
        ],
        stockRows,
        { emptyMessage: "Not yet counted here." }
      );
      const doMove = async (kind) => {
        const qty = stepper.getQty();
        await postMovement(kind, match, qty, currentLocation);
        scanInput.focus();
      };
      resultSlot.append(
        section(
          null,
          el("div", { style: "display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap" }, [
            el("div", {}, [
              el("h2", { style: "margin:0" }, match.name),
              match.variationName ? el("div", { class: "view-sub" }, match.variationName) : null,
              match.priceCents != null ? chip(formatCents(match.priceCents), "ok") : null
            ]),
            el("div", {}, [el("div", { class: "hint" }, "Quantity"), stepper])
          ]),
          el("div", { class: "view-actions", style: "margin-top:14px" }, [
            button("Count", { big: true, onClick: () => doMove("count"), title: "Record a counted quantity" }),
            button("Receive", { big: true, primary: true, onClick: () => doMove("receive"), title: "Stock arriving" }),
            button("Sell", { big: true, onClick: () => doMove("sell"), title: "Sold off the books" }),
            button("Move", { big: true, onClick: () => quickMove(match, stepper.getQty()) })
          ]),
          el("h3", { style: "margin-top:16px" }, "On hand by location"),
          stockTable
        )
      );
    }
    function renderNotFound(code, err) {
      clear(resultSlot);
      resultSlot.append(
        el("div", { class: "error-banner", role: "alert" }, [
          el("strong", {}, `No item matches "${code}". `),
          el("span", {}, err && err.status === 404 ? "That barcode is not in your catalog yet." : err?.message || "")
        ])
      );
    }
    async function postMovement(kind, match, qty, locationId) {
      const reason = REASON[kind];
      const delta = kind === "sell" ? -Math.abs(qty) : Math.abs(qty);
      const idem = newIdempotencyKey();
      try {
        const res = await mutate(
          "/api/inventory/movements",
          "POST",
          { variationId: match.variationId, locationId, delta, reason, idempotencyKey: idem, refType: "scan" },
          { queueable: true, idempotencyKey: idem }
        );
        if (res && res.queued) toast(`${label(kind)} ${qty} \u2014 saved offline, will sync.`, "warn");
        else toast(`${label(kind)} ${qty} recorded.`);
        beepOk();
        renderResult(match, 1);
      } catch (e) {
        buzzError();
        toast(e.message || "Could not record", "err");
      }
    }
    async function quickMove(match, qty) {
      const dest = locations.filter((l) => l.id !== currentLocation);
      if (!dest.length) return toast("No other location to move to.", "warn");
      const toId = prompt(`Move ${qty} to which location?
` + dest.map((l) => `${l.name} = ${l.id}`).join("\n"), dest[0].id);
      if (!toId) return;
      const idemOut = newIdempotencyKey();
      const idemIn = newIdempotencyKey();
      try {
        await mutate(
          "/api/inventory/movements",
          "POST",
          { variationId: match.variationId, locationId: currentLocation, delta: -Math.abs(qty), reason: "transfer_out", idempotencyKey: idemOut, refType: "quick_move" },
          { queueable: true, idempotencyKey: idemOut }
        );
        await mutate(
          "/api/inventory/movements",
          "POST",
          { variationId: match.variationId, locationId: toId, delta: Math.abs(qty), reason: "transfer_in", idempotencyKey: idemIn, refType: "quick_move" },
          { queueable: true, idempotencyKey: idemIn }
        );
        toast(`Moved ${qty}. For a tracked transfer with receiving, use Transfers.`);
        renderResult(match, 1);
      } catch (e) {
        toast(e.message, "err");
      }
    }
    function renderRecent() {
      clear(recentSlot);
      if (!pending.length) return;
      const rows = [...pending].reverse().slice(0, 12);
      recentSlot.append(
        el("h3", {}, "This session"),
        dataTable(
          [
            { key: "code", label: "Barcode" },
            { key: "qty", label: "Times scanned", num: true }
          ],
          rows
        )
      );
    }
    if ("BarcodeDetector" in window) {
      container.querySelector(".field").append(
        button("Use camera", {
          onClick: () => startCamera()
        })
      );
    }
    async function startCamera() {
      try {
        const Detector = window.BarcodeDetector;
        const detector = new Detector();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const video = el("video", { autoplay: true, playsinline: true, style: "width:100%;max-width:420px;border-radius:10px" });
        video.srcObject = stream;
        const camWrap = section("Camera", video, button("Stop camera", { onClick: () => stop() }));
        resultSlot.before(camWrap);
        let running = true;
        const stop = () => {
          running = false;
          stream.getTracks().forEach((t) => t.stop());
          camWrap.remove();
        };
        const tick = async () => {
          if (!running) return;
          try {
            const codes = await detector.detect(video);
            if (codes && codes.length) {
              stop();
              onScan(codes[0].rawValue);
              return;
            }
          } catch {
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      } catch (e) {
        toast("Camera not available: " + (e.message || ""), "warn");
      }
    }
  });
  function label(kind) {
    return { receive: "Received", sell: "Sold", count: "Counted" }[kind] || "Recorded";
  }
  function normalizeMatch(match, code) {
    const m = match || {};
    const variation = m.variation || m;
    const product = m.product || m;
    return {
      code,
      variationId: m.variationId || variation.id || m.id,
      name: m.productName || product.name || m.name || variation.name || `Item ${code}`,
      variationName: m.variationName || variation.name || (variation.sku ? `SKU ${variation.sku}` : ""),
      priceCents: m.priceCents ?? variation.priceCents ?? product.priceCents ?? null
    };
  }
  function onHandOf(r) {
    const v = r.onHand ?? r.quantity ?? r.qty ?? r.on_hand;
    return v === null || v === void 0 ? "not counted" : String(v);
  }

  // apps/ui/public/js/views/stock.js
  var LOCATION_KINDS = ["warehouse", "trailer", "show", "fulfillment_staging", "reserved", "damaged", "quarantine", "custom"];
  registerView("stock", async (container) => {
    container.append(viewHeader({ title: "Stock", subtitle: "What you have, where it is, and what moved." }));
    let locations = [];
    try {
      locations = await getData("/api/inventory/locations") || [];
    } catch {
      locations = [];
    }
    const body = el("div");
    container.append(body);
    if (!locations.length) {
      clear(body);
      body.append(newLocationCard(() => reload()));
      body.append(
        emptyState({
          icon: "\u{1F4E6}",
          title: "No locations yet",
          message: "Add the places you keep stock \u2014 a warehouse, the trailer, each show. Then count items into them."
        })
      );
      return;
    }
    const locFilter = select("locationFilter", locations.map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` })), locations[0].id);
    const search = input({ name: "q", placeholder: "Search item / SKU" });
    const tableSlot = el("div");
    container.append(
      section(
        "On hand",
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:end;margin-bottom:12px" }, [
          field("Location", locFilter),
          field("Search", search),
          button("Conservation check", { onClick: runConservation })
        ]),
        tableSlot
      ),
      newLocationCard(() => reload())
    );
    locFilter.addEventListener("change", loadStock);
    search.addEventListener("input", () => loadStock());
    async function loadStock() {
      await withLoading(tableSlot, async () => {
        const rows = normalize2(await getData("/api/pos/stock", { locationId: locFilter.value }));
        const q = search.value.trim().toLowerCase();
        const filtered = q ? rows.filter((r) => `${r.name || ""} ${r.sku || ""} ${r.variationId || ""}`.toLowerCase().includes(q)) : rows;
        if (!filtered.length) {
          return emptyState({ icon: "\u{1F5D2}\uFE0F", title: "Nothing counted here yet", message: "Scan items into this location on the Scan screen \u2014 the app never guesses a count." });
        }
        return dataTable(
          [
            { key: "name", label: "Item", render: (r) => r.name || r.variationId },
            { key: "sku", label: "SKU" },
            { key: "onHand", label: "On hand", num: true, render: (r) => onHand(r) },
            { key: "flags", label: "", render: (r) => flags(r) },
            { key: "hist", label: "", render: (r) => button("History", { onClick: () => showHistory(r) }) }
          ],
          filtered
        );
      });
    }
    async function showHistory(r) {
      const list = await getList("/api/inventory/movements", { variationId: r.variationId, limit: 50 });
      const rows = list.data || [];
      const modal = section(
        `Movement history \u2014 ${r.name || r.variationId}`,
        dataTable(
          [
            { key: "created_at", label: "When", render: (m) => formatDateTime(m.created_at || m.createdAt) },
            { key: "reason", label: "Reason" },
            { key: "delta", label: "Change", num: true, render: (m) => m.delta > 0 ? `+${m.delta}` : String(m.delta) },
            { key: "note", label: "Note" }
          ],
          rows,
          { emptyMessage: "No movements recorded." }
        ),
        button("Close", { onClick: () => modal.remove() })
      );
      tableSlot.before(modal);
    }
    async function runConservation() {
      try {
        const report = await getData("/api/inventory/conservation");
        const ok = report && (report.ok === true || report.conserved === true || Array.isArray(report.violations) && report.violations.length === 0);
        toast(ok ? "Conservation check passed \u2014 every unit is accounted for." : "Conservation check found discrepancies. See details.", ok ? "info" : "warn");
      } catch (e) {
        toast(e.message, "err");
      }
    }
    async function reload() {
      location.hash = "#/stock";
    }
    loadStock();
  });
  function newLocationCard(onDone) {
    const name = input({ name: "name", placeholder: "e.g. Warehouse" });
    const kind = select("kind", LOCATION_KINDS.map((k) => ({ value: k, label: k })), "warehouse");
    return section(
      "Add a location",
      field("Name", name),
      field("Kind", kind),
      button("Add location", {
        primary: true,
        onClick: async () => {
          if (!name.value.trim()) return toast("Name is required", "warn");
          try {
            await mutate("/api/inventory/locations", "POST", { name: name.value.trim(), kind: kind.value });
            toast("Location added.");
            onDone();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      })
    );
  }
  function normalize2(rows) {
    if (Array.isArray(rows)) return rows;
    if (rows && Array.isArray(rows.rows)) return rows.rows;
    return [];
  }
  function onHand(r) {
    const v = r.onHand ?? r.quantity ?? r.qty ?? r.on_hand;
    return v === null || v === void 0 ? "not counted" : String(v);
  }
  function flags(r) {
    const wrap = el("span");
    if (r.oversold || typeof r.onHand === "number" && r.onHand < 0) wrap.append(chip("Oversold", "critical"));
    if (r.belowReorder || r.low) wrap.append(chip("Low", "high"));
    return wrap;
  }

  // apps/ui/public/js/views/counts.js
  registerView("counts", async (container, params) => {
    if (params[0]) return renderSession(container, params[0]);
    container.append(
      viewHeader({
        title: "Counts",
        subtitle: "Count your stock. Blind counts hide the expected number until you approve.",
        actions: [button("Print count sheet", { onClick: () => window.print() })]
      })
    );
    const startSlot = el("div");
    const listSlot = el("div");
    container.append(startSlot, listSlot);
    let locations = [];
    try {
      locations = await getData("/api/inventory/locations") || [];
    } catch {
    }
    if (locations.length) {
      const loc = select("loc", locations.map((l) => ({ value: l.id, label: `${l.name} (${l.kind})` })), locations[0].id);
      const kind = select("kind", [{ value: "full", label: "Full count" }, { value: "cycle", label: "Cycle count" }], "full");
      const blind = el("input", { type: "checkbox", id: "blind", style: "width:auto;min-height:auto" });
      startSlot.append(
        section(
          "Start a count",
          field("Location", loc),
          field("Kind", kind),
          el("label", { style: "display:flex;gap:8px;align-items:center" }, [blind, "Blind count (hide expected quantities)"]),
          el("div", { style: "margin-top:10px" }, button("Start count", {
            primary: true,
            onClick: async () => {
              try {
                const res = await mutate("/api/inventory/count-sessions", "POST", { locationId: loc.value, kind: kind.value, blind: blind.checked });
                const s = res.data || res;
                navigate(`#/counts/${s.id}`);
              } catch (e) {
                toast(e.message, "err");
              }
            }
          }))
        )
      );
    } else {
      startSlot.append(emptyState({ icon: "\u{1F4CB}", title: "Add a location first", message: "You count into a location. Create one in Stock.", actions: [button("Go to Stock", { primary: true, href: "#/stock" })] }));
    }
    await withLoading(listSlot, async () => {
      const list = await getList("/api/inventory/count-sessions").catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return section("Recent counts", el("p", { class: "view-sub" }, "No counts yet. Start one above."));
      return section(
        "Recent counts",
        dataTable(
          [
            { key: "created_at", label: "Started", render: (r) => formatDateTime(r.created_at || r.createdAt) },
            { key: "kind", label: "Kind" },
            { key: "status", label: "Status", render: (r) => chip(r.status || "open", statusVariant(r.status)) },
            { key: "open", label: "", render: (r) => button("Open", { onClick: () => navigate(`#/counts/${r.id}`) }) }
          ],
          rows
        )
      );
    });
  });
  async function renderSession(container, id) {
    container.append(viewHeader({ title: "Count session", subtitle: "Scan or add items, enter counts, then approve and close.", actions: [button("Back", { href: "#/counts" })] }));
    const slot = el("div");
    container.append(slot);
    async function refresh() {
      await withLoading(slot, async () => {
        const session = await getData(`/api/inventory/count-sessions/${id}`);
        const lines = await getData(`/api/inventory/count-sessions/${id}/lines`) || [];
        const blind = session.blind;
        const addVar = input({ name: "variationId", placeholder: "Variation id to add" });
        const wrap = el("div");
        wrap.append(
          section(
            `Session \u2014 ${session.status || "open"}`,
            el("div", { style: "display:flex;gap:8px;align-items:end;flex-wrap:wrap" }, [
              field("Add item", addVar),
              button("Add line", {
                onClick: async () => {
                  if (!addVar.value.trim()) return;
                  try {
                    await mutate(`/api/inventory/count-sessions/${id}/lines`, "POST", { variationId: addVar.value.trim() });
                    refresh();
                  } catch (e) {
                    toast(e.message, "err");
                  }
                }
              })
            ]),
            dataTable(
              [
                { key: "variationId", label: "Item", render: (l) => l.variationId || l.variation_id },
                { key: "counted", label: "Counted", num: true, render: (l) => countedCell(l, id, refresh) },
                { key: "variance", label: "Variance", num: true, render: (l) => blind ? chip("hidden (blind)", "low") : varianceCell(l) },
                { key: "approve", label: "", render: (l) => l.approved ? chip("approved", "ok") : button("Approve", { onClick: () => approve(l) }) }
              ],
              lines,
              { emptyMessage: "No lines yet \u2014 add or scan items." }
            )
          )
        );
        const signer = input({ name: "signedBy", placeholder: "Your name" });
        wrap.append(
          section(
            "Close out",
            field("Signed by", signer),
            button("Approve & close", {
              primary: true,
              onClick: async () => {
                if (!signer.value.trim()) return toast("Sign-off name required", "warn");
                try {
                  await mutate(`/api/inventory/count-sessions/${id}/close`, "POST", { signedBy: signer.value.trim() });
                  toast("Count closed and signed.");
                  navigate("#/counts");
                } catch (e) {
                  toast(e.message, "err");
                }
              }
            })
          )
        );
        return wrap;
        async function approve(l) {
          try {
            await mutate(`/api/inventory/count-sessions/${id}/lines/${l.id}`, "PATCH", { approved: true });
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      });
    }
    refresh();
  }
  function countedCell(l, id, refresh) {
    const val = l.countedQty ?? l.counted_qty;
    const inp = el("input", { type: "number", value: val ?? "", style: "width:90px", "aria-label": "Counted quantity" });
    inp.addEventListener("change", async () => {
      try {
        await mutate(`/api/inventory/count-sessions/${id}/lines/${l.id}`, "PATCH", { countedQty: Number(inp.value) });
        refresh();
      } catch (e) {
        toast(e.message, "err");
      }
    });
    return inp;
  }
  function varianceCell(l) {
    const v = l.variance ?? l.varianceQty;
    if (v === null || v === void 0) return "\u2014";
    return chip(v > 0 ? `+${v}` : String(v), v === 0 ? "ok" : "high");
  }
  function statusVariant(s) {
    return { open: "medium", review: "high", closed: "ok", abandoned: "low", paused: "low" }[s] || "low";
  }

  // apps/ui/public/js/views/transfers.js
  registerView("transfers", async (container, params) => {
    if (params[0]) return renderTransfer(container, params[0]);
    container.append(viewHeader({ title: "Transfers", subtitle: "Send stock from one location to another, then receive it." }));
    let locations = [];
    try {
      locations = await getData("/api/inventory/locations") || [];
    } catch {
    }
    if (locations.length < 2) {
      container.append(emptyState({ icon: "\u{1F501}", title: "Need at least two locations", message: "A transfer moves stock between two places. Add another location in Stock.", actions: [button("Go to Stock", { primary: true, href: "#/stock" })] }));
      return;
    }
    const from = select("from", locations.map((l) => ({ value: l.id, label: l.name })), locations[0].id);
    const to = select("to", locations.map((l) => ({ value: l.id, label: l.name })), locations[1].id);
    const varId = input({ name: "variationId", placeholder: "Variation id" });
    const qty = input({ name: "qty", type: "number", value: "1" });
    const lines = [];
    const lineSlot = el("div");
    const renderLines = () => {
      lineSlot.replaceChildren(dataTable([{ key: "variationId", label: "Item" }, { key: "qtySent", label: "Qty", num: true }], lines, { emptyMessage: "Add items to send." }));
    };
    renderLines();
    container.append(
      section(
        "New transfer",
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" }, [field("From", from), field("To", to)]),
        el("div", { style: "display:flex;gap:10px;flex-wrap:wrap;align-items:end" }, [
          field("Item", varId),
          field("Qty", qty),
          button("Add line", {
            onClick: () => {
              if (!varId.value.trim()) return;
              lines.push({ variationId: varId.value.trim(), qtySent: Number(qty.value) || 1 });
              varId.value = "";
              renderLines();
            }
          })
        ]),
        lineSlot,
        button("Create transfer", {
          primary: true,
          onClick: async () => {
            if (!lines.length) return toast("Add at least one item", "warn");
            if (from.value === to.value) return toast("From and To must differ", "warn");
            try {
              const res = await mutate("/api/inventory/transfers", "POST", { fromLocationId: from.value, toLocationId: to.value, lines });
              const t = res.data || res;
              navigate(`#/transfers/${t.id}`);
            } catch (e) {
              toast(e.message, "err");
            }
          }
        })
      )
    );
  });
  async function renderTransfer(container, id) {
    container.append(viewHeader({ title: "Transfer", subtitle: "Ship it, then receive each line \u2014 discrepancies are flagged.", actions: [button("Back", { href: "#/transfers" })] }));
    const slot = el("div");
    container.append(slot);
    async function refresh() {
      await withLoading(slot, async () => {
        const t = await getData(`/api/inventory/transfers/${id}`);
        const lines = t.lines || [];
        const wrap = el("div");
        wrap.append(
          section(
            `Status: ${t.status || "draft"}`,
            el("div", { class: "view-actions" }, [
              button("Ship", { primary: t.status === "draft", onClick: () => act("ship") })
            ]),
            dataTable(
              [
                { key: "variationId", label: "Item" },
                { key: "qtySent", label: "Sent", num: true, render: (l) => l.qtySent ?? l.qty_sent },
                { key: "qtyReceived", label: "Received", num: true, render: (l) => receiveCell(l) },
                { key: "disc", label: "Discrepancy", num: true, render: (l) => disc(l) }
              ],
              lines
            ),
            button("Receive entered quantities", { primary: true, onClick: receiveAll })
          )
        );
        return wrap;
        function receiveCell(l) {
          const inp = el("input", { type: "number", value: l.qtyReceived ?? "", style: "width:90px", "aria-label": "Received quantity" });
          inp.dataset.lineId = l.id;
          return inp;
        }
        async function receiveAll() {
          const receipts = Array.from(slot.querySelectorAll("input[data-line-id]")).map((i) => ({ lineId: i.dataset.lineId, qtyReceived: Number(i.value) })).filter((r) => Number.isFinite(r.qtyReceived));
          if (!receipts.length) return toast("Enter received quantities", "warn");
          try {
            await mutate(`/api/inventory/transfers/${id}/receive`, "POST", { receipts });
            toast("Received.");
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
        async function act(a) {
          try {
            await mutate(`/api/inventory/transfers/${id}/${a}`, "POST", {});
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      });
    }
    refresh();
  }
  function disc(l) {
    const sent = l.qtySent ?? l.qty_sent ?? 0;
    const rec = l.qtyReceived;
    if (rec === null || rec === void 0) return "\u2014";
    const d = rec - sent;
    return d === 0 ? chip("ok", "ok") : chip(d > 0 ? `+${d}` : String(d), "high");
  }

  // apps/ui/public/js/views/shows.js
  registerView("shows", async (container, params) => {
    if (params[0]) return renderShow(container, params[0]);
    container.append(viewHeader({ title: "Events", subtitle: "Plan club events, prepare stock, and reconcile each event." }));
    const createSlot = el("div");
    const listSlot = el("div");
    container.append(createSlot, listSlot);
    let venues = [];
    try {
      venues = (await getList("/api/shows/venues")).data || [];
    } catch {
    }
    createSlot.append(newShowCard(venues));
    await withLoading(listSlot, async () => {
      const list = await getList("/api/shows/shows", { limit: 100 }).catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: "\u{1F3AA}", title: "No events scheduled", message: "Add a venue and an event to prepare inventory and track event sales." });
      return section(
        "Events",
        dataTable(
          [
            { key: "name", label: "Event" },
            { key: "startsOn", label: "Starts", render: (r) => formatDate(r.startsOn || r.starts_on) },
            { key: "status", label: "Status", render: (r) => chip(r.status || "planned", "medium") },
            { key: "open", label: "", render: (r) => button("Open", { onClick: () => navigate(`#/shows/${r.id}`) }) }
          ],
          rows
        )
      );
    });
  });
  function newShowCard(venues) {
    if (!venues.length) {
      const vname = input({ name: "name", placeholder: "Venue name" });
      const vstate = input({ name: "state", placeholder: "State (e.g. GA)" });
      return section(
        "Add a venue first",
        field("Venue name", vname),
        field("State", vstate),
        button("Add venue", {
          primary: true,
          onClick: async () => {
            try {
              await mutate("/api/shows/venues", "POST", { name: vname.value.trim(), state: (vstate.value.trim() || "NA").slice(0, 2).toUpperCase() });
              toast("Venue added.");
              navigate("#/shows");
            } catch (e) {
              toast(e.message, "err");
            }
          }
        })
      );
    }
    const venue = select("venue", venues.map((v) => ({ value: v.id, label: v.name })), venues[0].id);
    const name = input({ name: "name", placeholder: "Event name" });
    const starts = input({ name: "startsOn", type: "date" });
    const ends = input({ name: "endsOn", type: "date" });
    return section(
      "Add an event",
      field("Venue", venue),
      field("Name", name),
      el("div", { style: "display:flex;gap:10px;flex-wrap:wrap" }, [field("Starts", starts), field("Ends", ends)]),
      button("Create event", {
        primary: true,
        onClick: async () => {
          if (!name.value.trim() || !starts.value) return toast("Name and start date required", "warn");
          try {
            const res = await mutate("/api/shows/shows", "POST", { venueId: venue.value, name: name.value.trim(), startsOn: starts.value, endsOn: ends.value || starts.value });
            const s = res.data || res;
            navigate(`#/shows/${s.id}`);
          } catch (e) {
            toast(e.message, "err");
          }
        }
      })
    );
  }
  async function renderShow(container, id) {
    container.append(viewHeader({ title: "Event", actions: [button("Back", { href: "#/shows" }), button("Print manifest", { onClick: () => window.print() })] }));
    const slot = el("div");
    container.append(slot);
    async function refresh() {
      await withLoading(slot, async () => {
        const show = await getData(`/api/shows/shows/${id}`);
        const wrap = el("div");
        wrap.append(
          section(
            show.name || "Show",
            detailList({
              Status: chip(show.status || "planned", "medium"),
              Starts: formatDate(show.startsOn || show.starts_on),
              Ends: formatDate(show.endsOn || show.ends_on),
              "Booth fee": show.boothFeeCents != null ? formatCents(show.boothFeeCents) : "\u2014"
            }),
            el("div", { class: "view-actions", style: "margin-top:10px" }, transitions(show, id, refresh))
          )
        );
        const manifests = (await getList(`/api/shows/shows/${id}/manifests`).catch(() => ({ data: [] }))).data || [];
        wrap.append(
          section(
            "Packing manifests",
            manifests.length ? dataTable([{ key: "id", label: "Manifest" }, { key: "status", label: "Status" }], manifests) : el("p", { class: "view-sub" }, "No manifest yet. Build one from a template on the Buying/Events workflow.")
          )
        );
        try {
          const pnl = await getData(`/api/shows/shows/${id}/pnl`);
          wrap.append(section("Show P&L", renderPnl(pnl)));
        } catch {
          wrap.append(section("Show P&L", el("div", { class: "blocked" }, "P&L is available after closeout inputs (sales, cash, fees, costs) are entered.")));
        }
        return wrap;
      });
    }
    refresh();
  }
  function transitions(show, id, refresh) {
    const flow = ["planned", "packing", "active", "returned", "closing", "closed"];
    const idx = flow.indexOf(show.status);
    const next = idx >= 0 && idx < flow.length - 1 ? flow[idx + 1] : null;
    const btns = [];
    if (next) {
      btns.push(button(`Advance to "${next}"`, {
        primary: true,
        onClick: async () => {
          try {
            await mutate(`/api/shows/shows/${id}/transition`, "POST", { to: next });
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      }));
    }
    return btns;
  }
  function renderPnl(pnl) {
    const missing = pnl.missingInputs || pnl.missing || [];
    const wrap = el("div");
    wrap.append(detailList({
      Revenue: pnl.revenueCents != null ? formatCents(pnl.revenueCents) : "unknown",
      "Gross margin": pnl.grossMarginCents != null ? formatCents(pnl.grossMarginCents) : "unknown",
      Units: pnl.units ?? "\u2014"
    }));
    if (missing.length) wrap.append(el("div", { class: "blocked" }, [el("strong", {}, "Missing inputs: "), missing.join(", ")]));
    return wrap;
  }

  // apps/ui/public/js/views/buying.js
  registerView("buying", async (container, params) => {
    if (params[0] === "po" && params[1]) return renderPo(container, params[1]);
    container.append(viewHeader({ title: "Buying", subtitle: "Vendors, reorder suggestions, and purchase orders \u2014 every quantity shows its formula." }));
    const tabs = el("div", { class: "view-actions", style: "margin-bottom:12px" });
    const slot = el("div");
    container.append(tabs, slot);
    const show = { vendors: () => loadVendors(slot), suggestions: () => loadSuggestions(slot), pos: () => loadPos(slot) };
    tabs.append(
      button("Vendors", { onClick: show.vendors }),
      button("Reorder suggestions", { onClick: show.suggestions }),
      button("Purchase orders", { onClick: show.pos })
    );
    show.vendors();
  });
  async function loadVendors(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/vendors/vendors", { limit: 100 }).catch(() => ({ data: [] }));
      const rows = list.data || [];
      const name = input({ name: "name", placeholder: "New vendor name" });
      const create = section(
        "Add a vendor",
        field("Name", name),
        button("Add vendor", {
          primary: true,
          onClick: async () => {
            if (!name.value.trim()) return;
            try {
              await mutate("/api/vendors/vendors", "POST", { name: name.value.trim() });
              toast("Vendor added.");
              loadVendors(slot);
            } catch (e) {
              toast(e.message, "err");
            }
          }
        })
      );
      const wrap = el("div");
      wrap.append(create);
      wrap.append(
        section(
          "Vendors",
          rows.length ? dataTable([{ key: "name", label: "Vendor" }, { key: "leadTimeDays", label: "Lead time (days)", num: true }], rows) : el("p", { class: "view-sub" }, "No vendors yet.")
        )
      );
      return wrap;
    });
  }
  async function loadSuggestions(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/purchasing/suggestions", { limit: 100 }).catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: "\u{1F6D2}", title: "No reorder suggestions", message: "Set reorder policies (in Stock) and run suggestions. Each suggestion prints the exact formula and inputs used." });
      return section(
        "Reorder suggestions",
        el("div", {}, rows.map((s) => el("div", { class: "card", style: "margin-bottom:10px" }, [
          el("div", { style: "display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px" }, [
            el("strong", {}, s.variationId || s.variation_id),
            chip(`Suggest ${s.suggestedQty ?? s.suggested_qty ?? "?"}`, "medium")
          ]),
          s.formula || s.inputs ? expandable("Why this quantity", el("pre", { style: "white-space:pre-wrap;margin:0" }, JSON.stringify(s.formula || s.inputs, null, 2))) : null,
          button("Accept into a PO", {
            onClick: async () => {
              const cost = prompt("Unit cost in cents?");
              if (!cost) return;
              try {
                await mutate(`/api/purchasing/suggestions/${s.id}/accept`, "POST", { unitCostCents: Number(cost) });
                toast("Added to a draft PO.");
                loadPos(slot);
              } catch (e) {
                toast(e.message, "err");
              }
            }
          })
        ])))
      );
    });
  }
  async function loadPos(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/purchasing/purchase-orders", { limit: 100 }).catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: "\u{1F9FE}", title: "No purchase orders", message: "Accept a reorder suggestion, or create a PO from a vendor, to get started." });
      return section(
        "Purchase orders",
        dataTable(
          [
            { key: "id", label: "PO" },
            { key: "status", label: "Status", render: (r) => chip(r.status || "draft", "medium") },
            { key: "totalCents", label: "Total", num: true, render: (r) => r.totalCents != null ? formatCents(r.totalCents) : "\u2014" },
            { key: "open", label: "", render: (r) => button("Open", { onClick: () => navigate(`#/buying/po/${r.id}`) }) }
          ],
          rows
        )
      );
    });
  }
  async function renderPo(container, id) {
    container.append(viewHeader({ title: "Purchase order", actions: [button("Back", { href: "#/buying" }), button("Print", { onClick: () => window.print() })] }));
    const slot = el("div");
    container.append(slot);
    async function refresh() {
      await withLoading(slot, async () => {
        const po = await getData(`/api/purchasing/purchase-orders/${id}`);
        const lines = po.lines || [];
        const wrap = el("div");
        wrap.append(
          section(
            `PO ${po.status || ""}`,
            detailList({ Vendor: po.vendorId, Total: po.totalCents != null ? formatCents(po.totalCents) : "\u2014" }),
            el("div", { class: "view-actions", style: "margin-top:8px" }, [
              po.status === "draft" ? button("Submit for approval", { onClick: () => act("submit") }) : null,
              po.status === "submitted" || po.status === "pending_approval" ? button("Approve", { primary: true, onClick: () => act("approve") }) : null,
              button("Receive all as ordered", { onClick: () => receiveAll(po) })
            ]),
            dataTable(
              [
                { key: "variationId", label: "Item" },
                { key: "qtyOrdered", label: "Ordered", num: true, render: (l) => l.qtyOrdered ?? l.qty_ordered },
                { key: "unitCostCents", label: "Unit cost", num: true, render: (l) => formatCents(l.unitCostCents ?? l.unit_cost_cents ?? 0) }
              ],
              lines
            )
          )
        );
        return wrap;
        async function act(a) {
          try {
            await mutate(`/api/purchasing/purchase-orders/${id}/${a}`, "POST", {});
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
        async function receiveAll(po2) {
          const receiptLines = (po2.lines || []).map((l) => ({ poLineId: l.id, qtyReceived: l.qtyOrdered ?? l.qty_ordered, condition: "ok", final: true }));
          if (!receiptLines.length) return toast("No lines to receive", "warn");
          try {
            await mutate(`/api/purchasing/purchase-orders/${id}/receipts`, "POST", { lines: receiptLines });
            toast("Received into stock.");
            refresh();
          } catch (e) {
            toast(e.message, "err");
          }
        }
      });
    }
    refresh();
  }

  // apps/ui/public/js/views/orders.js
  var REFUNDABLE_STATUSES = /* @__PURE__ */ new Set(["paid", "partially_fulfilled", "fulfilled", "partially_returned"]);
  var PAYABLE_STATUSES = /* @__PURE__ */ new Set(["draft", "reserved"]);
  registerView("orders", async (container, params) => {
    if (params[0]) return renderOrder(container, params[0]);
    container.append(
      viewHeader({
        title: "Orders",
        subtitle: "Every sale and return recorded by this system.",
        actions: [
          button("Open register", { primary: true, href: "#/register" }),
          button("Create manual draft", { onClick: createManualOrder })
        ]
      })
    );
    const filterStatus = select("status", [
      { value: "", label: "All statuses" },
      { value: "draft", label: "Draft" },
      { value: "reserved", label: "Reserved" },
      { value: "paid", label: "Paid" },
      { value: "partially_fulfilled", label: "Partially fulfilled" },
      { value: "fulfilled", label: "Fulfilled" },
      { value: "partially_returned", label: "Partially returned" },
      { value: "returned", label: "Returned" },
      { value: "canceled", label: "Canceled" }
    ], "");
    const slot = el("div");
    container.append(section("Filter", field("Status", filterStatus)), slot);
    filterStatus.addEventListener("change", load);
    load();
    async function load() {
      await withLoading(slot, async () => {
        const list = await getList("/api/orders/orders", {
          limit: 100,
          sort: "-created_at",
          status: filterStatus.value || void 0
        });
        const rows = list.data || [];
        if (!rows.length) {
          return emptyState({
            icon: "\u{1F9FE}",
            title: "No orders yet",
            message: filterStatus.value ? "No orders match this status." : "Start a sale in Register. Nothing is pre-filled.",
            actions: [button("Open register", { primary: true, href: "#/register" })]
          });
        }
        return dataTable([
          { key: "receipt_number", label: "Receipt", render: (row2) => row2.receipt_number || row2.receiptNumber || shortId(row2.id) },
          { key: "channel", label: "Channel" },
          { key: "status", label: "Status", render: (row2) => chip(statusLabel(row2.status), statusVariant2(row2.status)) },
          { key: "total_cents", label: "Total", num: true, render: (row2) => formatCents(centsOf(row2, "total")) },
          { key: "created_at", label: "Date", render: (row2) => formatDate(row2.created_at || row2.createdAt) },
          { key: "open", label: "", render: (row2) => button("Open", { onClick: () => navigate(`#/orders/${row2.id}`) }) }
        ], rows);
      });
    }
    async function createManualOrder() {
      try {
        const response = await mutate("/api/orders/orders", "POST", { channel: "manual", lines: [] });
        const order = response.data || response;
        navigate(`#/orders/${order.id}`);
      } catch (error) {
        toast(error.message, "err");
      }
    }
  });
  async function renderOrder(container, id) {
    const screen = el("div", { class: "print-hide" });
    const printableSlot = el("div");
    const slot = el("div");
    screen.append(
      viewHeader({
        title: "Order",
        actions: [button("Back", { href: "#/orders" }), button("Print receipt", { onClick: () => printReceipt() })]
      }),
      slot
    );
    container.append(screen, printableSlot);
    let printable = false;
    await refresh();
    async function refresh() {
      await withLoading(slot, async () => {
        let order = await getData(`/api/orders/orders/${id}`);
        let projection = null;
        const [tenders, refunds] = await Promise.all([
          getData(`/api/orders/orders/${id}/tenders`).catch(() => []),
          getData(`/api/orders/orders/${id}/refunds`).catch(() => [])
        ]);
        if (order.channel === "pos") {
          projection = await getData(`/api/pos/receipts/${id}`).catch(() => null);
          order = projection?.order || order;
        }
        printable = true;
        renderOrderReceipt(
          printableSlot,
          order,
          projection?.tenders || tenders || [],
          projection?.refunds || refunds || [],
          projection
        );
        return orderDetail(order, tenders || [], refunds || [], projection);
      });
    }
    function orderDetail(order, tenders, refunds, projection = null) {
      const wrap = el("div");
      const status = order.status || "draft";
      const availableTenders = refundableTenders(tenders, refunds);
      const hasPendingRefund = (refunds || []).some((refund) => refund.status === "pending");
      const actionBar = el("div", { class: "view-actions", style: "margin-top:12px" }, [
        status === "draft" ? button("Reserve stock", { onClick: () => transition("reserve") }) : null,
        PAYABLE_STATUSES.has(status) ? button("Cancel order", { danger: true, onClick: () => cancelOrder() }) : null,
        REFUNDABLE_STATUSES.has(status) ? button("Refund / return\u2026", { primary: true, disabled: !availableTenders.length, onClick: () => openRefundDialog(order, tenders, refunds) }) : null
      ]);
      wrap.append(
        section(
          `Order ${shortId(order.id)}`,
          detailList({
            Receipt: order.receipt_number || order.receiptNumber || shortId(order.id),
            Channel: order.channel,
            Status: chip(statusLabel(status), statusVariant2(status)),
            Cashier: projection?.cashier?.name || order.cashier_name || order.cashierName || order.cashier_id || order.cashierId || "Not assigned",
            Customer: order.customer_id || order.customerId || "Walk-up / anonymous",
            Created: formatDate(order.created_at || order.createdAt),
            Subtotal: formatCents(centsOf(order, "subtotal")),
            Discount: formatCents(centsOf(order, "discount")),
            Tax: formatCents(centsOf(order, "tax")),
            Total: formatCents(centsOf(order, "total"))
          }),
          actionBar,
          REFUNDABLE_STATUSES.has(status) && !availableTenders.length ? el("p", { class: "view-sub", style: "margin-top:10px" }, hasPendingRefund ? "A processor refund is pending confirmation. This tender cannot be refunded again until it completes or fails." : "No captured tender has a refundable balance.") : null
        ),
        section(
          "Items",
          dataTable([
            { key: "description", label: "Item" },
            { key: "qty", label: "Qty", num: true },
            { key: "returned_qty", label: "Returned", num: true, render: (line) => String(returnedQty(line)) },
            { key: "pending_return_qty", label: "Pending", num: true, render: (line) => String(pendingReturnQty(line)) },
            { key: "returnable_qty", label: "Returnable", num: true, render: (line) => String(returnableQty(line)) },
            { key: "unit_price_cents", label: "Unit", num: true, render: (line) => formatCents(centsOf(line, "unit_price")) },
            { key: "line_total_cents", label: "Total", num: true, render: (line) => formatCents(lineTotal(line)) },
            { key: "fulfillment_state", label: "State", render: (line) => statusLabel(line.fulfillment_state || line.fulfillmentState || "pending") }
          ], order.lines || [], { emptyMessage: "No lines on this order." })
        ),
        section(
          "Payments",
          dataTable([
            { key: "kind", label: "Tender", render: (tender) => statusLabel(tender.kind) },
            { key: "provider_ref", label: "Reference", render: (tender) => tender.provider_ref || tender.providerRef || "\u2014" },
            { key: "amount_cents", label: "Captured", num: true, render: (tender) => formatCents(centsOf(tender, "amount")) },
            { key: "cash_received_cents", label: "Cash received", num: true, render: (tender) => tender.kind === "cash" ? formatCents(centsOf(tender, "cash_received")) : "\u2014" },
            { key: "change_due_cents", label: "Change", num: true, render: (tender) => tender.kind === "cash" ? formatCents(centsOf(tender, "change_due")) : "\u2014" },
            { key: "refunded_cents", label: "Refunded", num: true, render: (tender) => formatCents(centsOf(tender, "refunded")) },
            { key: "status", label: "Status", render: (tender) => chip(statusLabel(tender.status), statusVariant2(tender.status)) }
          ], tenders, { emptyMessage: "No tenders recorded." })
        ),
        section(
          "Refunds",
          dataTable([
            { key: "id", label: "Refund", render: (refund) => shortId(refund.id) },
            { key: "amount_cents", label: "Amount", num: true, render: (refund) => formatCents(centsOf(refund, "amount")) },
            { key: "reason", label: "Reason", render: (refund) => refund.reason || "\u2014" },
            { key: "status", label: "Status", render: (refund) => chip(statusLabel(refund.status), statusVariant2(refund.status)) },
            { key: "created_at", label: "Date", render: (refund) => formatDate(refund.created_at || refund.createdAt) }
          ], refunds, { emptyMessage: "No refunds recorded." })
        )
      );
      return wrap;
    }
    async function transition(action) {
      try {
        await mutate(`/api/orders/orders/${id}/${action}`, "POST", {});
        toast(action === "reserve" ? "Stock reserved." : "Order updated.");
        await refresh();
      } catch (error) {
        toast(error.message, "err");
      }
    }
    function cancelOrder() {
      const dialog = dialogShell2("Cancel unpaid order");
      dialog.setAttribute("aria-label", "Cancel unpaid order");
      const keep = button("Keep order", { onClick: () => dialog.close() });
      const cancel = button("Cancel order", {
        danger: true,
        onClick: async () => {
          cancel.disabled = true;
          try {
            await mutate(`/api/orders/orders/${id}/cancel`, "POST", {});
            toast("Order canceled.");
            dialog.close();
            await refresh();
          } catch (error) {
            cancel.disabled = false;
            toast(error.message, "err");
          }
        }
      });
      dialog.append(
        el("p", { class: "view-sub" }, "This releases any reservation and leaves the unpaid order canceled."),
        el("div", { class: "view-actions" }, [keep, cancel])
      );
      openDialog2(dialog, keep);
    }
    function openRefundDialog(order, tenders, refunds) {
      const available = refundableTenders(tenders, refunds);
      if (!available.length) return toast("No tender is currently available for a refund.", "warn");
      const refundIdempotencyKey = newIdempotencyKey();
      const dialog = dialogShell2("Refund / return");
      const tenderSelect = select("tenderId", available.map((tender) => ({
        value: tender.id,
        label: `${statusLabel(tender.kind)} \xB7 ${formatCents(refundableCents(tender))} available${tender.provider_ref ? ` \xB7 ${tender.provider_ref}` : ""}`
      })), available[0].id);
      const amount = input({ name: "refundAmount", value: moneyInput(refundableCents(available[0])), required: true });
      amount.setAttribute("inputmode", "decimal");
      const reason = input({ name: "reason", placeholder: "Reason for return (optional)" });
      const lineControls = el("div");
      dialog.append(
        el("p", { class: "view-sub" }, "Select at least one returned line and choose an inventory disposition. Processor-backed tenders are refunded through their original provider; manually recorded external tenders must also be returned in that source system."),
        field("Refund from tender", tenderSelect),
        field("Refund amount $", amount),
        field("Reason", reason),
        el("h3", {}, "Returned items"),
        lineControls,
        el("div", { class: "view-actions", style: "margin-top:16px" }, [
          button("Cancel", { onClick: () => dialog.close() }),
          button("Submit refund", { danger: true, big: true, onClick: submitRefund })
        ])
      );
      tenderSelect.addEventListener("change", () => {
        const tender = available.find((row2) => row2.id === tenderSelect.value);
        if (tender) amount.value = moneyInput(refundableCents(tender));
      });
      paintLines();
      openDialog2(dialog, tenderSelect);
      function paintLines() {
        clear(lineControls);
        const lines = (order.lines || []).filter((line) => returnableQty(line) > 0);
        if (!lines.length) {
          lineControls.append(el("p", { class: "view-sub" }, "No returnable lines remain."));
          return;
        }
        for (const line of lines) {
          const remainingQty = returnableQty(line);
          const checkbox = el("input", { type: "checkbox", name: "returnLine", value: line.id, "aria-label": `Return ${line.description}` });
          checkbox.style.width = "44px";
          const qty = input({ name: `qty_${line.id}`, type: "number", value: String(remainingQty), min: 1 });
          qty.setAttribute("max", String(remainingQty));
          qty.disabled = true;
          const disposition = select(`disposition_${line.id}`, [
            { value: "none", label: "Do not restock" },
            { value: "restock", label: "Return to stock" },
            { value: "quarantine", label: "Quarantine" },
            { value: "damaged", label: "Damaged" }
          ], "none");
          disposition.disabled = true;
          checkbox.addEventListener("change", () => {
            qty.disabled = !checkbox.checked;
            disposition.disabled = !checkbox.checked;
          });
          lineControls.append(el("div", { class: "card", style: "box-shadow:none;margin:8px 0;padding:12px;display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;align-items:center" }, [
            checkbox,
            el("div", {}, [
              el("strong", {}, line.description),
              el("div", { style: "display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin-top:8px" }, [
                field(`Quantity (max ${remainingQty})`, qty),
                field("Disposition", disposition)
              ])
            ])
          ]));
        }
      }
      async function submitRefund() {
        try {
          const tender = available.find((row2) => row2.id === tenderSelect.value);
          if (!tender) throw new Error("Choose a refundable tender");
          let cashSessionId;
          if (tender.kind === "cash") {
            const registerState = deserializeRegisterState(localStorage.getItem(REGISTER_STORAGE_KEY));
            if (!registerState.drawerRef || !registerState.cashSessionId) {
              throw new Error("Open a cash drawer shift before recording a cash refund.");
            }
            const currentDrawer = await getData("/api/pos/drawer", { drawerRef: registerState.drawerRef });
            if (currentDrawer?.session?.status !== "open" || currentDrawer.session.id !== registerState.cashSessionId) {
              throw new Error("The saved cash drawer shift is no longer open. Return to Register and reopen the drawer.");
            }
            cashSessionId = registerState.cashSessionId;
          }
          const amountCents = parseMoneyToCents(amount.value);
          if (amountCents <= 0) throw new Error("Refund amount must be greater than $0");
          if (amountCents > refundableCents(tender)) throw new Error("Refund amount exceeds this tender\u2019s remaining balance");
          const lines = Array.from(lineControls.querySelectorAll('input[name="returnLine"]:checked')).map((checkbox) => {
            const source = (order.lines || []).find((line) => line.id === checkbox.value);
            const qtyControl = lineControls.querySelector(`[name="qty_${cssEscape(checkbox.value)}"]`);
            const dispositionControl = lineControls.querySelector(`[name="disposition_${cssEscape(checkbox.value)}"]`);
            const qty = Number(qtyControl?.value);
            if (!source || !Number.isFinite(qty) || qty <= 0 || qty > returnableQty(source)) throw new Error(`Enter a valid return quantity for ${source?.description || "the selected line"}`);
            return { lineId: checkbox.value, qty, disposition: dispositionControl?.value || "none" };
          });
          if (!lines.length) throw new Error("Select at least one returned line");
          const refundEndpoint = order.channel === "pos" ? `/api/pos/orders/${id}/refunds` : `/api/orders/orders/${id}/refunds`;
          const response = await mutate(refundEndpoint, "POST", {
            tenderId: tender.id,
            idempotencyKey: refundIdempotencyKey,
            ...tender.kind === "cash" ? { cashSessionId } : {},
            amountCents,
            reason: reason.value.trim() || void 0,
            lines
          });
          const refund = response?.data?.refund;
          const pending = refund?.status === "pending";
          dialog.close();
          toast(pending ? `Refund of ${formatCents(amountCents)} submitted; processor confirmation is pending.` : `Refund of ${formatCents(amountCents)} completed.`);
          announce(pending ? "Refund submitted and pending" : "Refund completed");
          await refresh();
        } catch (error) {
          toast(error.message, "err", 6e3);
        }
      }
    }
    function printReceipt() {
      if (!printable) return toast("Receipt is still loading.", "warn");
      document.body.dataset.print = "receipt";
      window.print();
    }
  }
  function refundableTenders(tenders, refunds = []) {
    const pendingTenderIds = new Set(
      refunds.filter((refund) => refund.status === "pending").map((refund) => refund.tender_id || refund.tenderId)
    );
    return (tenders || []).filter(
      (tender) => ["captured", "partially_refunded"].includes(tender.status) && refundableCents(tender) > 0 && !pendingTenderIds.has(tender.id)
    );
  }
  function returnedQty(line) {
    const explicit = line?.returned_qty ?? line?.returnedQty;
    if (Number.isFinite(explicit)) return Math.max(0, Number(explicit));
    return (line?.fulfillment_state || line?.fulfillmentState) === "returned" ? Math.max(0, Number(line?.qty) || 0) : 0;
  }
  function pendingReturnQty(line) {
    const explicit = line?.pending_return_qty ?? line?.pendingReturnQty;
    return Number.isFinite(explicit) ? Math.max(0, Number(explicit)) : 0;
  }
  function returnableQty(line) {
    const explicit = line?.returnable_qty ?? line?.returnableQty;
    if (Number.isFinite(explicit)) return Math.max(0, Number(explicit));
    return Math.max(0, (Number(line?.qty) || 0) - returnedQty(line) - pendingReturnQty(line));
  }
  function refundableCents(tender) {
    return Math.max(0, centsOf(tender, "amount") - centsOf(tender, "refunded"));
  }
  function lineTotal(line) {
    const stored = line.line_total_cents ?? line.lineTotalCents;
    return Number.isSafeInteger(stored) ? stored : Math.round((Number(line.qty) || 0) * centsOf(line, "unit_price"));
  }
  function centsOf(row2, stem) {
    const value = row2?.[`${stem}_cents`] ?? row2?.[`${stem}Cents`] ?? 0;
    return Number.isSafeInteger(value) ? value : 0;
  }
  function shortId(value) {
    const id = String(value || "");
    return id.length > 12 ? `${id.slice(0, 8)}\u2026` : id || "\u2014";
  }
  function statusLabel(value) {
    return String(value || "unknown").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  function statusVariant2(status) {
    if (["paid", "fulfilled", "completed", "captured"].includes(status)) return "ok";
    if (["canceled", "failed", "voided"].includes(status)) return "critical";
    if (["reserved", "partially_fulfilled", "partially_returned", "partially_refunded"].includes(status)) return "high";
    return "medium";
  }
  function moneyInput(cents) {
    return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
  }
  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }
  function dialogShell2(title) {
    return el("dialog", {
      "aria-label": title,
      style: "width:min(680px,calc(100vw - 24px));max-height:calc(100vh - 24px);overflow:auto;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);color:var(--text);padding:20px;box-shadow:var(--shadow)"
    }, el("h2", {}, title));
  }
  function openDialog2(dialog, focusTarget) {
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    setTimeout(() => focusTarget?.focus(), 0);
  }
  function renderOrderReceipt(slot, order, tenders, refunds, projection = null) {
    clear(slot);
    const refundTotal = refunds.filter((refund) => refund.status === "completed").reduce((sum, refund) => sum + centsOf(refund, "amount"), 0);
    slot.append(el("article", { class: "printable", "aria-label": `Receipt for order ${order.id}` }, [
      clubBrand("receipt-brand"),
      el("h1", {}, projection?.merchant?.name || "Receipt"),
      projection?.merchant?.name ? el("h2", {}, "Receipt") : null,
      el("p", {}, `Receipt ${order.receipt_number || order.receiptNumber || order.id}`),
      el("p", {}, new Date(order.paid_at || order.paidAt || order.created_at || order.createdAt || Date.now()).toLocaleString()),
      projection?.cashier?.name ? el("p", {}, `Cashier: ${projection.cashier.name}`) : null,
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Item"), el("th", {}, "Qty"), el("th", {}, "Amount")])),
        el("tbody", {}, (order.lines || []).map((line) => el("tr", {}, [
          el("td", {}, line.description || "Item"),
          el("td", {}, returnedQty(line) > 0 || pendingReturnQty(line) > 0 ? `${line.qty} (${returnedQty(line)} returned, ${pendingReturnQty(line)} pending, ${returnableQty(line)} remaining)` : String(line.qty)),
          el("td", {}, formatCents(lineTotal(line)))
        ])))
      ]),
      receiptRow("Subtotal", centsOf(order, "subtotal")),
      receiptRow("Discount", -centsOf(order, "discount")),
      receiptRow("Tax", centsOf(order, "tax")),
      receiptRow("Total", centsOf(order, "total"), true),
      ...tenders.flatMap((tender) => {
        const rows = [receiptRow(tender.kind === "provider" || tender.kind === "card" ? "Card" : `${statusLabel(tender.kind)} tender`, centsOf(tender, "amount"))];
        if (tender.kind === "cash") {
          rows.push(receiptRow("Cash received", centsOf(tender, "cash_received")));
          rows.push(receiptRow("Change due", centsOf(tender, "change_due"), true));
        }
        return rows;
      }),
      refundTotal ? receiptRow("Refunded", -refundTotal, true) : null,
      projection?.merchant?.receiptFooter ? el("p", { style: "margin-top:16px" }, projection.merchant.receiptFooter) : null
    ]));
  }
  function receiptRow(label2, cents, strong = false) {
    return el("div", { style: `display:flex;justify-content:space-between;gap:20px;padding-top:4px;${strong ? "font-weight:800;border-top:1px solid #000;margin-top:4px" : ""}` }, [
      el("span", {}, label2),
      el("span", {}, formatCents(cents))
    ]);
  }

  // apps/ui/public/js/views/customers.js
  registerView("customers", async (container, params) => {
    if (params[0]) return renderProfile(container, params[0]);
    container.append(viewHeader({ title: "Guests", subtitle: "Find a guest and review their purchase history and preferences." }));
    const q = input({ name: "q", placeholder: "Search name, email, or phone" });
    const slot = el("div");
    container.append(section("Search", field("Search", q), button("Search", { primary: true, onClick: search })), slot);
    q.addEventListener("keydown", (e) => {
      if (e.key === "Enter") search();
    });
    async function search() {
      await withLoading(slot, async () => {
        const term = q.value.trim();
        const query = { limit: 50 };
        if (term.includes("@")) query.email = term;
        else if (/^[0-9+()\-\s]+$/.test(term) && term) query.phone = term;
        else if (term) query.name = term;
        const list = await getList("/api/customers/profiles", query);
        const rows = list.data || [];
        if (!rows.length) return emptyState({ icon: "\u{1F464}", title: term ? "No matches" : "Search to begin", message: term ? "No guest matches that. Try an email or phone." : "Type a name, email, or phone and press Search." });
        return dataTable(
          [
            { key: "name", label: "Name", render: (r) => `${r.first_name || r.firstName || ""} ${r.last_name || r.lastName || ""}`.trim() || "\u2014" },
            { key: "email", label: "Email" },
            { key: "phone", label: "Phone" },
            { key: "open", label: "", render: (r) => button("Open", { onClick: () => navigate(`#/customers/${r.id}`) }) }
          ],
          rows
        );
      });
    }
    const segSlot = el("div");
    container.append(segSlot);
    try {
      const segs = await getData("/api/customers/segments") || [];
      if (Array.isArray(segs) && segs.length) {
        segSlot.append(section("Segments", dataTable([{ key: "name", label: "Segment" }, { key: "count", label: "Members", num: true, render: (s) => s.memberCount ?? s.count ?? "\u2014" }], segs)));
      }
    } catch {
    }
  });
  async function renderProfile(container, id) {
    container.append(viewHeader({ title: "Guest", actions: [button("Back", { href: "#/customers" })] }));
    const slot = el("div");
    container.append(slot);
    await withLoading(slot, async () => {
      const p = await getData(`/api/customers/profiles/${id}`);
      const wrap = el("div");
      wrap.append(
        section(
          `${p.first_name || ""} ${p.last_name || ""}`.trim() || "Guest",
          detailList({ Email: p.email || "\u2014", Phone: p.phone || "\u2014", Source: p.source || "\u2014" })
        )
      );
      try {
        const consents = await getData(`/api/customers/profiles/${id}/consents`) || [];
        wrap.append(section("Consents", Array.isArray(consents) && consents.length ? dataTable([{ key: "channel", label: "Channel" }, { key: "state", label: "State", render: (c) => chip(c.state, c.state === "granted" ? "ok" : "low") }], consents) : el("p", { class: "view-sub" }, "No consent on file \u2014 cannot send marketing to this customer.")));
      } catch {
      }
      try {
        const rr = (await getList(`/api/customers/restock-requests`, {}).catch(() => ({ data: [] }))).data || [];
        const mine = rr.filter((r) => (r.profile_id || r.profileId) === id);
        if (mine.length) wrap.append(section("Restock requests", dataTable([{ key: "variation_id", label: "Item" }, { key: "status", label: "Status" }], mine)));
      } catch {
      }
      return wrap;
    });
  }

  // apps/ui/public/js/views/marketing.js
  registerView("marketing", async (container) => {
    container.append(viewHeader({ title: "Marketing", subtitle: "Send notes and offers to customers who gave you their email. Starts fully off." }));
    const gateSlot = el("div");
    const bodySlot = el("div");
    container.append(gateSlot, bodySlot);
    await withLoading(gateSlot, async () => {
      let report;
      try {
        report = await getData("/api/outreach/settings/gates");
      } catch (e) {
        return blockedBanner("Email is not configured yet.", [e.message]);
      }
      const phrased = phraseReport(report);
      const wrap = el("div", { class: "card" });
      wrap.append(el("h2", {}, phrased.allOpen ? "\u2705 Ready to send" : `Setup \u2014 ${phrased.blockedCount} step(s) left`));
      const ul = el("ul", { class: "setup-list" });
      for (const g of phrased.gates) {
        ul.append(el("li", {}, [
          el("span", { class: `status ${g.open ? "done" : "todo"}` }, g.open ? "\u2713" : "\u25CB"),
          el("span", {}, [el("strong", {}, g.label), g.reason ? el("div", { class: "hint" }, g.reason) : null])
        ]));
      }
      wrap.append(ul);
      return wrap;
    });
    const tabs = el("div", { class: "view-actions", style: "margin:16px 0" });
    container.append(tabs);
    container.append(bodySlot);
    tabs.append(
      button("Templates", { onClick: () => loadTemplates(bodySlot) }),
      button("Campaigns", { onClick: () => loadCampaigns(bodySlot) }),
      button("Inbox", { onClick: () => loadInbox(bodySlot) }),
      button("Check replies", { onClick: async () => {
        try {
          await mutate("/api/outreach/check-replies", "POST", {});
          toast("Checked for replies.");
        } catch (e) {
          toast(e.message, "err");
        }
      } })
    );
    loadTemplates(bodySlot);
  });
  async function loadTemplates(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/outreach/templates").catch(() => ({ data: [] }));
      const rows = list.data || [];
      const name = input({ name: "name", placeholder: "Template name" });
      const subject = input({ name: "subject", placeholder: "Subject (use {{placeholders}})" });
      const bodyT = el("textarea", { name: "body", placeholder: "Message body. Placeholders like {{first_name}}." });
      const wrap = el("div");
      wrap.append(section(
        "New template",
        field("Name", name),
        field("Subject", subject),
        field("Body", bodyT),
        button("Save template", {
          primary: true,
          onClick: async () => {
            const required = [...`${subject.value} ${bodyT.value}`.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1]);
            try {
              await mutate("/api/outreach/templates", "POST", { name: name.value.trim(), kind: "promotional", subjectTemplate: subject.value, bodyTemplate: bodyT.value, requiredPlaceholders: [...new Set(required)] });
              toast("Template saved. Placeholders detected: " + (required.length ? required.join(", ") : "none"));
              loadTemplates(slot);
            } catch (e) {
              toast(e.message, "err");
            }
          }
        })
      ));
      wrap.append(section("Templates", rows.length ? dataTable([{ key: "name", label: "Name" }, { key: "kind", label: "Kind" }], rows) : el("p", { class: "view-sub" }, "No templates yet.")));
      return wrap;
    });
  }
  async function loadCampaigns(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/outreach/campaigns").catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: "\u2709\uFE0F", title: "No campaigns", message: "Create a template, then build a campaign from a customer segment. Nothing sends until every gate above is green and you approve it." });
      return section("Campaigns", dataTable(
        [
          { key: "name", label: "Campaign" },
          { key: "status", label: "Status", render: (r) => chip(r.status || "draft", "medium") },
          { key: "act", label: "", render: (r) => el("span", {}, [
            button("Approve", { onClick: () => campaignAct(r.id, "approve", slot) }),
            button("Send pending", { onClick: async () => {
              try {
                await mutate("/api/outreach/send-pending", "POST", {});
                toast("Processed pending sends.");
              } catch (e) {
                toast(e.message, "err");
              }
            } })
          ]) }
        ],
        rows
      ));
    });
  }
  async function campaignAct(id, action, slot) {
    try {
      await mutate(`/api/outreach/campaigns/${id}/${action}`, "POST", {});
      toast("Done.");
      loadCampaigns(slot);
    } catch (e) {
      toast(e.message, "err");
    }
  }
  async function loadInbox(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/outreach/inbox").catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return emptyState({ icon: "\u{1F4E5}", title: "Inbox empty", message: 'Replies from customers appear here after you press "Check replies".' });
      return section("Inbox", dataTable([{ key: "from", label: "From" }, { key: "subject", label: "Subject" }], rows));
    });
  }

  // apps/ui/public/js/views/money.js
  function currentPeriod() {
    const d = /* @__PURE__ */ new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  registerView("money", async (container) => {
    container.append(viewHeader({ title: "Money", subtitle: "Sales, refunds, fees, payouts, and cash \u2014 every number defined and drillable." }));
    const posSlot = el("div");
    container.append(posSlot);
    await loadPosLedger(posSlot);
    const period = input({ name: "period", value: currentPeriod(), placeholder: "YYYY-MM" });
    const tilesSlot = el("div", { style: "margin:12px 0" });
    container.append(section("Period", field("Month (YYYY-MM)", period), button("Load", { primary: true, onClick: loadPeriod })), tilesSlot);
    period.addEventListener("change", loadPeriod);
    async function loadPeriod() {
      await withLoading(tilesSlot, async () => {
        let sum;
        try {
          sum = await getData("/api/finance/period-summary", { period: period.value.trim() });
        } catch (e) {
          return emptyState({ icon: "\u{1F4B5}", title: "No finance data for this period", message: e.message || "Import payments/payouts under Imports, then reload." });
        }
        const grid = el("div", { class: "grid tiles" });
        const tile = (label2, cents, def) => grid.append(metricTile({ label: label2, value: cents == null ? "unknown" : formatCents(cents), definition: def, foot: `Period ${period.value}` }));
        tile("Gross sales", sum.grossCents ?? sum.gross_cents, "Total completed payments before refunds and fees.");
        tile("Refunds", sum.refundsCents ?? sum.refunds_cents, "Money returned to customers this period.");
        tile("Fees", sum.feesCents ?? sum.fees_cents, "Processor fees on payments.");
        tile("Net", sum.netCents ?? sum.net_cents, "Gross minus refunds minus fees.");
        return grid;
      });
    }
    loadPeriod();
    const payoutSlot = el("div");
    container.append(payoutSlot);
    await withLoading(payoutSlot, async () => {
      const list = await getList("/api/finance/payout-matches").catch(() => ({ data: [] }));
      const rows = list.data || [];
      if (!rows.length) return section("Payouts", el("p", { class: "view-sub" }, "No payouts reconciled yet."));
      return section("Payout reconciliation", dataTable(
        [
          { key: "sourcePayoutId", label: "Payout" },
          { key: "status", label: "Status", render: (r) => chip(r.status || "\u2014", r.matched ? "ok" : "high") },
          { key: "deltaCents", label: "Delta", num: true, render: (r) => r.deltaCents != null ? formatCents(r.deltaCents) : "\u2014" }
        ],
        rows
      ));
    });
    container.append(section(
      "Accountant exports",
      el("div", { class: "view-actions" }, ["payments", "refunds", "payouts", "cash-sessions", "tax-evidence", "item-costs"].map(
        (k) => el("a", { class: "btn", href: `/api/finance/exports/${k}.csv`, download: `${k}.csv` }, `${k}.csv`)
      ))
    ));
    const cashSlot = el("div");
    container.append(cashSlot);
    await withLoading(cashSlot, async () => {
      const list = await getList("/api/finance/cash-sessions").catch(() => ({ data: [] }));
      const rows = list.data || [];
      return section("Cash sessions", rows.length ? dataTable([
        { key: "drawer_ref", label: "Drawer", render: (row2) => row2.drawer_ref || row2.drawerRef || row2.location_ref || row2.locationRef || shortRef(row2.id) },
        { key: "opened_at", label: "Opened", render: (row2) => formatDateTime(row2.opened_at || row2.openedAt) },
        { key: "status", label: "Status", render: (row2) => chip(humanize(row2.status), row2.status === "closed" ? "ok" : "low") },
        { key: "expected_cents", label: "Expected", num: true, render: (row2) => moneyOrDash(row2.expected_cents ?? row2.expectedCents) },
        { key: "counted_cents", label: "Counted", num: true, render: (row2) => moneyOrDash(row2.counted_cents ?? row2.countedCents) },
        { key: "variance_cents", label: "Variance", num: true, render: (row2) => moneyOrDash(row2.variance_cents ?? row2.varianceCents) }
      ], rows) : el("p", { class: "view-sub" }, "No cash sessions. Open one at the start of a show or register day."));
    });
  });
  async function loadPosLedger(slot) {
    await withLoading(slot, async () => {
      let summary;
      let entries;
      try {
        [summary, entries] = await Promise.all([
          getData("/api/pos/finance/summary"),
          getList("/api/pos/finance/entries", { limit: 50 })
        ]);
      } catch (error) {
        return section(
          "Register ledger",
          emptyState({
            icon: "\u{1F9FE}",
            title: "Register ledger unavailable",
            message: error.message || "Sign in as a manager or owner to view POS finance."
          })
        );
      }
      const grid = el("div", { class: "grid tiles" }, [
        metricTile({
          label: "Register sales",
          value: formatCents(summary.grossTenderedSalesCents ?? 0),
          definition: "Captured POS tenders before completed refunds and processor fees.",
          foot: `${summary.paymentCount ?? 0} captured tender${summary.paymentCount === 1 ? "" : "s"}`
        }),
        metricTile({
          label: "Completed refunds",
          value: formatCents(summary.completedRefundsCents ?? 0),
          definition: "Only POS refunds with a completed authoritative status.",
          foot: `${summary.refundCount ?? 0} completed refund${summary.refundCount === 1 ? "" : "s"}`
        }),
        metricTile({
          label: "Net before fees",
          value: formatCents(summary.netSalesBeforeFeesCents ?? 0),
          definition: "Captured register tenders minus completed register refunds; processor fees are excluded.",
          foot: "Native POS ledger"
        }),
        metricTile({
          label: "Processor fees",
          value: summary.processorFeesCents == null ? "unknown" : formatCents(summary.processorFeesCents),
          definition: "Processor fees remain unknown until settlement data is connected.",
          foot: `${summary.unknownFeeEntryCount ?? 0} entr${summary.unknownFeeEntryCount === 1 ? "y" : "ies"} without fee data`
        }),
        metricTile({
          label: "Settlement net",
          value: summary.settlementNetCents == null ? "unknown" : formatCents(summary.settlementNetCents),
          definition: "Provider payout net after fees; never inferred from gross tender activity.",
          foot: summary.settlementNetCents == null ? "Connect settlement evidence" : "Provider-backed"
        })
      ]);
      const pending = Number(summary.pendingReconciliationCount ?? 0);
      const rows = Array.isArray(entries?.data) ? entries.data : [];
      return section(
        "Register ledger",
        el("p", { class: "view-sub" }, "Native POS sales and completed refunds. Historical imports and provider payouts remain in the period and payout sections below."),
        grid,
        el("p", { class: "view-sub", style: "margin-top:12px" }, [
          chip(pending === 0 ? "Reconciled" : `${pending} pending repair${pending === 1 ? "" : "s"}`, pending === 0 ? "ok" : "high"),
          el("span", { style: "margin-left:8px" }, "Stock, cash drawer, and finance projections are derived from durable order facts.")
        ]),
        dataTable([
          { key: "occurred_at", label: "When", render: (row2) => formatDateTime(row2.occurred_at) },
          { key: "entry_type", label: "Entry", render: (row2) => chip(humanize(row2.entry_type), row2.entry_type === "refund" ? "high" : "ok") },
          { key: "tender_kind", label: "Tender", render: (row2) => humanize(row2.tender_kind) },
          {
            key: "amount_cents",
            label: "Amount",
            num: true,
            render: (row2) => formatCents((row2.entry_type === "refund" ? -1 : 1) * Number(row2.amount_cents ?? 0))
          },
          { key: "fee_cents", label: "Fee", num: true, render: (row2) => row2.fee_cents == null ? "unknown" : formatCents(row2.fee_cents) },
          {
            key: "order_id",
            label: "Order",
            render: (row2) => el("a", { href: `#/orders/${row2.order_id}` }, row2.receipt_number || shortRef(row2.order_id))
          },
          { key: "cashier_id", label: "Cashier", render: (row2) => row2.cashier_name || shortRef(row2.cashier_id) }
        ], rows, { emptyMessage: "No completed register tenders or refunds yet." })
      );
    });
  }
  function humanize(value) {
    return String(value || "\u2014").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  function shortRef(value) {
    const text = String(value || "\u2014");
    return text.length > 12 ? `${text.slice(0, 8)}\u2026` : text;
  }
  function moneyOrDash(value) {
    return value === null || value === void 0 ? "\u2014" : formatCents(Number(value));
  }

  // apps/ui/public/js/views/team.js
  registerView("team", async (container) => {
    container.append(viewHeader({ title: "Team", subtitle: "Roles, who can do what, invitations, and schedules." }));
    const tabs = el("div", { class: "view-actions", style: "margin-bottom:12px" });
    const slot = el("div");
    container.append(tabs, slot);
    tabs.append(
      button("Roles", { onClick: () => loadRoles(slot) }),
      button("Invitations", { onClick: () => loadInvites(slot) }),
      button("Schedules", { onClick: () => loadSchedules(slot) })
    );
    loadRoles(slot);
  });
  async function loadRoles(slot) {
    await withLoading(slot, async () => {
      const roles = await getData("/api/workforce/roles") || [];
      if (!Array.isArray(roles) || !roles.length) return emptyState({ icon: "\u{1F9D1}\u200D\u{1F91D}\u200D\u{1F9D1}", title: "No roles yet", message: "Built-in roles (owner, manager, cashier\u2026) seed on setup. Add custom roles here." });
      const wrap = el("div");
      for (const role of roles) {
        let perms = [];
        try {
          perms = await getData(`/api/workforce/roles/${role.id}/permissions`) || [];
        } catch {
        }
        wrap.append(section(role.name || role.key, el("div", {}, (Array.isArray(perms) ? perms : []).map((p) => chip(typeof p === "string" ? p : p.permission, "low")))));
      }
      return wrap;
    });
  }
  async function loadInvites(slot) {
    await withLoading(slot, async () => {
      const roles = await getData("/api/workforce/roles").catch(() => []) || [];
      const email = input({ name: "email", type: "email", placeholder: "person@example.com" });
      const roleSel = select("role", roles.map((r) => ({ value: r.id, label: r.name || r.key })), roles[0]?.id);
      const list = await getList("/api/workforce/invitations").catch(() => ({ data: [] }));
      const wrap = el("div");
      wrap.append(section(
        "Invite a teammate",
        field("Email", email),
        field("Role", roleSel),
        button("Send invitation", {
          primary: true,
          onClick: async () => {
            if (!email.value.trim() || !roleSel.value) return toast("Email and role required", "warn");
            try {
              const res = await mutate("/api/workforce/invitations", "POST", { email: email.value.trim(), roleId: roleSel.value });
              const token = (res.data || res).token;
              toast("Invitation created. Share this one-time token: " + (token || "(see list)"));
              loadInvites(slot);
            } catch (e) {
              toast(e.message, "err");
            }
          }
        })
      ));
      wrap.append(section("Invitations", (list.data || []).length ? dataTable([{ key: "email", label: "Email" }, { key: "status", label: "Status" }], list.data) : el("p", { class: "view-sub" }, "None yet.")));
      return wrap;
    });
  }
  async function loadSchedules(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/workforce/schedules", { limit: 100 }).catch(() => ({ data: [] }));
      const rows = list.data || [];
      return section("Schedules", rows.length ? dataTable([{ key: "userId", label: "User" }, { key: "kind", label: "Kind" }, { key: "startsAt", label: "Starts" }, { key: "endsAt", label: "Ends" }], rows) : emptyState({ icon: "\u{1F5D3}\uFE0F", title: "No shifts scheduled", message: "Add shifts to plan show and shop coverage. Conflicts are flagged when they overlap." }));
    });
  }

  // apps/ui/public/js/views/settings.js
  registerView("settings", async (container) => {
    container.append(viewHeader({ title: "Settings", subtitle: "Point of sale, connections, backups, health, and automation." }));
    const tabs = el("div", { class: "view-actions", style: "margin-bottom:12px" });
    const slot = el("div");
    container.append(tabs, slot);
    tabs.append(
      button("Point of sale", { onClick: () => loadPointOfSale(slot) }),
      button("Connections", { onClick: () => loadConnections(slot) }),
      button("Backups", { onClick: () => loadBackups(slot) }),
      button("Health", { onClick: () => loadHealth(slot) }),
      button("Automation", { onClick: () => loadAutomation(slot) }),
      button("Diagnostics", { onClick: () => downloadDiagnostics() })
    );
    if (document.body.dataset.nativePos === "true") loadPointOfSale(slot);
    else loadConnections(slot);
  });
  async function loadPointOfSale(slot) {
    await withLoading(slot, async () => {
      const [settings, readiness, locations, reconciliation] = await Promise.all([
        getData("/api/pos/settings"),
        getData("/api/pos/readiness"),
        getData("/api/inventory/locations"),
        getData("/api/pos/reconciliation").catch((error) => ({ unavailable: true, message: error.message }))
      ]);
      const activeLocations = (Array.isArray(locations) ? locations : []).filter((location3) => location3.archived !== 1 && location3.archived !== true);
      const currentLocationIsActive = activeLocations.some((location3) => location3.id === settings.defaultLocationId);
      const location2 = select("defaultLocationId", [
        {
          value: "",
          label: activeLocations.length ? "Choose an active location" : "No active inventory locations available"
        },
        ...activeLocations.map((row2) => ({
          value: row2.id,
          label: `${row2.name}${row2.kind ? ` \xB7 ${humanize2(row2.kind)}` : ""}`
        }))
      ], currentLocationIsActive ? settings.defaultLocationId : "");
      location2.required = true;
      location2.disabled = activeLocations.length === 0;
      const tax = input({
        name: "taxPercent",
        value: Number.isSafeInteger(settings.taxBps) ? bpsText2(settings.taxBps) : "",
        placeholder: "0.00",
        required: true
      });
      tax.setAttribute("inputmode", "decimal");
      const receiptFooter = el("textarea", {
        name: "receiptFooter",
        rows: 4,
        maxlength: 500,
        placeholder: "Optional message printed at the bottom of receipts"
      }, settings.receiptFooter || "");
      const save = button("Save POS settings", {
        primary: true,
        disabled: activeLocations.length === 0,
        onClick: async () => {
          try {
            if (!location2.value) throw new Error("Choose an active inventory location");
            const taxBps = parsePercentToBps(tax.value);
            await mutate("/api/pos/settings", "PUT", {
              defaultLocationId: location2.value,
              taxBps,
              receiptFooter: receiptFooter.value.trim() || null
            });
            toast("Point-of-sale settings saved.");
            await loadPointOfSale(slot);
          } catch (error) {
            toast(error.message, "err", 6e3);
          }
        }
      });
      const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
      const cardPresent = readiness?.tenders?.cardPresent || {};
      const processor = await getData("/api/pos/processor").catch(() => null);
      const cardState = cardPresent.physicalReaderVerified === true ? cardPresent.enabled === true ? "Physical reader verified and enabled" : "Physical reader verified but disabled" : cardPresent.configured === true ? "Provider configured; physical reader not verified" : "Provider and physical reader not configured";
      const wrap = el("div");
      wrap.append(section(
        "Register configuration",
        el("p", { class: "view-sub" }, "Owner/admin controls. Cashiers see the configured tax rate as read-only at the register."),
        !activeLocations.length ? el("div", { class: "blocked", role: "note" }, "Create an active inventory location before enabling the register.") : null,
        settings.defaultLocationId && !currentLocationIsActive ? el("div", { class: "error-banner", role: "alert" }, "The saved POS location is missing or archived. Choose an active location.") : null,
        field("Default active inventory location", location2, "Catalog stock and register sales use this location."),
        field("Sales tax %", tax, "Enter 0 where no sales tax applies."),
        field("Receipt footer", receiptFooter, "Optional, up to 500 characters."),
        save
      ));
      wrap.append(section(
        "Payment processor",
        detailList({
          "Stripe connection": processor?.connected ? `Connected \xB7 ${processor.mode === "live" ? "Live account" : "Test mode"}` : "Connection required",
          "Payment confirmations": processor?.webhookConfigured ? "Webhook configured" : "Webhook setup required"
        }),
        ...(processor?.readers || []).map((reader) => el(
          "p",
          { class: "view-sub" },
          `${reader.label || reader.id} \xB7 ${reader.status || "Unknown status"} \xB7 ${reader.compatible ? "Compatible smart reader" : "Requires a compatible smart reader (WisePOS E or S700)"} `
        )),
        el("p", { class: "view-sub" }, "Card checkout becomes available after the smart reader is online and payment confirmations are connected."),
        button("Check connection", { onClick: () => loadPointOfSale(slot) })
      ));
      wrap.append(section(
        "POS readiness",
        detailList({
          "Register state": chip(readiness?.operational === true ? "Operational" : "Setup required", readiness?.operational === true ? "ok" : "high"),
          "Cash tender": chip(readiness?.tenders?.cash?.enabled === true ? "Enabled" : "Disabled", readiness?.tenders?.cash?.enabled === true ? "ok" : "low"),
          "External tender": chip(readiness?.tenders?.external?.enabled === true ? "Enabled" : "Disabled", readiness?.tenders?.external?.enabled === true ? "ok" : "low"),
          "Card-present state": chip(cardState, cardPresent.physicalReaderVerified === true && cardPresent.enabled === true ? "ok" : "high"),
          "Card provider": cardPresent.provider ? humanize2(cardPresent.provider) : "None",
          "Configured providers": Array.isArray(readiness?.providers) && readiness.providers.length ? readiness.providers.map(humanize2).join(", ") : "None"
        }),
        cardPresent.configured === true && cardPresent.physicalReaderVerified !== true ? el("p", { class: "view-sub" }, "Provider credentials are configured, but that does not verify a connected physical reader or a successful card-present payment.") : null,
        blockers.length ? el("div", {}, [
          el("h3", { style: "margin-top:16px" }, "Readiness blockers and notices"),
          el("ul", { style: "margin:6px 0 0 18px" }, blockers.map((blocker) => el("li", {}, [
            chip(blocker.blocking ? "Blocking" : "Notice", blocker.blocking ? "critical" : "low"),
            el("span", { style: "margin-left:8px" }, blocker.message)
          ])))
        ]) : el("p", { class: "view-sub" }, "The server reports no POS readiness blockers.")
      ));
      const pendingEffects = Number(reconciliation?.pendingCount ?? 0);
      const reconciliationUnavailable = reconciliation?.unavailable === true;
      wrap.append(section(
        "POS reconciliation",
        el("p", { class: "view-sub" }, "Durable repair status for sold and returned stock, register finance entries, and cash drawer movements."),
        reconciliationUnavailable ? el("div", { class: "blocked", role: "note" }, reconciliation.message || "Reconciliation status is unavailable for this operator.") : detailList({
          Status: chip(reconciliation?.healthy === true ? "Healthy" : "Repair required", reconciliation?.healthy === true ? "ok" : "critical"),
          "Pending effects": pendingEffects,
          "Effects with errors": Number(reconciliation?.errorCount ?? 0),
          "Completed effects": Number(reconciliation?.completedCount ?? 0),
          "Total effects": Number(reconciliation?.totalCount ?? 0)
        }),
        reconciliationUnavailable ? null : button("Run POS reconciliation", {
          primary: pendingEffects > 0,
          onClick: async () => {
            try {
              await mutate("/api/pos/reconciliation/drain", "POST", {}, { query: { limit: 200 } });
              toast("POS reconciliation completed.");
              await loadPointOfSale(slot);
            } catch (error) {
              toast(error.message, "err", 6e3);
            }
          }
        })
      ));
      return wrap;
    });
  }
  async function loadConnections(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/admin/credentials").catch(() => ({ data: [] }));
      const rows = list.data || [];
      let expiring = [];
      try {
        expiring = await getData("/api/admin/credentials/expiring", { days: 14 }) || [];
      } catch {
      }
      const name = input({ name: "name", placeholder: "e.g. Square" });
      const provider = input({ name: "provider", placeholder: "provider key (e.g. smtp, square)" });
      const secret = input({ name: "secret", placeholder: "secret / token" });
      const wrap = el("div");
      if (Array.isArray(expiring) && expiring.length) {
        wrap.append(el("div", { class: "blocked" }, [el("strong", {}, "Expiring soon: "), expiring.map((c) => c.name || c.id).join(", ")]));
      }
      wrap.append(section(
        "Add a connection",
        field("Name", name),
        field("Provider", provider, "The kind of connection (SMTP for email, Square for payments, \u2026)."),
        field("Secret", secret, document.body.dataset.nativePos === "true" ? "Stored encrypted on this iPad. Never shown again." : "Stored encrypted on this computer (AES-GCM). Never shown again."),
        button("Save connection", {
          primary: true,
          onClick: async () => {
            if (!name.value.trim() || !provider.value.trim()) return toast("Name and provider required", "warn");
            try {
              await mutate("/api/admin/credentials", "POST", { name: name.value.trim(), provider: provider.value.trim(), payload: { secret: secret.value } });
              toast("Connection saved (encrypted).");
              loadConnections(slot);
            } catch (e) {
              toast(e.message, "err");
            }
          }
        })
      ));
      wrap.append(section("Connections", rows.length ? dataTable([
        { key: "name", label: "Name" },
        { key: "provider", label: "Provider" },
        { key: "masked", label: "Secret", render: () => chip("\u2022\u2022\u2022\u2022 stored", "ok") },
        { key: "test", label: "", render: (c) => button("Test", { onClick: () => testConn(c.id) }) }
      ], rows) : el("p", { class: "view-sub" }, "No connections yet. Email and payments stay off until connected.")));
      return wrap;
    });
  }
  async function testConn(id) {
    try {
      await mutate(`/api/admin/credentials/${id}/test`, "POST", {});
      toast("Connection test passed.");
    } catch (e) {
      toast(e.status === 501 ? "No tester wired for this provider yet." : e.message, "warn");
    }
  }
  async function loadBackups(slot) {
    await withLoading(slot, async () => {
      const list = await getList("/api/admin/backups").catch(() => ({ data: [] }));
      const rows = list.data || [];
      const wrap = el("div");
      wrap.append(section(
        "Backups",
        el("div", { class: "view-actions" }, [
          button("Run backup now", { primary: true, onClick: async () => {
            try {
              await mutate("/api/admin/backups/run", "POST", { encrypted: true });
              toast("Backup started.");
              loadBackups(slot);
            } catch (e) {
              toast(e.status === 501 ? "Backup provider not available in this session." : e.message, "warn");
            }
          } })
        ]),
        rows.length ? dataTable([{ key: "created_at", label: "When", render: (b) => formatDateTime(b.created_at || b.createdAt) }, { key: "verified", label: "Verified", render: (b) => chip(b.verified || b.status === "verified" ? "yes" : "no", b.verified || b.status === "verified" ? "ok" : "low") }], rows) : el("p", { class: "view-sub" }, "No backups yet. Run one before big changes."),
        el("p", { class: "hint", style: "margin-top:10px" }, "To restore: stop the app, replace the database file with the verified backup, and restart. Keep a copy of the current file first.")
      ));
      return wrap;
    });
  }
  async function loadHealth(slot) {
    await withLoading(slot, async () => {
      let runs = [];
      try {
        await mutate("/api/admin/health/run", "POST", {});
        runs = (await getList("/api/admin/health/runs")).data || [];
      } catch {
      }
      if (!runs.length) return emptyState({ icon: "\u{1FA7A}", title: "No health checks yet", message: "Health checks watch the database, disk, backups, imports, and outbox." });
      const latest = runs[0];
      const checks = latest.checks || latest.results || [];
      return section("Health", Array.isArray(checks) && checks.length ? dataTable([{ key: "name", label: "Check" }, { key: "status", label: "Status", render: (c) => chip(c.status || c.ok ? "ok" : "fail", c.status === "ok" || c.ok ? "ok" : "critical") }], checks) : el("p", { class: "view-sub" }, "Health ran; no detail rows returned."));
    });
  }
  async function loadAutomation(slot) {
    await withLoading(slot, async () => {
      const rules = (await getList("/api/automation/rules").catch(() => ({ data: [] }))).data || [];
      const dead = (await getList("/api/automation/outbox/dead").catch(() => ({ data: [] }))).data || [];
      const wrap = el("div");
      wrap.append(section("Automation rules", rules.length ? dataTable([{ key: "name", label: "Rule" }, { key: "triggerEvent", label: "When" }, { key: "policy", label: "Policy", render: (r) => chip(r.policy || "disabled", r.policy === "automatic" ? "ok" : "low") }], rules) : el("p", { class: "view-sub" }, "No automation rules configured.")));
      wrap.append(section("Dead letters", dead.length ? dataTable([{ key: "id", label: "Item" }, { key: "error", label: "Error" }, { key: "replay", label: "", render: (d) => button("Replay", { onClick: async () => {
        try {
          await mutate(`/api/automation/outbox/${d.id}/replay`, "POST", {});
          toast("Replayed.");
          loadAutomation(slot);
        } catch (e) {
          toast(e.message, "err");
        }
      } }) }], dead) : el("p", { class: "view-sub" }, "No dead-letter items \u2014 nothing failed delivery.")));
      return wrap;
    });
  }
  async function downloadDiagnostics() {
    if (document.body.dataset.nativePos === "true") {
      try {
        const diagnostics = await getData("/api/admin/diagnostics");
        const a2 = document.createElement("a");
        a2.href = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2)], { type: "application/json" }));
        a2.download = "bar-one-diagnostics.json";
        document.body.append(a2);
        a2.click();
        a2.remove();
        setTimeout(() => URL.revokeObjectURL(a2.href), 3e4);
      } catch (error) {
        toast(error.message, "err");
      }
      return;
    }
    const a = document.createElement("a");
    a.href = "/api/admin/diagnostics";
    a.download = "one-club-diagnostics.json";
    document.body.append(a);
    a.click();
    a.remove();
  }
  function bpsText2(bps) {
    return `${Math.floor(bps / 100)}.${String(bps % 100).padStart(2, "0")}`;
  }
  function humanize2(value) {
    return String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  // apps/ui/public/js/views/imports.js
  registerView("imports", async (container) => {
    container.append(viewHeader({ title: "Imports", subtitle: "Where your Square data comes in \u2014 status, manifests, and anything that needs fixing." }));
    const slot = el("div");
    container.append(slot);
    await withLoading(slot, async () => {
      const wrap = el("div");
      try {
        const status = await getData("/api/retail/imports/status");
        wrap.append(section("Sync status", renderStatus(status)));
      } catch {
        wrap.append(section("Sync status", el("p", { class: "view-sub" }, "No incremental import runs yet. Historical data was loaded once from the ledger.")));
      }
      try {
        const rec = await getData("/api/retail/imports/reconciliation");
        wrap.append(section("Reconciliation", expandable("Totals and coverage", el("pre", { style: "white-space:pre-wrap;margin:0" }, JSON.stringify(rec, null, 2)))));
      } catch {
      }
      const manifests = (await getList("/api/retail/imports/manifests").catch(() => ({ data: [] }))).data || [];
      wrap.append(section("Import manifests", manifests.length ? dataTable([{ key: "id", label: "Manifest" }, { key: "kind", label: "Kind" }, { key: "created_at", label: "When", render: (m) => formatDateTime(m.created_at || m.createdAt) }], manifests) : el("p", { class: "view-sub" }, "No import manifests recorded yet.")));
      const quarantine = (await getList("/api/retail/quarantine").catch(() => ({ data: [] }))).data || [];
      wrap.append(section("Needs fixing (quarantine)", quarantine.length ? el("div", {}, quarantine.map((q) => el("div", { class: "card", style: "margin-bottom:10px" }, [
        el("div", { style: "display:flex;justify-content:space-between" }, [el("strong", {}, q.kind || "record"), chip(q.status || "open", "high")]),
        expandable("Show record", el("pre", { style: "white-space:pre-wrap;margin:0" }, JSON.stringify(q.record || q, null, 2))),
        el("div", { class: "view-actions" }, [
          button("Discard", { onClick: async () => {
            const reason = prompt("Why discard this record?");
            if (!reason) return;
            try {
              await mutate(`/api/retail/quarantine/${q.id}/discard`, "POST", { reason });
              toast("Discarded.");
              location.hash = "#/imports";
            } catch (e) {
              toast(e.message, "err");
            }
          } })
        ])
      ]))) : el("div", { class: "chip chip-ok" }, "Nothing quarantined \u2014 every record imported cleanly.")));
      return wrap;
    });
  });
  function renderStatus(status) {
    const kinds = status && (status.kinds || status.byKind || status);
    if (Array.isArray(kinds)) {
      return dataTable([
        { key: "kind", label: "Data" },
        { key: "lastSuccessAt", label: "Last success", render: (k) => formatDateTime(k.lastSuccessAt || k.last_success_at) },
        { key: "stale", label: "Fresh?", render: (k) => chip(k.stale ? "stale" : "fresh", k.stale ? "high" : "ok") }
      ], kinds);
    }
    return el("pre", { style: "white-space:pre-wrap;margin:0" }, JSON.stringify(status, null, 2));
  }

  // apps/ui/public/js/app.js
  var ctx3 = { asOf: null, tenantName: "Bar One" };
  function buildNav() {
    const list = $("#nav-list");
    clear(list);
    for (const group of NAV_GROUPS) {
      const barSections = ["bar", "orders", "money", "team", "settings"];
      const items = NAV.filter((n) => n.group === group.key && (document.body.dataset.posProfile !== "bar" || barSections.includes(n.route)));
      if (!items.length) continue;
      list.append(el("li", { class: "nav-group-label", role: "presentation" }, group.label));
      for (const n of items) {
        const link = el(
          "a",
          { class: "nav-link", href: hashFor(n.route), "data-route": n.route },
          [
            navSymbol(n.route),
            el("span", {}, n.label),
            el("span", { class: "nav-badge", "data-badge": n.route, hidden: true })
          ]
        );
        list.append(el("li", {}, link));
      }
    }
  }
  function markActive(route) {
    $$(".nav-link").forEach((a) => {
      if (a.dataset.route === route) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    $("#app-nav").classList.remove("open");
    $("#nav-toggle").setAttribute("aria-expanded", "false");
  }
  function paintSync(snap) {
    const ind = $("#sync-indicator");
    const text = $("#sync-text");
    ind.classList.remove("sync-synced", "sync-queued", "sync-failed");
    if (snap.status === "failed") {
      ind.classList.add("sync-failed");
      const n = snap.counts.failed + snap.counts.conflict;
      text.textContent = `${n} to fix \u2014 retry`;
      ind.title = "Some changes could not be saved to the server. Click to retry.";
    } else if (snap.status === "queued") {
      ind.classList.add("sync-queued");
      text.textContent = `${snap.pending} saving\u2026`;
      ind.title = "Changes are queued and will sync when connection returns.";
    } else {
      ind.classList.add("sync-synced");
      text.textContent = document.body.dataset.nativePos === "true" ? "Saved on iPad" : "Synced";
      ind.title = "All changes saved.";
    }
  }
  async function loadHeader() {
    try {
      const owner = await getData("/api/dashboard/owner.json");
      const asOf = owner?.dataAsOf || owner?.asOf || owner?.dataThrough || owner?.through || owner?.generatedAt || null;
      if (asOf) {
        ctx3.asOf = asOf;
        $("#data-as-of").textContent = dataAsOf(asOf);
      }
      if (owner?.tenantName) {
        ctx3.tenantName = owner.tenantName;
        $("#tenant-name").textContent = owner.tenantName;
        $("#tenant-name").title = `Connected account: ${owner.tenantName}`;
      }
    } catch {
      $("#data-as-of").textContent = "Data as of \u2014 (offline)";
    }
  }
  function wireChrome() {
    $("#nav-toggle").addEventListener("click", () => {
      const nav = $("#app-nav");
      const open = nav.classList.toggle("open");
      $("#nav-toggle").setAttribute("aria-expanded", String(open));
    });
    $("#sync-indicator").addEventListener("click", () => retryFailed());
    window.addEventListener("pointerdown", primeAudio, { once: true });
    window.addEventListener("keydown", primeAudio, { once: true });
  }
  async function main() {
    buildNav();
    wireChrome();
    await requireOperatorSession();
    await initOfflineQueue(sendRaw);
    onQueueChange(paintSync);
    const missing = unregisteredNavRoutes();
    if (missing.length) console.error("[one-club-pos] nav routes with no view:", missing);
    await loadHeader();
    startRouter($("#view-root"), ctx3, (route) => markActive(route));
    if ("serviceWorker" in navigator && document.body.dataset.nativePos !== "true") {
      navigator.serviceWorker.register("./sw.js").catch(() => {
      });
    }
  }
  main().catch((error) => {
    const root2 = $("#view-root");
    clear(root2);
    root2.append(el("div", { class: "empty", role: "alert" }, [
      el("div", { class: "empty-icon", "aria-hidden": "true" }, "\u{1F512}"),
      el("h1", {}, "Register sign-in unavailable"),
      el("p", {}, error?.message || "The local register service could not be reached."),
      el("button", { class: "btn btn-primary", type: "button", onclick: () => window.location.reload() }, "Try again")
    ]));
  });
})();
