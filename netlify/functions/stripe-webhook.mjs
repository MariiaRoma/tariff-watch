// POST /.netlify/functions/stripe-webhook
// Called by Stripe itself (not the browser) whenever a subscribed event
// fires — currently just checkout.session.completed. Verifies the
// request really came from Stripe using the raw body + signing secret,
// then records the payment in Supabase.
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { jsonResponse } from "./_shared.mjs";
import { buildExposureReportPdf } from "./_report.mjs";
import tariffData from "../../data.json";

const TARIFF_BY_ID = new Map(tariffData.items.map((item) => [item.id, item]));

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

  if (event.type !== "checkout.session.completed") {
    // Only subscribed to this one event type in Stripe, but ignoring
    // anything else keeps this handler safe if more get added later.
    return jsonResponse({ ok: true, ignored: event.type });
  }

  const session = event.data.object;
  const userId = session.client_reference_id;
  const product = session.metadata?.product || "unknown";
  const paymentIntentId =
    typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;

  if (!userId || !paymentIntentId) {
    // Nothing sensible to record — acknowledge so Stripe doesn't retry forever.
    return jsonResponse({ ok: true, note: "Missing client_reference_id or payment_intent" });
  }

  // Uses the secret key (not a user's JWT — Stripe is calling us, not a
  // signed-in browser) so it can write on behalf of any user, bypassing
  // RLS by design for this one trusted, signature-verified backend job.
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

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

    const pdfBytes = await buildExposureReportPdf({
      watchlistName,
      generatedAt: new Date().toISOString().slice(0, 10),
      items,
    });

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
};
