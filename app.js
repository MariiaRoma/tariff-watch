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
  const LS_NOTIFICATION_MODE = "tw_notification_mode_v1";
  const LS_NOTIFY_THRESHOLD = "tw_notify_threshold_v1";

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
  const PRICE_BULK_CALC = "price_1UDrxf2XFD9iubrBNqbsGydu";
  const PRICE_WHITE_LABEL = "price_1UDsw32XFD9iubrBhywOnL5b";
  let bulkParsedRows = [];

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
  // A small, diverse starter set for the empty-watchlist state — one
  // item from each of a few different categories, so a first-time
  // visitor has something concrete to tap instead of a blank list and
  // an empty search box.
  function getOnboardingSuggestions() {
    const seenCategories = new Set();
    const picks = [];
    for (const item of TARIFF_DATA) {
      if (seenCategories.has(item.category)) continue;
      seenCategories.add(item.category);
      picks.push(item);
      if (picks.length >= 3) break;
    }
    return picks;
  }

  function renderWatchlist() {
    const root = document.getElementById("watchlist-list");
    const items = [...state.watchlist].map(byId).filter(Boolean);
    document.getElementById("watchlist-count").textContent = items.length
      ? `${items.length} tracked`
      : "";

    if (!items.length) {
      const suggestions = getOnboardingSuggestions();
      root.innerHTML = `
        <div class="ledger-empty">
          <strong>No codes on watch yet</strong>
          Add a few to get started — Tariff Watch flags anything here whenever its rate moves.
        </div>
        ${
          suggestions.length
            ? `<p class="field-hint" style="padding:0 20px 6px;">A few to try:</p><div class="ledger">${suggestions
                .map((it) => ledgerRow(it, { showAction: true }))
                .join("")}</div>`
            : ""
        }`;
      return;
    }

    items.sort((a, b) => (a.changeDate || "") < (b.changeDate || "") ? 1 : -1);
    root.innerHTML = `<div class="ledger">${items.map((it) => ledgerRow(it, { showAction: true })).join("")}</div>`;
  }

  // Feed of every rate change in the dataset, regardless of whether the
  // person is tracking that code — surfaces market-wide movement even
  // on a brand-new, empty watchlist. Capped so this stays a quick scan,
  // not a second copy of the full Search list.
  function renderRecentChanges() {
    const root = document.getElementById("recent-changes-feed");
    if (!root) return;
    const changed = TARIFF_DATA.filter((item) => item.priorRate != null && item.priorRate !== item.rate);
    changed.sort((a, b) => ((a.changeDate || a.effectiveDate || "") < (b.changeDate || b.effectiveDate || "") ? 1 : -1));
    const recent = changed.slice(0, 20);

    if (!recent.length) {
      root.innerHTML = `
        <div class="ledger-empty">
          <strong>No rate changes recorded yet</strong>
          Once a synced code's rate moves, it'll show up here first.
        </div>`;
      return;
    }
    root.innerHTML = `<div class="ledger">${recent.map((it) => ledgerRow(it, { showAction: true })).join("")}</div>`;
  }

  // ------------------------------------------------------------------
  // Search screen
  // ------------------------------------------------------------------
  function populateCategoryChips() {
    const wrap = document.getElementById("search-categories");
    const dir = state.search.direction;
    const q = state.search.q.trim().toLowerCase();

    // Counts reflect whatever direction/text filter is already active, so
    // a chip's number always answers "how many results if I tap this?" —
    // not just a static total that ignores what's currently on screen.
    const matchesFilters = (item) => {
      if (dir !== "all" && item.direction !== dir) return false;
      if (!q) return true;
      return (
        item.hs.toLowerCase().includes(q) ||
        item.desc.toLowerCase().includes(q) ||
        item.category.toLowerCase().includes(q)
      );
    };

    const totalCount = TARIFF_DATA.filter(matchesFilters).length;
    const chips = ["all", ...ALL_CATEGORIES];
    wrap.innerHTML = chips
      .map((c) => {
        const count = c === "all" ? totalCount : TARIFF_DATA.filter((item) => item.category === c && matchesFilters(item)).length;
        const label = c === "all" ? `All categories (${totalCount})` : `${c} (${count})`;
        return `<button class="chip ${state.search.category === c ? "is-active" : ""}" data-cat="${c}">${label}</button>`;
      })
      .join("");

    const datalist = document.getElementById("category-suggestions");
    if (datalist && !datalist.childElementCount) {
      // Static list — categories don't change at runtime, so this only
      // needs to run once even though populateCategoryChips() re-runs
      // on every keystroke/direction change.
      datalist.innerHTML = ALL_CATEGORIES.map((c) => `<option value="${c}"></option>`).join("");
    }
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

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Matches loosely — the person might paste our internal id
  // ("ca-0402-10-20"), the plain HS number ("0402.10.20"), or the same
  // digits with different punctuation/spacing ("0402 10 20").
  function findTariffByLooseCode(raw) {
    const clean = raw.trim();
    if (!clean) return null;
    let found = TARIFF_DATA.find((d) => d.id.toLowerCase() === clean.toLowerCase());
    if (found) return found;
    found = TARIFF_DATA.find((d) => d.hs.toLowerCase() === clean.toLowerCase());
    if (found) return found;
    const digitsOnly = clean.replace(/[^0-9]/g, "");
    if (digitsOnly) {
      found = TARIFF_DATA.find((d) => d.hs.replace(/[^0-9]/g, "") === digitsOnly);
      if (found) return found;
    }
    return null;
  }

  function runBulkLookup() {
    const raw = document.getElementById("bulk-lookup-input").value;
    const codes = raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const resultsEl = document.getElementById("bulk-lookup-results");

    if (!codes.length) {
      resultsEl.innerHTML = "";
      return;
    }

    const matched = [];
    const unmatched = [];
    const seen = new Set();
    codes.forEach((c) => {
      const item = findTariffByLooseCode(c);
      if (item) {
        if (!seen.has(item.id)) {
          matched.push(item);
          seen.add(item.id);
        }
      } else {
        unmatched.push(c);
      }
    });

    let html = `<p class="field-hint">${matched.length} matched · ${unmatched.length} not found</p>`;
    if (matched.length) {
      html += `<div class="ledger">${matched.map((it) => ledgerRow(it, { showAction: true })).join("")}</div>`;
    }
    if (unmatched.length) {
      html += `<div class="ledger-empty"><strong>Not found:</strong> ${unmatched.map(escapeHtml).join(", ")}</div>`;
    }
    resultsEl.innerHTML = html;
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

    const sourceUrl =
      item.direction === "us_to_ca"
        ? "https://www.canada.ca/en/department-finance/programs/international-trade-finance-policy/canadas-response-us-tariffs/complete-list-us-products-subject-to-counter-tariffs.html"
        : "https://hts.usitc.gov";
    const sourceLabel = item.direction === "us_to_ca" ? "Finance Canada" : "USITC";

    const rows = [
      ["Current rate", `${item.rate}%`],
      ["Category", item.category],
      ["Effective", dateFmt(item.changeDate || item.effectiveDate)],
      ["Legal basis", item.legalBasis],
      ["Data confidence", item.verified ? "From official published list" : "Representative sample — confirm exact HS line"],
      ["Last verified", `${DATA_LAST_SYNCED} · <a href="${sourceUrl}" target="_blank" rel="noopener">${sourceLabel} source ↗</a>`],
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
    renderRecentChanges();
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
      direction: document.querySelector("#screen-calculator .direction-toggle button.is-active").dataset.dir,
      value: parseFloat(document.getElementById("calc-value").value) || 0,
      rate: parseFloat(document.getElementById("calc-rate").value) || 0,
      extraRate: parseFloat(document.getElementById("calc-extra-rate").value) || 0,
      freight: parseFloat(document.getElementById("calc-freight").value) || 0,
      insurance: parseFloat(document.getElementById("calc-insurance").value) || 0,
      ocean: document.getElementById("calc-ocean").checked,
    };
  }

  const LS_CALC_SCENARIOS = "tw_calc_scenarios_v1";

  function loadScenarios() {
    return loadJSON(LS_CALC_SCENARIOS, []);
  }

  function saveScenariosList(list) {
    saveJSON(LS_CALC_SCENARIOS, list);
  }

  function saveCurrentScenario() {
    const s = calcState();
    if (!s.value) {
      window.alert("Enter a customs value first — there's nothing to save yet.");
      return;
    }
    const name = window.prompt("Name this scenario (e.g. \"Furniture shipment from Toronto\"):");
    if (!name || !name.trim()) return;
    const scenarios = loadScenarios();
    scenarios.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: name.trim(),
      ...s,
      savedAt: new Date().toISOString(),
    });
    saveScenariosList(scenarios);
    renderScenariosList();
  }

  function loadScenarioIntoForm(id) {
    const scenario = loadScenarios().find((sc) => sc.id === id);
    if (!scenario) return;
    document.querySelectorAll("#screen-calculator .direction-toggle button").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.dir === scenario.direction);
    });
    document.getElementById("calc-ocean-row").style.display = scenario.direction === "ca_to_us" ? "flex" : "none";
    document.getElementById("calc-gst-note").style.display = scenario.direction === "us_to_ca" ? "block" : "none";
    document.getElementById("calc-value").value = scenario.value || "";
    document.getElementById("calc-rate").value = scenario.rate || "";
    document.getElementById("calc-extra-rate").value = scenario.extraRate || "";
    document.getElementById("calc-freight").value = scenario.freight || "";
    document.getElementById("calc-insurance").value = scenario.insurance || "";
    document.getElementById("calc-ocean").checked = !!scenario.ocean;
    renderCalc();
  }

  function deleteScenario(id) {
    saveScenariosList(loadScenarios().filter((sc) => sc.id !== id));
    renderScenariosList();
  }

  function renderScenariosList() {
    const root = document.getElementById("calc-scenarios-list");
    if (!root) return;
    const scenarios = loadScenarios();
    if (!scenarios.length) {
      root.innerHTML = "";
      return;
    }
    root.innerHTML = scenarios
      .map((sc) => {
        const dirLabel = sc.direction === "us_to_ca" ? "US → CA" : "CA → US";
        return `
        <div class="scenario-row">
          <div class="scenario-row__info">
            <div class="scenario-row__name">${escapeHtml(sc.name)}</div>
            <div class="scenario-row__meta">${money(sc.value, sc.direction === "us_to_ca" ? "CAD" : "USD")} · ${sc.rate}% · ${dirLabel}</div>
          </div>
          <button type="button" class="scenario-row__load" data-scenario-load="${sc.id}">Load</button>
          <button type="button" class="scenario-row__delete" data-scenario-delete="${sc.id}" aria-label="Delete">✕</button>
        </div>`;
      })
      .join("");
  }

  // ------------------------------------------------------------------
  // SKU → HS code mapping
  // ------------------------------------------------------------------
  async function addSkuMapping() {
    const statusEl = document.getElementById("sku-status");
    const skuInput = document.getElementById("sku-input");
    const hsInput = document.getElementById("sku-hs-input");
    const sku = skuInput.value.trim();
    const hsRaw = hsInput.value.trim();

    if (!sku || !hsRaw) {
      statusEl.textContent = "Enter both a SKU/name and an HS code.";
      return;
    }
    const matched = findTariffByLooseCode(hsRaw);
    if (!matched) {
      statusEl.textContent = `"${hsRaw}" doesn't match any code in the database — check the format and try again.`;
      return;
    }

    try {
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      if (!session) {
        statusEl.textContent = "Please sign in first.";
        return;
      }
      const { error } = await supabaseClient.from("sku_mappings").insert({
        user_id: session.user.id,
        sku,
        hs_code: matched.id,
      });
      if (error) throw error;
      skuInput.value = "";
      hsInput.value = "";
      statusEl.textContent = "Added.";
      renderSkuMappings(session.user.id);
    } catch (e) {
      statusEl.textContent = `Error: ${e.message || "Could not save mapping"}`;
    }
  }

  async function deleteSkuMapping(id, userId) {
    try {
      await supabaseClient.from("sku_mappings").delete().eq("id", id);
      renderSkuMappings(userId);
    } catch (e) {
      /* best effort */
    }
  }

  async function renderSkuMappings(userId) {
    const root = document.getElementById("sku-mappings-list");
    if (!root || !userId) return;
    try {
      const { data: mappings, error } = await supabaseClient
        .from("sku_mappings")
        .select("id, sku, hs_code")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error || !mappings || mappings.length === 0) {
        root.innerHTML = "";
        return;
      }
      root.innerHTML = mappings
        .map((m) => {
          const item = byId(m.hs_code);
          const hsLabel = item ? `${item.hs} — ${item.desc}` : m.hs_code;
          return `
          <div class="scenario-row">
            <div class="scenario-row__info" ${item ? `data-open="${item.id}"` : ""}>
              <div class="scenario-row__name">${escapeHtml(m.sku)}</div>
              <div class="scenario-row__meta">${escapeHtml(hsLabel)}</div>
            </div>
            <button type="button" class="scenario-row__delete" data-sku-delete="${m.id}" aria-label="Delete">✕</button>
          </div>`;
        })
        .join("");
    } catch (e) {
      /* best effort */
    }
  }

  // ------------------------------------------------------------------
  // Shared (team) watchlist
  // ------------------------------------------------------------------
  async function shareWatchlist() {
    const statusEl = document.getElementById("share-watchlist-status");
    try {
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      if (!session) {
        statusEl.textContent = "Sign in first (Account tab) to get a share link for your watchlist.";
        return;
      }
      await syncWatchlistToSupabase(); // make sure the shared copy is current before generating a link
      const { data: existing } = await supabaseClient
        .from("watchlists")
        .select("share_token")
        .eq("user_id", session.user.id)
        .maybeSingle();

      let token = existing?.share_token;
      if (!token) {
        token = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const { error } = await supabaseClient.from("watchlists").update({ share_token: token }).eq("user_id", session.user.id);
        if (error) throw error;
      }

      const url = `${window.location.origin}/?share=${token}`;

      if (navigator.share) {
        try {
          await navigator.share({
            title: "My Tariff Watch watchlist",
            text: "Here's the HS codes I'm tracking on Tariff Watch:",
            url,
          });
        } catch (e) {
          if (e?.name === "AbortError") return; // person closed the share sheet — not an error
          throw e;
        }
      } else {
        // No Web Share support (mostly older desktop browsers) — a
        // plain link is the only option left.
        statusEl.innerHTML = `Share link: <a href="${url}">${url}</a>`;
        return;
      }

      statusEl.innerHTML = `Shared ✓ — <a href="#" id="stop-sharing-link">stop sharing</a>`;
      const stopLink = document.getElementById("stop-sharing-link");
      if (stopLink) {
        stopLink.addEventListener("click", async (e) => {
          e.preventDefault();
          await supabaseClient.from("watchlists").update({ share_token: null }).eq("user_id", session.user.id);
          statusEl.textContent = "Sharing turned off.";
        });
      }
    } catch (e) {
      statusEl.textContent = `Error: ${e.message || "Could not create a share link"}`;
    }
  }

  // Checks the URL for ?share=TOKEN on load. If present and valid, shows
  // a read-only view of that watchlist instead of the normal app — no
  // login needed, so a colleague can open the link directly.
  async function checkForSharedView() {
    const token = new URLSearchParams(window.location.search).get("share");
    if (!token) return false;

    const sharedRoot = document.getElementById("shared-view");
    const mainEl = document.getElementById("app-main");
    const tabBar = document.querySelector(".tab-bar");
    const notifyStrip = document.getElementById("notify-strip");

    try {
      const { data: watchlistRow, error } = await supabaseClient
        .from("watchlists")
        .select("name, hs_codes")
        .eq("share_token", token)
        .maybeSingle();

      if (error || !watchlistRow) {
        sharedRoot.innerHTML = `
          <div class="section-head"><h2>Link not found</h2></div>
          <p class="section-intro">This share link is invalid or sharing was turned off. <a href="/">Open Tariff Watch</a> instead.</p>`;
      } else {
        const items = (watchlistRow.hs_codes || []).map(byId).filter(Boolean);
        const rows = items.length
          ? `<div class="ledger">${items.map((it) => ledgerRow(it, { showAction: false })).join("")}</div>`
          : `<div class="ledger-empty"><strong>This watchlist is empty.</strong></div>`;
        sharedRoot.innerHTML = `
          <div class="section-head"><h2>${escapeHtml(watchlistRow.name || "Shared watchlist")}</h2></div>
          <p class="section-intro">A read-only, shared view — ${items.length} code${items.length === 1 ? "" : "s"} tracked. <a href="/">Open Tariff Watch</a> to track your own.</p>
          ${rows}`;
      }
    } catch (e) {
      sharedRoot.innerHTML = `
        <div class="section-head"><h2>Something went wrong</h2></div>
        <p class="section-intro">Couldn't load this shared watchlist right now. <a href="/">Open Tariff Watch</a> instead.</p>`;
    }

    if (mainEl) mainEl.style.display = "none";
    if (tabBar) tabBar.style.display = "none";
    if (notifyStrip) notifyStrip.classList.remove("is-visible");
    sharedRoot.style.display = "block";
    return true;
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
    document.querySelectorAll("#screen-calculator .direction-toggle button").forEach((b) => {
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
        body: JSON.stringify({
          subscription: sub.toJSON(),
          watchlist: [...state.watchlist],
          notificationMode: loadJSON(LS_NOTIFICATION_MODE, "instant"),
          threshold: loadJSON(LS_NOTIFY_THRESHOLD, 0),
        }),
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

  async function applyNotificationSettings() {
    const modeSelect = document.getElementById("notify-mode-select");
    const thresholdSelect = document.getElementById("notify-threshold-select");
    const mode = modeSelect ? modeSelect.value : "instant";
    const threshold = thresholdSelect ? Number(thresholdSelect.value) : 0;
    const prevMode = loadJSON(LS_NOTIFICATION_MODE, "instant");
    const prevThreshold = loadJSON(LS_NOTIFY_THRESHOLD, 0);
    saveJSON(LS_NOTIFICATION_MODE, mode);
    saveJSON(LS_NOTIFY_THRESHOLD, threshold);

    if (!pushSupported() || Notification.permission !== "granted") return;
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) {
        // Local state says push is on, but the browser doesn't actually
        // have a live subscription right now (can happen after a stale
        // reload, or if it silently expired) — recreate it so there's
        // something for these settings to attach to, instead of quietly
        // doing nothing and leaving the old server-side record unchanged.
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        });
      }
      await postSubscription(sub);
    } catch (e) {
      saveJSON(LS_NOTIFICATION_MODE, prevMode);
      saveJSON(LS_NOTIFY_THRESHOLD, prevThreshold);
      if (modeSelect) modeSelect.value = prevMode;
      if (thresholdSelect) thresholdSelect.value = prevThreshold;
      window.alert("Couldn't update notification settings — please try again, or turn notifications off and back on.");
    }
  }

  function updateNotifyStrip() {
    const strip = document.getElementById("notify-strip");
    const text = document.getElementById("notify-text");
    const btn = document.getElementById("notify-enable-btn");
    const modeSelect = document.getElementById("notify-mode-select");
    const thresholdSelect = document.getElementById("notify-threshold-select");
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
      if (modeSelect) {
        modeSelect.style.display = "inline-block";
        modeSelect.value = loadJSON(LS_NOTIFICATION_MODE, "instant");
      }
      if (thresholdSelect) {
        thresholdSelect.style.display = "inline-block";
        thresholdSelect.value = loadJSON(LS_NOTIFY_THRESHOLD, 0);
      }
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
      if (modeSelect) modeSelect.style.display = "none";
      if (thresholdSelect) thresholdSelect.style.display = "none";
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
        body: JSON.stringify({ priceId: PRICE_EXPOSURE_REPORT, product: "exposure_pdf" }),
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

  // Blobs referenced by the currently rendered "My reports" list — kept
  // in JS memory (not on the DOM) since a blob: URL is only valid within
  // the page realm that created it, and Web Share/File System Access
  // need the raw Blob/File, not just a URL string.
  const reportBlobs = new Map();
  const REPORT_FILENAME = "tariff-watch-report.pdf";

  function openReportView(reportId) {
    const blob = reportBlobs.get(reportId);
    if (!blob) return;
    // Same-tab navigation (not a new tab/window) keeps the blob: URL
    // valid, since it never leaves this page's JS realm — opening a new
    // tab/window from an installed PWA can hand off to a different
    // browser process where the blob: reference doesn't exist.
    window.location.href = URL.createObjectURL(blob);
  }

  async function saveReport(reportId) {
    const blob = reportBlobs.get(reportId);
    if (!blob) return;
    // File System Access API — lets the person pick exactly where to
    // save (supported on desktop Chrome/Edge and newer Android Chrome).
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: REPORT_FILENAME,
          types: [{ description: "PDF", accept: { "application/pdf": [".pdf"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return;
      } catch (e) {
        if (e?.name === "AbortError") return; // person cancelled the picker — don't also trigger the fallback
      }
    }
    // Fallback: classic browser download link. Works in an ordinary
    // browser tab and on desktop; unreliable in some installed-PWA
    // contexts on mobile — Share is the more reliable option there.
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = REPORT_FILENAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function shareReport(reportId) {
    const blob = reportBlobs.get(reportId);
    if (!blob) return;
    const file = new File([blob], REPORT_FILENAME, { type: "application/pdf" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: "Tariff Watch Report" });
      } catch (e) {
        /* person cancelled the share sheet — nothing else to do */
      }
    } else {
      // No Web Share support on this browser — same-tab open is the
      // safest remaining option (see openReportView for why not a new tab).
      window.location.href = URL.createObjectURL(blob);
    }
  }

  function reportTypeLabel(type) {
    return { exposure_pdf: "Tariff Exposure Report", bulk_calc: "Bulk Landed-Cost Report" }[type] || type;
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
            return `<div class="field-hint">${date} — ${reportTypeLabel(p.report_type)}: preparing…</div>`;
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
            reportBlobs.set(p.id, blob);
            const savedNote = navigator.onLine ? "" : " (saved on this device)";
            return `<div class="field-hint">${date} — ${reportTypeLabel(p.report_type)}${savedNote}<br>
              <a href="#" data-report-action="open" data-report-id="${p.id}">Open</a> ·
              <a href="#" data-report-action="save" data-report-id="${p.id}">Save</a> ·
              <a href="#" data-report-action="share" data-report-id="${p.id}">Share</a>
            </div>`;
          }
          return `<div class="field-hint">${date} — ${reportTypeLabel(p.report_type)}: <em>${navigator.onLine ? "unavailable right now" : "offline — connect to download once, then it's saved"}</em></div>`;
        })
      );
      container.innerHTML =
        `<div class="section-head" style="margin-top:24px;"><h2>My reports</h2></div>` + rows.join("");
      container.querySelectorAll("[data-report-action]").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.preventDefault();
          const id = el.dataset.reportId;
          const action = el.dataset.reportAction;
          if (action === "open") openReportView(id);
          else if (action === "save") saveReport(id);
          else if (action === "share") shareReport(id);
        });
      });
    } catch (e) {
      /* best effort */
    }
  }

  function initBulkCalculator() {
    document.querySelectorAll("#screen-account [data-bulk-dir]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#screen-account [data-bulk-dir]").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        document.getElementById("bulk-ocean-row").style.display = btn.dataset.bulkDir === "ca_to_us" ? "flex" : "none";
      });
    });

    document.getElementById("bulk-csv-file").addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const isExcel = /\.(xlsx|xls)$/i.test(file.name);
      if (isExcel) {
        const reader = new FileReader();
        reader.onload = (evt) => {
          try {
            const workbook = XLSX.read(evt.target.result, { type: "array" });
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
            const rawRows = XLSX.utils.sheet_to_json(firstSheet, { defval: "" });
            processBulkRows(rawRows);
          } catch (err) {
            showBulkParseError("Couldn't read that Excel file — make sure it's a valid .xlsx or .xls.");
          }
        };
        reader.onerror = () => showBulkParseError("Couldn't read that file.");
        reader.readAsArrayBuffer(file);
      } else {
        Papa.parse(file, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => processBulkRows(results.data),
          error: () => showBulkParseError("Couldn't read that file — make sure it's a valid CSV."),
        });
      }
    });

    document.getElementById("buy-bulk-calc").addEventListener("click", buyBulkCalc);
  }

  function showBulkParseError(message) {
    document.getElementById("bulk-preview").innerHTML = `<p class="field-hint">${message}</p>`;
    document.getElementById("buy-bulk-calc").style.display = "none";
  }

  // Shared by both the CSV (PapaParse) and Excel (SheetJS) paths — both
  // produce the same shape: an array of plain row objects keyed by
  // column header, before any type coercion or validation.
  function processBulkRows(rawRows) {
    const previewEl = document.getElementById("bulk-preview");
    const buyBtn = document.getElementById("buy-bulk-calc");
    const rows = rawRows
      .map((r) => ({
        hs_code: String(r.hs_code ?? "").trim(),
        quantity: parseFloat(r.quantity),
        unit_value: parseFloat(r.unit_value),
        freight: parseFloat(r.freight) || 0,
        insurance: parseFloat(r.insurance) || 0,
      }))
      .filter((r) => r.hs_code && !isNaN(r.quantity) && !isNaN(r.unit_value));

    const matched = rows.filter((r) => byId(r.hs_code)).length;
    const skipped = rawRows.length - rows.length;
    bulkParsedRows = rows;

    if (rows.length === 0) {
      previewEl.innerHTML = `<p class="field-hint">No valid rows found — check that your file has hs_code, quantity, and unit_value columns.</p>`;
      buyBtn.style.display = "none";
      return;
    }
    previewEl.innerHTML = `<p class="field-hint">${rows.length} row(s) ready · ${matched} match known HS codes${
      skipped ? ` · ${skipped} row(s) skipped (missing data)` : ""
    }</p>`;
    buyBtn.style.display = "block";
  }

  async function buyBulkCalc() {
    const statusEl = document.getElementById("bulk-status");
    if (bulkParsedRows.length === 0) return;
    statusEl.textContent = "Preparing...";
    try {
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      if (!session) {
        statusEl.textContent = "Please sign in first.";
        return;
      }
      const direction = document.querySelector("#screen-account [data-bulk-dir].is-active").dataset.bulkDir;
      const oceanFreight = document.getElementById("bulk-ocean").checked;

      const { data: bulkRow, error: insertError } = await supabaseClient
        .from("bulk_calculations")
        .insert({ user_id: session.user.id, direction, ocean_freight: oceanFreight, rows: bulkParsedRows })
        .select()
        .single();

      if (insertError || !bulkRow) {
        statusEl.textContent = `Error: ${insertError?.message || "Could not save calculation"}`;
        return;
      }

      statusEl.textContent = "Redirecting to checkout...";
      const res = await fetch("/.netlify/functions/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ priceId: PRICE_BULK_CALC, product: "bulk_calc", refId: bulkRow.id }),
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
  // White-Label branding (subscription)
  // ------------------------------------------------------------------
  async function refreshSubscriptionUI(userId) {
    try {
      const { data: profile } = await supabaseClient
        .from("profiles")
        .select("subscription_status")
        .eq("id", userId)
        .maybeSingle();
      const isActive = profile?.subscription_status === "active";
      document.getElementById("whitelabel-not-subscribed").style.display = isActive ? "none" : "block";
      document.getElementById("whitelabel-subscribed").style.display = isActive ? "block" : "none";
      if (isActive) await loadBrandSettingsForm(userId);
    } catch (e) {
      /* best effort */
    }
  }

  async function loadBrandSettingsForm(userId) {
    try {
      const { data: brand } = await supabaseClient.from("brand_settings").select("*").eq("user_id", userId).maybeSingle();
      if (!brand) return;
      document.getElementById("brand-company-name").value = brand.company_name || "";
      document.getElementById("brand-accent-color").value = brand.accent_color || "#1c2951";
      document.getElementById("brand-address").value = brand.address || "";
      document.getElementById("brand-phone").value = brand.phone || "";
      document.getElementById("brand-email").value = brand.email || "";
      document.getElementById("brand-contact-person").value = brand.contact_person || "";
    } catch (e) {
      /* best effort */
    }
  }

  async function subscribeWhiteLabel() {
    const statusEl = document.getElementById("brand-status");
    try {
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      if (!session) {
        statusEl.textContent = "Please sign in first.";
        return;
      }
      const res = await fetch("/.netlify/functions/create-checkout-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ priceId: PRICE_WHITE_LABEL, product: "white_label" }),
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

  async function saveBrandSettings() {
    const statusEl = document.getElementById("brand-status");
    statusEl.textContent = "Saving...";
    try {
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      if (!session) {
        statusEl.textContent = "Please sign in first.";
        return;
      }

      const update = {
        user_id: session.user.id,
        company_name: document.getElementById("brand-company-name").value.trim(),
        accent_color: document.getElementById("brand-accent-color").value,
        address: document.getElementById("brand-address").value.trim(),
        phone: document.getElementById("brand-phone").value.trim(),
        email: document.getElementById("brand-email").value.trim(),
        contact_person: document.getElementById("brand-contact-person").value.trim(),
      };

      const fileInput = document.getElementById("brand-logo-file");
      if (fileInput.files[0]) {
        const file = fileInput.files[0];
        const ext = file.name.split(".").pop().toLowerCase();
        const path = `${session.user.id}/logo.${ext}`;
        const { error: uploadError } = await supabaseClient.storage.from("logos").upload(path, file, { upsert: true });
        if (uploadError) throw uploadError;
        update.logo_url = path;
      }

      const { error } = await supabaseClient.from("brand_settings").upsert(update, { onConflict: "user_id" });
      if (error) throw error;
      statusEl.textContent = "Saved.";
    } catch (e) {
      statusEl.textContent = `Error: ${e.message || "Could not save branding"}`;
    }
  }

  async function manageSubscription() {
    const statusEl = document.getElementById("brand-status");
    try {
      const { data } = await supabaseClient.auth.getSession();
      const session = data.session;
      if (!session) {
        statusEl.textContent = "Please sign in first.";
        return;
      }
      const res = await fetch("/.netlify/functions/create-portal-session", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const payload = await res.json();
      if (!res.ok || !payload.url) {
        statusEl.textContent = `Error: ${payload.error || "Could not open subscription management"}`;
        return;
      }
      window.location.href = payload.url;
    } catch (e) {
      statusEl.textContent = "Something went wrong — please try again.";
    }
  }

  function initAccount() {
    document.getElementById("account-send-link").addEventListener("click", () => {
      const email = document.getElementById("account-email").value.trim();
      if (email) sendMagicLink(email);
    });
    document.getElementById("account-sign-out").addEventListener("click", signOutAccount);
    document.getElementById("buy-exposure-report").addEventListener("click", buyExposureReport);
    initBulkCalculator();
    document.getElementById("subscribe-white-label").addEventListener("click", subscribeWhiteLabel);
    document.getElementById("save-brand-settings").addEventListener("click", saveBrandSettings);
    document.getElementById("manage-subscription").addEventListener("click", manageSubscription);
    document.getElementById("sku-add-btn").addEventListener("click", addSkuMapping);
    document.getElementById("share-watchlist-btn").addEventListener("click", shareWatchlist);

    // Fires on sign-in, sign-out, and token refresh — including right
    // after the person clicks the magic link and lands back here.
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      renderAccountScreen(session);
      if (session && session.user) {
        linkPushSubscriptionToUser(session.user.id);
        syncWatchlistToSupabase();
        renderMyReports(session.user.id);
        refreshSubscriptionUI(session.user.id);
        renderSkuMappings(session.user.id);
      }
    });
    // Initial paint, in case a session already exists in this browser.
    supabaseClient.auth.getSession().then(({ data }) => {
      renderAccountScreen(data.session);
      if (data.session && data.session.user) {
        linkPushSubscriptionToUser(data.session.user.id);
        syncWatchlistToSupabase();
        renderMyReports(data.session.user.id);
        refreshSubscriptionUI(data.session.user.id);
        renderSkuMappings(data.session.user.id);
      }
    });
  }

  async function init() {
    // A shared-watchlist link (?share=TOKEN) shows a read-only view
    // instead of the normal app. Still let the rest of init() run
    // afterward (sheet open/close, etc.) — those handlers are what make
    // the read-only rows clickable, and they're harmless no-ops for
    // everything else that stays hidden behind it.
    await checkForSharedView();

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
    renderRecentChanges();
    renderScenariosList();
    checkForChangesSinceLastVisit();

    // Tab bar
    document.querySelectorAll(".tab-bar__btn").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    initAccount();
    document.getElementById("bulk-lookup-btn").addEventListener("click", runBulkLookup);
    document.getElementById("calc-save-scenario-btn").addEventListener("click", saveCurrentScenario);
    document.getElementById("bulk-lookup-toggle").addEventListener("click", () => {
      const panel = document.getElementById("bulk-lookup-panel");
      const toggle = document.getElementById("bulk-lookup-toggle");
      const isOpen = panel.style.display !== "none";
      panel.style.display = isOpen ? "none" : "block";
      toggle.textContent = isOpen ? "Look up multiple codes at once ▾" : "Look up multiple codes at once ▴";
    });

    // Delegate ledger row / action clicks (watchlist + search screens)
    document.body.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (actionEl) {
        e.stopPropagation();
        toggleWatch(actionEl.dataset.id, actionEl.dataset.action);
        return;
      }
      const loadEl = e.target.closest("[data-scenario-load]");
      if (loadEl) {
        loadScenarioIntoForm(loadEl.dataset.scenarioLoad);
        return;
      }
      const deleteEl = e.target.closest("[data-scenario-delete]");
      if (deleteEl) {
        deleteScenario(deleteEl.dataset.scenarioDelete);
        return;
      }
      const skuDeleteEl = e.target.closest("[data-sku-delete]");
      if (skuDeleteEl) {
        supabaseClient.auth.getSession().then(({ data }) => {
          if (data.session) deleteSkuMapping(skuDeleteEl.dataset.skuDelete, data.session.user.id);
        });
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
      populateCategoryChips();
    });
    document.querySelectorAll(".search-direction .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        document.querySelectorAll(".search-direction .chip").forEach((c) => c.classList.remove("is-active"));
        chip.classList.add("is-active");
        state.search.direction = chip.dataset.dir;
        renderSearch();
        populateCategoryChips();
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
    document.querySelectorAll("#screen-calculator .direction-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("#screen-calculator .direction-toggle button").forEach((b) => b.classList.remove("is-active"));
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
    document.getElementById("notify-mode-select").addEventListener("change", applyNotificationSettings);
    document.getElementById("notify-threshold-select").addEventListener("change", applyNotificationSettings);
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
