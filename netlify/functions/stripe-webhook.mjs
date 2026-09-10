// POST /.netlify/functions/stripe-webhook
// Called by Stripe itself (not the browser) whenever a subscribed event
// fires — currently just checkout.session.completed. Verifies the
// request really came from Stripe using the raw body + signing secret,
// then records the payment in Supabase.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { jsonResponse } from "./_shared.mjs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import tariffData from "../../data.json";

const TARIFF_BY_ID = new Map(tariffData.items.map((item) => [item.id, item]));

// pdf-lib's built-in standard fonts (Helvetica) only support the WinAnsi
// codepage — anything outside it throws at draw time instead of just
// rendering as a box. Checked every description in data.json: the only
// non-Latin-1 characters in use are ≤, ≥ (not in WinAnsi — replaced with
// ASCII) and em/en dashes (—, – — these ARE in WinAnsi, left as-is).
// The final regex is a safety net for anything not yet seen in the data.
function sanitizeForPdf(text) {
  return String(text || "")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/[^\x00-\xFF\u2013\u2014]/g, "?");
}

// Builds the "Tariff Exposure Report" PDF as raw bytes. Kept inline in
// this file (rather than a separate _report.mjs) because every .mjs
// file directly inside netlify/functions/ gets auto-registered as its
// own callable function — a helper with no HTTP handler then crashes
// if anything ever invokes it directly, as happened here.
// Turns a "#1c2951"-style color from the brand-settings color picker
// into the {r,g,b} 0-1 format pdf-lib's rgb() expects. Falls back to
// null (caller uses the default navy) for anything malformed.
function hexToRgb(hex) {
  if (!hex) return null;
  const clean = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return rgb(r, g, b);
}

const PAGE_SIZE = [612, 792]; // US Letter, points
const MARGIN = 50;
const ROW_HEIGHT = 20;
const HEADER_HEIGHT = 92;
const BRAND = rgb(0.11, 0.16, 0.32); // navy
const RATE_UP = rgb(0.72, 0.16, 0.16); // red — rate increased
const RATE_DOWN = rgb(0.13, 0.5, 0.27); // green — rate decreased
const ZEBRA = rgb(0.96, 0.96, 0.97);
const GRAY = rgb(0.45, 0.45, 0.45);
const WHITE = rgb(1, 1, 1);
const INK = rgb(0.13, 0.13, 0.15);

