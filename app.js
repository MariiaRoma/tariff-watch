/**
 * Tariff Watch — app logic
 * No framework, no build step: plain DOM rendering so the whole thing can
 * be opened straight from a static host (or file://) with zero tooling.
 */

(function () {
  "use strict";

  // ------------------------------------------------------------------
  // Storage keys & small persistence helpers
  // ------------------------------------------------------------------
  const LS_WATCHLIST = "tw_watchlist_v1";
  const LS_SNAPSHOT = "tw_rate_snapshot_v1";
  const LS_SEEN_VERSION = "tw_seen_data_version_v1";
  const LS_PUSH_ENABLED = "tw_push_enabled_v1";

  // Public VAPID key for Web Push (safe to expose client-side by design —
  // it's the "who is this server" half of the key pair, not the secret).
  const VAPID_PUBLIC_KEY =
    "BAx2BUnQPY9KZSv3K7547El7sRSMbM35CmF9dOBLqnP7rkJaN8MGInmghRcYh769dYOyidChPo1IbHuWLcJzfhk";
  const SUBSCRIBE_ENDPOINT = "/.netlify/functions/subscribe";
  const UNSUBSCRIBE_ENDPOINT = "/.netlify/functions/unsubscribe";

  // Supabase project config — the publishable key is safe to expose
  // client-side by design (same trust model as VAPID_PUBLIC_KEY above),
  // as long as Row Level Security policies are in place on every table.
  const SUPABASE_URL = "https://llhsbpvmvbaxrwrhsdwy.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HuYXhX8a-U4_mGuwEM0Rfw_b_bNxOi8";
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  // Stripe price ids are not secret — safe to hardcode alongside the
  // publishable key, same trust model as VAPID_PUBLIC_KEY above.
  const PRICE_EXPOSURE_REPORT = "price_1UDo2h2XFD9iubrBAGsgoCFK";

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable (private mode, quota) — app still works, just won't persist */
    }
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  const state = {
    tab: "watchlist",
    watchlist: new Set(loadJSON(LS_WATCHLIST, [])),
    search: { q: "", direction: "all", category: "all" },
    sheetItemId: null,
  };

  const byId = (id) => TARIFF_DATA.find((d) => d.id === id);

  function persistWatchlist() {
    saveJSON(LS_WATCHLIST, [...state.watchlist]);
    syncWatchlistToSupabase();
  }

  // Best-effort mirror of the local watchlist into Supabase, so a paid
  // report has something to read server-side. Not required for the
  // app's core (offline-first, local) watchlist to keep working.
  async function syncWatchlistToSupabase() {
    try {
      const { data } = await supabaseClient.auth.getSession();
      const userId = data.session?.user?.id;
      if (!userId) return;
      await supabaseClient
        .from("watchlists")
        .upsert({ user_id: userId, name: "My Watchlist", hs_codes: [...state.watchlist] }, { onConflict: "user_id" });
    } catch (e) {
      /* best effort */
    }
  }

  // ------------------------------------------------------------------
  // Formatting helpers
  // ------------------------------------------------------------------
  const money = (n, currency) =>
    new Intl.NumberFormat("en-CA", {
      style: "currency",
      currency: currency || "CAD",
      maximumFractionDigits: 2,
    }).format(n);

  const dateFmt = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  };

  function directionLabel(dir) {
    return dir === "us_to_ca" ? "US → CA" : "CA → US";
  }

  // ------------------------------------------------------------------
  // Ledger row rendering (shared by Watchlist + Search screens)
  // ------------------------------------------------------------------
  function rateDeltaMarkup(item) {
    if (item.priorRate === null || item.priorRate === undefined) return "";
    const up = item.rate > item.priorRate;
    const cls = up ? "rate-delta--up" : "rate-delta--down";
    const arrow = up ? "▲" : "▼";
    return `<span class="rate-delta ${cls}">${arrow} was ${item.priorRate}% · ${dateFmt(item.changeDate || item.effectiveDate)}</span>`;
  }

  function ledgerRow(item, opts) {
    opts = opts || {};
    const inWatchlist = state.watchlist.has(item.id);
    const actionBtn = opts.showAction
      ? `<button class="icon-btn ledger-row__action" data-action="${inWatchlist ? "remove" : "add"}" data-id="${item.id}" aria-label="${inWatchlist ? "Remove from watchlist" : "Add to watchlist"}">${inWatchlist ? "−" : "+"}</button>`
      : "";
    const dirClass = item.direction === "us_to_ca" ? "direction-badge--ca" : "direction-badge--us";
    return `
      <div class="ledger-row" data-open="${item.id}">
        <div class="ledger-row__main">
          <div class="ledger-row__code-line">
            <span class="hs-code">${item.hs}</span>
            <span class="direction-badge ${dirClass}">${directionLabel(item.direction)}</span>
          </div>
          <div class="ledger-row__desc">${item.desc}</div>
          <div class="ledger-row__meta">${item.category} · ${item.verified ? "Official list" : "Representative — verify code"}</div>
        </div>
        <div class="ledger-row__rate">
          <span class="rate-figure">${item.rate}%</span>
          ${rateDeltaMarkup(item)}
        </div>
        ${actionBtn}
      </div>`;
  }

  // ------------------------------------------------------------------
  // Watchlist screen
  // ------------------------------------------------------------------
  function renderWatchlist() {
    const root = document.getElementById("watchlist-list");
    const items = [...state.watchlist].map(byId).filter(Boolean);
    document.getElementById("watchlist-count").textContent = items.length
      ? `${items.length} tracked`
      : "";

    if (!items.length) {
      root.innerHTML = `
        <div class="ledger-empty">
          <strong>No codes on watch yet</strong>
          Add an HS code from Search, or from the calculator result, and
          Tariff Watch will flag it here whenever its rate moves.
        </div>`;
      return;
    }

    items.sort((a, b) => (a.changeDate || "") < (b.changeDate || "") ? 1 : -1);
    root.innerHTML = `<div class="ledger">${items.map((it) => ledgerRow(it, { showAction: true })).join("")}</div>`;
  }

  // ------------------------------------------------------------------
  // Search screen
  // ------------------------------------------------------------------
  function populateCategoryChips() {
    const wrap = document.getElementById("search-categories");
    const chips = ["all", ...ALL_CATEGORIES];
    wrap.innerHTML = chips
      .map(
        (c) =>
          `<button class="chip ${state.search.category === c ? "is-active" : ""}" data-cat="${c}">${c === "all" ? "All categories" : c}</button>`
      )
      .join("");
  }

  function renderSearch() {
    const root = document.getElementById("search-results");
    const q = state.search.q.trim().toLowerCase();
    const dir = state.search.direction;
    const cat = state.search.category;

    let results = TARIFF_DATA.filter((item) => {
      if (dir !== "all" && item.direction !== dir) return false;
      if (cat !== "all" && item.category !== cat) return false;
      if (!q) return true;
      return (
        item.hs.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    });

    document.getElementById("search-count").textContent = `${results.length} of ${TARIFF_DATA.length} sample entries`;

    if (!results.length) {
      root.innerHTML = `
        <div class="ledger-empty">
          <strong>No matches in this sample</strong>
          This MVP ships a curated ~75-line sample, not the full 874-item
          CBSA/USITC schedules. Try a broader term, or see the About tab
          for how a production build would sync the complete tariff data.
        </div>`;
      return;
    }

    root.innerHTML = `<div class="ledger">${results.map((it) => ledgerRow(it, { showAction: true })).join("")}</div>`;
  }

  // ------------------------------------------------------------------
  // Detail sheet
  // ------------------------------------------------------------------
  function openSheet(id) {
    const item = byId(id);
    if (!item) return;
    state.sheetItemId = id;
    document.getElementById("sheet-title").textContent = item.desc;
    document.getElementById("sheet-hs").textContent = `${item.hs} · ${directionLabel(item.direction)}`;

    const rows = [
      ["Current rate", `${item.rate}%`],
      ["Category", item.category],
      ["Effective", dateFmt(item.changeDate || item.effectiveDate)],
      ["Legal basis", item.legalBasis],
      ["Data confidence", item.verified ? "From official published list" : "Representative sample — confirm exact HS line"],
    ];
    document.getElementById("sheet-rows").innerHTML = rows
      .map(([k, v]) => `<div class="sheet__row"><dt>${k}</dt><dd>${v}</dd></div>`)
      .join("");

    const inWatchlist = state.watchlist.has(id);
    document.getElementById("sheet-watch-btn").textContent = inWatchlist ? "Remove from watchlist" : "Add to watchlist";
    document.getElementById("sheet-watch-btn").dataset.id = id;
    document.getElementById("sheet-watch-btn").dataset.action = inWatchlist ? "remove" : "add";

    document.getElementById("sheet-calc-btn").dataset.id = id;

    document.getElementById("sheet-backdrop").classList.add("is-open");
    document.getElementById("sheet").classList.add("is-open");
  }

  function closeSheet() {
    document.getElementById("sheet-backdrop").classList.remove("is-open");
    document.getElementById("sheet").classList.remove("is-open");
    state.sheetItemId = null;
  }

  function toggleWatch(id, action) {
    if (action === "add") state.watchlist.add(id);
    else state.watchlist.delete(id);
    persistWatchlist();
    renderWatchlist();
    renderSearch();
    updateNotifyStrip();
    syncPushSubscriptionIfEnabled();
    if (state.sheetItemId === id) openSheet(id); // refresh sheet button label
  }

  // ------------------------------------------------------------------
  // Calculator
  // ------------------------------------------------------------------
  const MPF_RATE = 0.003464;
  const MPF_MIN = 32.71;
  const MPF_MAX = 634.62;
  const HMF_RATE = 0.00125;
  const GST_RATE = 0.05;

  function calcState() {
    return {
      direction: document.querySelector(".direction-toggle button.is-active").dataset.dir,
      value: parseFloat(document.getElementById("calc-value").value) || 0,
      rate: parseFloat(document.getElementById("calc-rate").value) || 0,
      extraRate: parseFloat(document.getElementById("calc-extra-rate").value) || 0,
      freight: parseFloat(document.getElementById("calc-freight").value) || 0,
      insurance: parseFloat(document.getElementById("calc-insurance").value) || 0,
      ocean: document.getElementById("calc-ocean").checked,
    };
  }

  function renderCalc() {
    const s = calcState();
    const out = document.getElementById("calc-result");
    if (!s.value) {
      out.innerHTML = "";
      return;
    }
    const duty = s.value * (s.rate / 100);
    const extraDuty = s.value * (s.extraRate / 100);

    if (s.direction === "us_to_ca") {
      const gstBase = s.value + duty + extraDuty;
      const gst = gstBase * GST_RATE;
      const total = s.value + duty + extraDuty + gst + s.freight + s.insurance;
      out.innerHTML = `
        <div class="calc-result__head">Estimated landed cost — importing into Canada</div>
        <div class="calc-line"><span class="calc-line__label">Customs value</span><span class="calc-line__value">${money(s.value)}</span></div>
        <div class="calc-line"><span class="calc-line__label">Duty (${s.rate}%)</span><span class="calc-line__value">${money(duty)}</span></div>
        ${s.extraRate ? `<div class="calc-line"><span class="calc-line__label">Additional surtax (${s.extraRate}%)</span><span class="calc-line__value">${money(extraDuty)}</span></div>` : ""}
        <div class="calc-line"><span class="calc-line__label">Freight</span><span class="calc-line__value">${money(s.freight)}</span></div>
        <div class="calc-line"><span class="calc-line__label">Insurance</span><span class="calc-line__value">${money(s.insurance)}</span></div>
        <div class="calc-line"><span class="calc-line__label">Est. GST (5%, on value+duty)</span><span class="calc-line__value">${money(gst)}</span></div>
        <div class="calc-line calc-line--total"><span class="calc-line__label">Estimated total</span><span class="calc-line__value">${money(total)}</span></div>`;
    } else {
      const mpfRaw = s.value * MPF_RATE;
      const mpf = Math.min(Math.max(mpfRaw, MPF_MIN), MPF_MAX);
      const hmf = s.ocean ? s.value * HMF_RATE : 0;
      const total = s.value + duty + extraDuty + mpf + hmf + s.freight + s.insurance;
      out.innerHTML = `
        <div class="calc-result__head">Estimated landed cost — importing into the US</div>
        <div class="calc-line"><span class="calc-line__label">Customs value</span><span class="calc-line__value">${money(s.value, "USD")}</span></div>
        <div class="calc-line"><span class="calc-line__label">Duty (${s.rate}%)</span><span class="calc-line__value">${money(duty, "USD")}</span></div>
        ${s.extraRate ? `<div class="calc-line"><span class="calc-line__label">Additional surtax (${s.extraRate}%)</span><span class="calc-line__value">${money(extraDuty, "USD")}</span></div>` : ""}
        <div class="calc-line"><span class="calc-line__label">MPF (0.3464%, capped)</span><span class="calc-line__value">${money(mpf, "USD")}</span></div>
        ${s.ocean ? `<div class="calc-line"><span class="calc-line__label">HMF (0.125%, ocean only)</span><span class="calc-line__value">${money(hmf, "USD")}</span></div>` : ""}
        <div class="calc-line"><span class="calc-line__label">Freight</span><span class="calc-line__value">${money(s.freight, "USD")}</span></div>
        <div class="calc-line"><span class="calc-line__label">Insurance</span><span class="calc-line__value">${money(s.insurance, "USD")}</span></div>
        <div class="calc-line calc-line--total"><span class="calc-line__label">Estimated total</span><span class="calc-line__value">${money(total, "USD")}</span></div>`;
    }
  }

  function fillCalculatorFromItem(id) {
    const item = byId(id);
    if (!item) return;
    switchTab("calculator");
    document.querySelectorAll(".direction-toggle button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.dir === item.direction);
    });
    document.getElementById("calc-hs-label").textContent = `${item.hs} — ${item.desc}`;
    document.getElementById("calc-rate").value = item.rate;
    renderCalc();
  }

  // ------------------------------------------------------------------
  // Push notifications
  // ------------------------------------------------------------------
  function pushSupported() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function postSubscription(sub) {
    try {
      await fetch(SUBSCRIBE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON(), watchlist: [...state.watchlist] }),
      });
    } catch (e) {
      // Best-effort — a failed sync here just means the backend's copy of
      // this device's watchlist is stale until the next successful call.
    }
  }

  // Keeps the backend's copy of this device's watchlist current. Called
  // after every watchlist change, but only does network work if the
  // device is already subscribed — otherwise a no-op.
  async function syncPushSubscriptionIfEnabled() {
    if (!pushSupported() || Notification.permission !== "granted" || !loadJSON(LS_PUSH_ENABLED, false)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await postSubscription(sub);
    } catch (e) {
      /* ignore — best effort */
    }
  }

  async function enablePush() {
    if (!pushSupported()) {
      window.alert("Push notifications aren't supported in this browser.");
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      updateNotifyStrip();
      return;
    }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      await postSubscription(sub);
      saveJSON(LS_PUSH_ENABLED, true);
      const { data } = await supabaseClient.auth.getSession();
      if (data.session && data.session.user) await linkPushSubscriptionToUser(data.session.user.id);
    } catch (e) {
      window.alert("Couldn't enable notifications — please try again.");
    }
    updateNotifyStrip();
  }

  async function disablePush() {
    if (!pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        try {
          await fetch(UNSUBSCRIBE_ENDPOINT, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          });
        } catch (e) {
          /* best effort */
        }
        await sub.unsubscribe();
      }
    } catch (e) {
      /* ignore */
    }
    saveJSON(LS_PUSH_ENABLED, false);
    updateNotifyStrip();
  }

  function updateNotifyStrip() {
    const strip = document.getElementById("notify-strip");
    const text = document.getElementById("notify-text");
    const btn = document.getElementById("notify-enable-btn");
    if (!strip || !text || !btn) return;

    if (!pushSupported() || sessionStorage.getItem("tw_notify_dismissed")) {
      strip.classList.remove("is-visible");
      return;
    }

    const permission = Notification.permission;
    if (permission === "granted" && loadJSON(LS_PUSH_ENABLED, false)) {
      text.textContent = "\uD83D\uDD14 Notifications are on for your watchlist.";
      btn.textContent = "Turn off";
      btn.dataset.action = "disable";
      strip.classList.add("is-visible");
    } else if (permission === "denied") {
      // Browsers won't let us re-prompt once denied — nagging would just
      // annoy people. They can still re-enable via their browser's site
      // settings if they change their mind.
      strip.classList.remove("is-visible");
    } else if (state.watchlist.size > 0) {
      text.textContent = "Get notified when a watched code changes rate.";
      btn.textContent = "Enable";
      btn.dataset.action = "enable";
      strip.classList.add("is-visible");
    } else {
      strip.classList.remove("is-visible");
    }
  }

  // ------------------------------------------------------------------
  // Tab navigation
  // ------------------------------------------------------------------
  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll(".screen").forEach((el) => el.classList.toggle("is-active", el.id === `screen-${tab}`));
    document.querySelectorAll(".tab-bar__btn").forEach((el) => el.classList.toggle("is-active", el.dataset.tab === tab));
    document.getElementById("app-main").scrollTop = 0;
  }

  // ------------------------------------------------------------------
  // "Since you last looked" alert banner
  // Compares the dataset's current rates for WATCHED items against a
  // snapshot saved on the previous visit. This simulates a push alert
  // entirely client-side; see README for the real push-notification path.
  // ------------------------------------------------------------------
  function checkForChangesSinceLastVisit() {
    const prevSnapshot = loadJSON(LS_SNAPSHOT, null);
    const currentSnapshot = {};
    TARIFF_DATA.forEach((d) => (currentSnapshot[d.id] = d.rate));

    const banner = document.getElementById("alert-banner");
    if (prevSnapshot) {
      const changed = [...state.watchlist]
        .map(byId)
        .filter(Boolean)
        .filter((item) => prevSnapshot[item.id] !== undefined && prevSnapshot[item.id] !== item.rate);

      if (changed.length) {
        document.getElementById("alert-banner-text").textContent =
          changed.length === 1
            ? `${changed[0].hs} changed to ${changed[0].rate}% since your last visit.`
            : `${changed.length} watched codes changed rate since your last visit.`;
        banner.style.display = "flex";
      } else {
        banner.style.display = "none";
      }
    } else {
      banner.style.display = "none";
    }
    saveJSON(LS_SNAPSHOT, currentSnapshot);
  }

  // ------------------------------------------------------------------
  // Install prompt (Android/Chrome via beforeinstallprompt; iOS gets a
  // manual tip since Safari never fires that event)
  // ------------------------------------------------------------------
  let deferredInstallPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const strip = document.getElementById("install-strip");
    if (strip && !sessionStorage.getItem("tw_install_dismissed")) strip.classList.add("is-visible");
  });

  function isIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
  }

  // ------------------------------------------------------------------
  // Wire up events
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // Account (Supabase magic-link auth)
  // ------------------------------------------------------------------
  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Links this device's existing push subscription (if any) to the
  // signed-in user, so a future account-wide feature (e.g. multiple
  // watchlists) can find every device belonging to one person. The
  // subscription itself stays in Netlify Blobs untouched — this just
  // records which user owns which blob_key (sha256 of the endpoint,
  // same formula as keyForEndpoint() in netlify/functions/_shared.mjs).
  async function linkPushSubscriptionToUser(userId) {
    if (!userId || !pushSupported()) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) return;
      const blobKey = await sha256Hex(sub.endpoint);
      await supabaseClient.from("push_subscriptions").upsert({ blob_key: blobKey, user_id: userId });
    } catch (e) {
      /* best effort — device linking isn't required for core functionality */
    }
  }

  function renderAccountScreen(session) {
    const signedOut = document.getElementById("account-signed-out");
    const signedIn = document.getElementById("account-signed-in");
    if (session && session.user) {
      signedOut.style.display = "none";
      signedIn.style.display = "block";
      document.getElementById("account-email-display").textContent = session.user.email;
    } else {
      signedOut.style.display = "block";
      signedIn.style.display = "none";
    }
  }

  async function sendMagicLink(email) {
    const statusEl = document.getElementById("account-status");
    statusEl.textContent = "Sending...";
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    statusEl.textContent = error
      ? `Error: ${error.message}`
      : "Check your email for a sign-in link.";
  }

  async function signOutAccount() {
    await supabaseClient.auth.signOut();
  }

  async function buyExposureReport() {
    const statusEl = document.getElementById("checkout-status");
    statusEl.textContent = "Redirecting to checkout...";
    try {
      const { data } = await supabaseClient.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        statusEl.textContent = "Please sign in first.";
        return;
      }
      const res = await fetch("/.netlify/functions/create-checkout-session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ priceId: PRICE_EXPOSURE_REPORT }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.url) {
        statusEl.textContent = `Error: ${payload.error || "Could not start checkout"}`;
        return;
      }
      window.location.href = payload.url;
    } catch (e) {
      statusEl.textContent = "Something went wrong — please try again.";
    }
  }

  // ------------------------------------------------------------------
  // Local report cache (IndexedDB)
  // ------------------------------------------------------------------
  // Once a report PDF has been fetched from Supabase Storage, keep a
  // copy on-device — the app is offline-first everywhere else
  // (service worker, watchlist in localStorage), and a paid report
  // shouldn't stop being available just because the person is offline
  // or the 1-hour signed URL expired.
  const REPORTS_DB_NAME = "tariff-watch-reports";
  const REPORTS_STORE = "pdfs";

  function openReportsDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(REPORTS_DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(REPORTS_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getCachedReportBlob(id) {
    try {
      const db = await openReportsDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(REPORTS_STORE, "readonly");
        const req = tx.objectStore(REPORTS_STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null; // IndexedDB unavailable (e.g. private browsing) — fall back to network
    }
  }

  async function saveCachedReportBlob(id, blob) {
    try {
      const db = await openReportsDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(REPORTS_STORE, "readwrite");
        tx.objectStore(REPORTS_STORE).put(blob, id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      /* best effort — the report still downloads fine this session even if caching fails */
    }
  }

  async function renderMyReports(userId) {
    const container = document.getElementById("my-reports");
    if (!container || !userId) return;
    try {
      const { data: purchases, error } = await supabaseClient
        .from("report_purchases")
        .select("id, report_type, status, file_path, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error || !purchases || purchases.length === 0) {
        container.innerHTML = "";
        return;
      }
      const rows = await Promise.all(
        purchases.map(async (p) => {
          const date = new Date(p.created_at).toLocaleDateString();
          if (!p.file_path) {
            return `<div class="field-hint">${date} — ${p.report_type}: preparing…</div>`;
          }

          // Prefer a copy already saved on this device — works offline
          // and skips re-downloading every time this screen renders.
          let blob = await getCachedReportBlob(p.id);
          if (!blob && navigator.onLine) {
            try {
              const { data: signed } = await supabaseClient.storage.from("reports").createSignedUrl(p.file_path, 3600);
              if (signed?.signedUrl) {
                const res = await fetch(signed.signedUrl);
                blob = await res.blob();
                saveCachedReportBlob(p.id, blob); // fire-and-forget
              }
            } catch (e) {
              /* fall through to "unavailable" below */
            }
          }

          if (blob) {
            const url = URL.createObjectURL(blob);
            const savedNote = navigator.onLine ? "" : " (saved on this device)";
            return `<div class="field-hint">${date} — ${p.report_type}: <a href="${url}" download="tariff-exposure-report.pdf">Download PDF</a>${savedNote}</div>`;
          }
          return `<div class="field-hint">${date} — ${p.report_type}: <em>${navigator.onLine ? "unavailable right now" : "offline — connect to download once, then it's saved"}</em></div>`;
        })
      );
      container.innerHTML =
        `<div class="section-head" style="margin-top:24px;"><h2>My reports</h2></div>` + rows.join("");
    } catch (e) {
      /* best effort */
    }
  }

  function initAccount() {
    document.getElementById("account-send-link").addEventListener("click", () => {
      const email = document.getElementById("account-email").value.trim();
      if (email) sendMagicLink(email);
    });
    document.getElementById("account-sign-out").addEventListener("click", signOutAccount);
    document.getElementById("buy-exposure-report").addEventListener("click", buyExposureReport);

    // Fires on sign-in, sign-out, and token refresh — including right
    // after the person clicks the magic link and lands back here.
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      renderAccountScreen(session);
      if (session && session.user) {
        linkPushSubscriptionToUser(session.user.id);
        syncWatchlistToSupabase();
        renderMyReports(session.user.id);
      }
    });
    // Initial paint, in case a session already exists in this browser.
    supabaseClient.auth.getSession().then(({ data }) => {
      renderAccountScreen(data.session);
      if (data.session && data.session.user) {
        linkPushSubscriptionToUser(data.session.user.id);
        syncWatchlistToSupabase();
        renderMyReports(data.session.user.id);
      }
    });
  }

  function init() {
    // header sync line
    document.getElementById("data-sync-line").textContent = `Sample data as of ${DATA_LAST_SYNCED}`;

    // Returning from Stripe Checkout — show a quick status and clean the
    // URL so a page refresh doesn't re-trigger this.
    const checkoutParam = new URLSearchParams(window.location.search).get("checkout");
    if (checkoutParam === "success" || checkoutParam === "cancelled") {
      switchTab("account");
      const statusEl = document.getElementById("checkout-status");
      if (statusEl) {
        statusEl.textContent =
          checkoutParam === "success"
            ? "Payment received — thank you!"
            : "Checkout cancelled — no charge was made.";
      }
      window.history.replaceState({}, "", window.location.pathname);
      if (checkoutParam === "success") {
        setTimeout(() => {
          supabaseClient.auth.getSession().then(({ data }) => {
            if (data.session) renderMyReports(data.session.user.id);
          });
        }, 4000);
      }
    }

    populateCategoryChips();
    renderWatchlist();
    renderSearch();
    checkForChangesSinceLastVisit();

    // Tab bar
    document.querySelectorAll(".tab-bar__btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    initAccount();

    // Delegate ledger row / action clicks (watchlist + search screens)
    document.body.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (actionEl) {
        e.stopPropagation();
        toggleWatch(actionEl.dataset.id, actionEl.dataset.action);
        return;
      }
      const rowEl = e.target.closest("[data-open]");
      if (rowEl) {
        openSheet(rowEl.dataset.open);
      }
    });

    // Sheet controls
    document.getElementById("sheet-backdrop").addEventListener("click", closeSheet);
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    document.getElementById("sheet-watch-btn").addEventListener("click", (e) => {
      toggleWatch(e.target.dataset.id, e.target.dataset.action);
    });
    document.getElementById("sheet-calc-btn").addEventListener("click", (e) => {
      fillCalculatorFromItem(e.target.dataset.id);
      closeSheet();
    });

    // Search controls
    document.getElementById("search-input").addEventListener("input", (e) => {
      state.search.q = e.target.value;
      renderSearch();
    });
    document.querySelectorAll(".search-direction .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".search-direction .chip").forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        state.search.direction = chip.dataset.dir;
        renderSearch();
      });
    });
    document.getElementById("search-categories").addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      document.querySelectorAll("#search-categories .chip").forEach((c) => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      state.search.category = chip.dataset.cat;
      renderSearch();
    });

    // Calculator controls
    document.querySelectorAll(".direction-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".direction-toggle button").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        document.getElementById("calc-ocean-row").style.display = btn.dataset.dir === "ca_to_us" ? "flex" : "none";
        document.getElementById("calc-gst-note").style.display = btn.dataset.dir === "us_to_ca" ? "block" : "none";
        renderCalc();
      });
    });
    ["calc-value", "calc-rate", "calc-extra-rate", "calc-freight", "calc-insurance"].forEach((id) => {
      document.getElementById(id).addEventListener("input", renderCalc);
    });
    document.getElementById("calc-ocean").addEventListener("change", renderCalc);

    // Alert banner dismiss
    document.getElementById("alert-banner-dismiss").addEventListener("click", () => {
      document.getElementById("alert-banner").style.display = "none";
    });

    // Install strip
    const installStrip = document.getElementById("install-strip");
    document.getElementById("install-btn").addEventListener("click", async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice;
        deferredInstallPrompt = null;
        installStrip.classList.remove("is-visible");
      }
    });
    document.getElementById("install-dismiss").addEventListener("click", () => {
      installStrip.classList.remove("is-visible");
      sessionStorage.setItem("tw_install_dismissed", "1");
    });
    if (isIOS() && !window.navigator.standalone && !sessionStorage.getItem("tw_install_dismissed")) {
      document.getElementById("install-btn").style.display = "none";
      document.getElementById("install-text").textContent =
        "Add Tariff Watch to your Home Screen: tap Share, then \u201cAdd to Home Screen.\u201d";
      installStrip.classList.add("is-visible");
    }

    // Notify strip
    document.getElementById("notify-enable-btn").addEventListener("click", () => {
      const action = document.getElementById("notify-enable-btn").dataset.action;
      if (action === "disable") disablePush();
      else enablePush();
    });
    document.getElementById("notify-dismiss").addEventListener("click", () => {
      document.getElementById("notify-strip").classList.remove("is-visible");
      sessionStorage.setItem("tw_notify_dismissed", "1");
    });
    updateNotifyStrip();

    // Service worker
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        navigator.serviceWorker.register("service-worker.js").catch(() => {
          /* registration can fail inside sandboxed preview iframes — app still works */
        });
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