async function buildExposureReportPdf({ watchlistName, generatedAt, items, brand }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = [];
  let page;
  let y;

  const brandColor = hexToRgb(brand?.accent_color) || BRAND;
  const brandName = sanitizeForPdf(brand?.company_name) || "TARIFF WATCH";
  let logoImage = null;
  if (brand?.logoBytes) {
    try {
      logoImage = brand.logoType === "png" ? await pdfDoc.embedPng(brand.logoBytes) : await pdfDoc.embedJpg(brand.logoBytes);
    } catch (e) {
      /* corrupt or unsupported logo file — skip it rather than fail the whole report */
    }
  }

  function startPage(withBrandHeader) {
    page = pdfDoc.addPage(PAGE_SIZE);
    pages.push(page);
    if (withBrandHeader) {
      page.drawRectangle({ x: 0, y: PAGE_SIZE[1] - HEADER_HEIGHT, width: PAGE_SIZE[0], height: HEADER_HEIGHT, color: brandColor });
      if (logoImage) {
        const logoHeight = 42;
        const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
        page.drawImage(logoImage, { x: MARGIN, y: PAGE_SIZE[1] - HEADER_HEIGHT / 2 - logoHeight / 2, width: logoWidth, height: logoHeight });
        page.drawText("Tariff Exposure Report", { x: MARGIN + logoWidth + 16, y: PAGE_SIZE[1] - 55, size: 18, font: bold, color: WHITE });
      } else {
        page.drawText(brandName.toUpperCase(), { x: MARGIN, y: PAGE_SIZE[1] - 38, size: 11, font: bold, color: WHITE });
        page.drawText("Tariff Exposure Report", { x: MARGIN, y: PAGE_SIZE[1] - 62, size: 21, font: bold, color: WHITE });
      }
      y = PAGE_SIZE[1] - HEADER_HEIGHT - 28;
    } else {
      page.drawText("Tariff Exposure Report (continued)", { x: MARGIN, y: PAGE_SIZE[1] - MARGIN, size: 10, font: bold, color: GRAY });
      y = PAGE_SIZE[1] - MARGIN - 26;
    }
  }

  const ensureSpace = (needed) => {
    if (y - needed < MARGIN + 30) startPage(false);
  };

  startPage(true);

  page.drawText(sanitizeForPdf(`Watchlist: ${watchlistName || "My Watchlist"}`), { x: MARGIN, y, size: 11, font, color: INK });
  y -= 15;
  page.drawText(`Generated: ${generatedAt}`, { x: MARGIN, y, size: 9, font, color: GRAY });
  y -= 22;

  // Summary strip — the headline numbers before anyone has to read a row.
  const changed = items.filter((i) => i.priorRate != null && i.priorRate !== i.rate).length;
  const avgRate = items.length ? Math.round(items.reduce((s, i) => s + (i.rate || 0), 0) / items.length) : 0;
  const summary = `${items.length} HS code${items.length === 1 ? "" : "s"} tracked   |   ${changed} recently changed   |   ${avgRate}% average rate`;
  page.drawRectangle({ x: MARGIN, y: y - 22, width: PAGE_SIZE[0] - 2 * MARGIN, height: 28, color: ZEBRA });
  page.drawText(sanitizeForPdf(summary), { x: MARGIN + 10, y: y - 14, size: 10, font: bold, color: brandColor });
  y -= 50;

  if (items.length === 0) {
    page.drawText("No tracked HS codes were found on this watchlist.", { x: MARGIN, y, size: 11, font, color: INK });
  } else {
    const byCategory = new Map();
    for (const item of items) {
      const cat = item.category || "Other";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat).push(item);
    }

    let rowIndex = 0;
    for (const [category, catItems] of byCategory) {
      ensureSpace(40);
      page.drawText(sanitizeForPdf(category).toUpperCase(), { x: MARGIN, y, size: 9, font: bold, color: brandColor });
      y -= 5;
      page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_SIZE[0] - MARGIN, y }, thickness: 1, color: brandColor });
      y -= 17;

      for (const item of catItems) {
        ensureSpace(ROW_HEIGHT);
        if (rowIndex % 2 === 0) {
          page.drawRectangle({ x: MARGIN, y: y - 5, width: PAGE_SIZE[0] - 2 * MARGIN, height: ROW_HEIGHT, color: ZEBRA });
        }
        const desc = sanitizeForPdf(item.desc).slice(0, 44);
        page.drawText(item.hs || item.id, { x: MARGIN + 6, y, size: 9, font, color: INK });
        page.drawText(desc, { x: MARGIN + 95, y, size: 9, font, color: INK });

        let rateText = `${item.rate ?? "-"}%`;
        let rateColor = INK;
        if (item.priorRate != null && item.priorRate !== item.rate) {
          rateText = `${item.priorRate}% -> ${item.rate}%`;
          rateColor = item.rate > item.priorRate ? RATE_UP : RATE_DOWN;
        }
        page.drawText(sanitizeForPdf(rateText), { x: MARGIN + 340, y, size: 9, font: bold, color: rateColor });
        page.drawText(sanitizeForPdf(item.effectiveDate || "-"), { x: MARGIN + 445, y, size: 8, font, color: GRAY });

        y -= ROW_HEIGHT;
        rowIndex++;
      }
      y -= 10;
    }
  }

  const total = pages.length;
  const footerBrandLine = brand?.company_name
    ? `${sanitizeForPdf(brand.company_name)}${brand.contact_person ? "  ·  " + sanitizeForPdf(brand.contact_person) : ""}`
    : "Generated by Tariff Watch";
  const footerContactParts = [brand?.address, brand?.phone, brand?.email].filter(Boolean).map(sanitizeForPdf);

  pages.forEach((p, idx) => {
    p.drawLine({ start: { x: MARGIN, y: 38 }, end: { x: PAGE_SIZE[0] - MARGIN, y: 38 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    p.drawText(`${footerBrandLine}  -  Not legal or customs advice  -  verify with official sources`, {
      x: MARGIN, y: 26, size: 7, font, color: GRAY,
    });
    if (footerContactParts.length) {
      p.drawText(footerContactParts.join("   ·   "), { x: MARGIN, y: 15, size: 7, font, color: GRAY });
    }
    p.drawText(`Page ${idx + 1} of ${total}`, { x: PAGE_SIZE[0] - MARGIN - 55, y: 26, size: 7, font, color: GRAY });
  });

  return pdfDoc.save();
}

async function buildBulkCalcReportPdf({ generatedAt, direction, oceanFreight, rows, brand }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const pages = [];
  let page;
  let y;
  const currency = direction === "us_to_ca" ? "CAD" : "USD";
  const directionLabel =
    direction === "us_to_ca" ? "Importing into Canada (US -> CA)" : "Importing into the US (CA -> US)";

  const brandColor = hexToRgb(brand?.accent_color) || BRAND;
  const brandName = sanitizeForPdf(brand?.company_name) || "TARIFF WATCH";
  let logoImage = null;
  if (brand?.logoBytes) {
    try {
      logoImage = brand.logoType === "png" ? await pdfDoc.embedPng(brand.logoBytes) : await pdfDoc.embedJpg(brand.logoBytes);
    } catch (e) {
      /* corrupt or unsupported logo file — skip it rather than fail the whole report */
    }
  }

  function startPage(withBrandHeader) {
    page = pdfDoc.addPage(PAGE_SIZE);
    pages.push(page);
    if (withBrandHeader) {
      page.drawRectangle({ x: 0, y: PAGE_SIZE[1] - HEADER_HEIGHT, width: PAGE_SIZE[0], height: HEADER_HEIGHT, color: brandColor });
      if (logoImage) {
        const logoHeight = 42;
        const logoWidth = (logoImage.width / logoImage.height) * logoHeight;
        page.drawImage(logoImage, { x: MARGIN, y: PAGE_SIZE[1] - HEADER_HEIGHT / 2 - logoHeight / 2, width: logoWidth, height: logoHeight });
        page.drawText("Bulk Landed-Cost Report", { x: MARGIN + logoWidth + 16, y: PAGE_SIZE[1] - 55, size: 18, font: bold, color: WHITE });
      } else {
        page.drawText(brandName.toUpperCase(), { x: MARGIN, y: PAGE_SIZE[1] - 38, size: 11, font: bold, color: WHITE });
        page.drawText("Bulk Landed-Cost Report", { x: MARGIN, y: PAGE_SIZE[1] - 62, size: 21, font: bold, color: WHITE });
      }
      y = PAGE_SIZE[1] - HEADER_HEIGHT - 28;
    } else {
      page.drawText("Bulk Landed-Cost Report (continued)", { x: MARGIN, y: PAGE_SIZE[1] - MARGIN, size: 10, font: bold, color: GRAY });
      y = PAGE_SIZE[1] - MARGIN - 26;
    }
  }

  const ensureSpace = (needed) => {
    if (y - needed < MARGIN + 30) startPage(false);
  };

  startPage(true);
  page.drawText(directionLabel, { x: MARGIN, y, size: 11, font, color: INK });
  y -= 15;
  page.drawText(
    `Generated: ${generatedAt}   |   Currency: ${currency}${oceanFreight ? "   |   Ocean freight" : ""}`,
    { x: MARGIN, y, size: 9, font, color: GRAY }
  );
  y -= 22;

  // Same formulas as the single-item calculator in the app (GST for
  // imports into Canada; MPF + optional HMF for imports into the US) —
  // kept in sync manually since this runs server-side, not shared code.
  let grandTotal = 0;
  let matchedCount = 0;
  let unmatchedCount = 0;
  const computed = rows.map((row) => {
    const item = TARIFF_BY_ID.get(row.hs_code);
    if (!item) {
      unmatchedCount++;
      return { ...row, matched: false };
    }
    matchedCount++;
    const qty = Number(row.quantity) || 0;
    const unitValue = Number(row.unit_value) || 0;
    const freight = Number(row.freight) || 0;
    const insurance = Number(row.insurance) || 0;
    const value = qty * unitValue;
    const duty = value * (item.rate / 100);
    let total;
    if (direction === "us_to_ca") {
      const gst = (value + duty) * 0.05;
      total = value + duty + gst + freight + insurance;
    } else {
      const mpf = Math.min(Math.max(value * 0.003464, 32.71), 634.62);
      const hmf = oceanFreight ? value * 0.00125 : 0;
      total = value + duty + mpf + hmf + freight + insurance;
    }
    grandTotal += total;
    return { ...row, matched: true, item, value, duty, total };
  });

  const summary = `${rows.length} line${rows.length === 1 ? "" : "s"}   |   ${matchedCount} matched   |   ${unmatchedCount} unmatched   |   Grand total: $${grandTotal.toFixed(2)} ${currency}`;
  page.drawRectangle({ x: MARGIN, y: y - 22, width: PAGE_SIZE[0] - 2 * MARGIN, height: 28, color: ZEBRA });
  page.drawText(sanitizeForPdf(summary), { x: MARGIN + 10, y: y - 14, size: 10, font: bold, color: brandColor });
  y -= 50;

  ensureSpace(ROW_HEIGHT + 10);
  page.drawText("HS code", { x: MARGIN + 6, y, size: 8, font: bold, color: brandColor });
  page.drawText("Qty", { x: MARGIN + 95, y, size: 8, font: bold, color: brandColor });
  page.drawText("Unit value", { x: MARGIN + 140, y, size: 8, font: bold, color: brandColor });
  page.drawText("Line value", { x: MARGIN + 215, y, size: 8, font: bold, color: brandColor });
  page.drawText("Duty", { x: MARGIN + 290, y, size: 8, font: bold, color: brandColor });
  page.drawText("Total", { x: MARGIN + 365, y, size: 8, font: bold, color: brandColor });
  y -= 6;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_SIZE[0] - MARGIN, y }, thickness: 1, color: brandColor });
  y -= 16;

  let rowIndex = 0;
  let anyMatchedViaParent = false;
  for (const row of computed) {
    ensureSpace(ROW_HEIGHT);
    if (rowIndex % 2 === 0) {
      page.drawRectangle({ x: MARGIN, y: y - 5, width: PAGE_SIZE[0] - 2 * MARGIN, height: ROW_HEIGHT, color: ZEBRA });
    }
    if (!row.matched) {
      page.drawText(sanitizeForPdf(row.original_input || row.hs_code), { x: MARGIN + 6, y, size: 8, font, color: RATE_UP });
      page.drawText("HS code not found in database", { x: MARGIN + 95, y, size: 8, font, color: RATE_UP });
    } else {
      const codeLabel = row.matched_via_parent ? `${row.item.hs} *` : row.item.hs;
      if (row.matched_via_parent) anyMatchedViaParent = true;
      page.drawText(codeLabel, { x: MARGIN + 6, y, size: 8, font, color: INK });
      page.drawText(String(row.quantity), { x: MARGIN + 95, y, size: 8, font, color: INK });
      page.drawText(`$${Number(row.unit_value).toFixed(2)}`, { x: MARGIN + 140, y, size: 8, font, color: INK });
      page.drawText(`$${row.value.toFixed(2)}`, { x: MARGIN + 215, y, size: 8, font, color: INK });
      page.drawText(`$${row.duty.toFixed(2)}`, { x: MARGIN + 290, y, size: 8, font, color: INK });
      page.drawText(`$${row.total.toFixed(2)}`, { x: MARGIN + 365, y, size: 8, font: bold, color: INK });
    }
    y -= ROW_HEIGHT;
    rowIndex++;
  }

  if (anyMatchedViaParent) {
    ensureSpace(ROW_HEIGHT);
    page.drawText(
      "* Exact code not separately listed — rate inherited from the parent tariff item (see original code on your source file).",
      { x: MARGIN, y, size: 7, font, color: GRAY }
    );
    y -= ROW_HEIGHT;
  }

  const total = pages.length;
  const footerBrandLine = brand?.company_name
    ? `${sanitizeForPdf(brand.company_name)}${brand.contact_person ? "  ·  " + sanitizeForPdf(brand.contact_person) : ""}`
    : "Generated by Tariff Watch";
  const footerContactParts = [brand?.address, brand?.phone, brand?.email].filter(Boolean).map(sanitizeForPdf);

  pages.forEach((p, idx) => {
    p.drawLine({ start: { x: MARGIN, y: 38 }, end: { x: PAGE_SIZE[0] - MARGIN, y: 38 }, thickness: 0.5, color: rgb(0.85, 0.85, 0.85) });
    p.drawText(`${footerBrandLine}  -  Not legal or customs advice  -  verify with official sources`, {
      x: MARGIN, y: 26, size: 7, font, color: GRAY,
    });
    if (footerContactParts.length) {
      p.drawText(footerContactParts.join("   ·   "), { x: MARGIN, y: 15, size: 7, font, color: GRAY });
    }
    p.drawText(`Page ${idx + 1} of ${total}`, { x: PAGE_SIZE[0] - MARGIN - 55, y: 26, size: 7, font, color: GRAY });
  });

  return pdfDoc.save();
}

// A one-time purchase (Exposure Report or Bulk Calculator) — records the
// transaction, grants the report_purchases entitlement, and generates
// the PDF. This is exactly the logic that existed before subscriptions
// were added; only the routing above it changed.
async function handleOneTimePayment(supabase, session) {
  const userId = session.client_reference_id;
  const product = session.metadata?.product || "unknown";
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

  if (!userId || !paymentIntentId) {
    // Nothing sensible to record — acknowledge so Stripe doesn't retry forever.
    return jsonResponse({ ok: true, note: "Missing client_reference_id or payment_intent" });
  }

  // Idempotency: Stripe retries webhooks on any non-2xx response or
  // timeout, so the same event can legitimately arrive more than once.
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("stripe_payment_intent_id", paymentIntentId)
    .maybeSingle();

  if (existing) {
    return jsonResponse({ ok: true, note: "Already recorded" });
  }

  const { data: transaction, error: txError } = await supabase
    .from("transactions")
    .insert({
      user_id: userId,
      product,
      amount_cents: session.amount_total,
      currency: session.currency,
      stripe_payment_intent_id: paymentIntentId,
      status: "succeeded",
    })
    .select()
    .single();

  if (txError) {
    return jsonResponse({ error: `Failed to record transaction: ${txError.message}` }, { status: 500 });
  }

  const { error: purchaseError } = await supabase.from("report_purchases").insert({
    user_id: userId,
    report_type: product,
    stripe_payment_intent_id: paymentIntentId,
    status: "paid",
    transaction_id: transaction.id,
    watchlist_id: session.metadata?.watchlist_id || null,
    bulk_calculation_id: session.metadata?.bulk_calc_id || null,
  });

  if (purchaseError) {
    // The payment is safely recorded either way — this just means the
    // report_purchases row needs a manual look, not a failure back to Stripe.
    return jsonResponse({ ok: true, warning: `transaction saved, report_purchases failed: ${purchaseError.message}` });
  }

  // Generate and upload the PDF. Best-effort: if this step fails, the
  // payment and entitlement are still safely recorded above — someone
  // can re-run report generation later rather than losing the sale.
  try {
    let pdfBytes;
    let brand = null;
    const { data: profileRow } = await supabase
      .from("profiles")
      .select("subscription_status")
      .eq("id", userId)
      .maybeSingle();
    if (profileRow?.subscription_status === "active") {
      const { data: brandRow } = await supabase.from("brand_settings").select("*").eq("user_id", userId).maybeSingle();
      if (brandRow) {
        brand = { ...brandRow };
        if (brandRow.logo_url) {
          try {
            const { data: logoBlob, error: logoError } = await supabase.storage.from("logos").download(brandRow.logo_url);
            if (!logoError && logoBlob) {
              brand.logoBytes = Buffer.from(await logoBlob.arrayBuffer());
              brand.logoType = brandRow.logo_url.toLowerCase().endsWith(".png") ? "png" : "jpeg";
            }
          } catch (e) {
            console.error("Failed to download brand logo:", e.message);
            // Report still generates fine without a logo — just falls
            // back to the plain brand-color header.
          }
        }
      }
    }

    if (product === "bulk_calc") {
      const bulkCalcId = session.metadata?.bulk_calc_id || null;
      if (!bulkCalcId) throw new Error("checkout.session.completed for bulk_calc missing bulk_calc_id metadata");
      const { data: bulkRow } = await supabase
        .from("bulk_calculations")
        .select("direction, ocean_freight, rows")
        .eq("id", bulkCalcId)
        .maybeSingle();
      if (!bulkRow) throw new Error(`bulk_calculations row ${bulkCalcId} not found`);
      pdfBytes = await buildBulkCalcReportPdf({
        generatedAt: new Date().toISOString().slice(0, 10),
        direction: bulkRow.direction,
        oceanFreight: bulkRow.ocean_freight,
        rows: bulkRow.rows || [],
        brand,
      });
    } else {
      // exposure_pdf (default/fallback for any future product without
      // its own branch — better a generic exposure-style report than none)
      const watchlistId = session.metadata?.watchlist_id || null;
      let items = [];
      let watchlistName = "My Watchlist";
      if (watchlistId) {
        const { data: watchlistRow } = await supabase
          .from("watchlists")
          .select("name, hs_codes")
          .eq("id", watchlistId)
          .maybeSingle();
        if (watchlistRow) {
          watchlistName = watchlistRow.name || watchlistName;
          items = (watchlistRow.hs_codes || []).map((id) => TARIFF_BY_ID.get(id)).filter(Boolean);
        }
      }
      pdfBytes = await buildExposureReportPdf({
        watchlistName,
        generatedAt: new Date().toISOString().slice(0, 10),
        items,
        brand,
      });
    }

    const filePath = `${userId}/${transaction.id}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("reports")
      // Supabase's Node storage client wants a Buffer/ArrayBuffer, not a
      // bare Uint8Array — pdf-lib's .save() returns the latter.
      .upload(filePath, Buffer.from(pdfBytes), { contentType: "application/pdf", upsert: true });

    if (uploadError) {
      console.error("Report upload failed:", uploadError.message);
    } else {
      const { error: updateError } = await supabase
        .from("report_purchases")
        .update({ file_path: filePath })
        .eq("transaction_id", transaction.id);
      if (updateError) console.error("Failed to save file_path:", updateError.message);
    }
  } catch (e) {
    console.error("PDF generation failed:", e);
  }

  return jsonResponse({ ok: true, transactionId: transaction.id });
}

// A White-Label subscription checkout completing for the first time —
// mark the profile active and remember the Stripe customer id, so later
// customer.subscription.* events (which only carry a customer id, not
// our own user id) can find their way back to the right profile row.
async function handleSubscriptionCheckout(supabase, session) {
  const userId = session.client_reference_id;
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (!userId) {
    return jsonResponse({ ok: true, note: "Missing client_reference_id on subscription checkout" });
  }

  const { error } = await supabase
    .from("profiles")
    .update({ subscription_status: "active", stripe_customer_id: customerId || null })
    .eq("id", userId);

  if (error) {
    console.error("Failed to activate subscription:", error.message);
    return jsonResponse({ error: `Failed to activate subscription: ${error.message}` }, { status: 500 });
  }
  return jsonResponse({ ok: true, note: "Subscription activated" });
}

// Renewals, cancellations, and payment-failure status changes on an
// existing subscription. Looked up by stripe_customer_id since these
// events carry a Stripe Subscription object, not our own user id.
async function handleSubscriptionStatusChange(supabase, subscription, eventType) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  if (!customerId) {
    return jsonResponse({ ok: true, note: "Missing customer id on subscription event" });
  }

  let newStatus = "free";
  if (eventType === "customer.subscription.updated") {
    if (subscription.status === "active" || subscription.status === "trialing") newStatus = "active";
    else if (subscription.status === "past_due" || subscription.status === "unpaid") newStatus = "past_due";
    else newStatus = "free";
  }
  // "deleted" events mean the subscription is fully gone, regardless of
  // whatever status field it still carries — always falls back to "free".

  const { error } = await supabase.from("profiles").update({ subscription_status: newStatus }).eq("stripe_customer_id", customerId);

  if (error) {
    console.error("Failed to update subscription status:", error.message);
    return jsonResponse({ error: `Failed to update subscription status: ${error.message}` }, { status: 500 });
  }
  return jsonResponse({ ok: true, note: `subscription_status set to ${newStatus}` });
}

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    return jsonResponse({ error: "Server missing required env vars" }, { status: 500 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const signature = req.headers.get("stripe-signature");
  // Signature verification needs the exact raw bytes Stripe signed —
  // reading as text here, never JSON.parse before this check.
  const rawBody = await req.text();

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return jsonResponse({ error: `Webhook signature verification failed: ${err.message}` }, { status: 400 });
  }

  // Uses the secret key (not a user's JWT — Stripe is calling us, not a
  // signed-in browser) so it can write on behalf of any user, bypassing
  // RLS by design for this one trusted, signature-verified backend job.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.mode === "subscription") {
      return await handleSubscriptionCheckout(supabase, session);
    }
    return await handleOneTimePayment(supabase, session);
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    return await handleSubscriptionStatusChange(supabase, event.data.object, event.type);
  }

  // Ignoring anything else keeps this handler safe as more event types
  // get subscribed to in Stripe over time.
  return jsonResponse({ ok: true, ignored: event.type });
};
