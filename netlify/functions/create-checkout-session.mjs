// POST /.netlify/functions/create-checkout-session
// Called from the browser by a signed-in user. Verifies their Supabase
// session, then creates a Stripe Checkout Session for a single one-time
// product and returns its hosted URL for the browser to redirect to.
//
// Header: Authorization: Bearer <Supabase access token>
// Body: { priceId, product, refId? }
//   - product "exposure_pdf": refId is ignored — the user's watchlist
//     is looked up automatically.
//   - product "bulk_calc": refId is the bulk_calculations row id the
//     browser already created (holds the parsed CSV rows).
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import { jsonResponse } from "./_shared.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });
  }

  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, STRIPE_SECRET_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY || !STRIPE_SECRET_KEY) {
    return jsonResponse({ error: "Server missing required env vars" }, { status: 500 });
  }

  // Verifying the token this way (publishable key + the caller's own JWT)
  // asks Supabase's own auth server whether the token is valid — no
  // secret/service-role key needed here at all. Setting the same token
  // as a global header also means any .from() query below runs as this
  // user, so Row Level Security applies exactly as it would in the browser.
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, { status: 401 });
  }
  const user = userData.user;

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { priceId, product, refId } = body || {};
  if (!priceId || !product) {
    return jsonResponse({ error: "Missing priceId or product" }, { status: 400 });
  }

  const metadata = { product };
  if (product === "exposure_pdf") {
    const { data: watchlistRow } = await supabase.from("watchlists").select("id").eq("user_id", user.id).maybeSingle();
    metadata.watchlist_id = watchlistRow?.id || "";
  } else if (product === "bulk_calc") {
    if (!refId) return jsonResponse({ error: "Missing refId for bulk_calc" }, { status: 400 });
    // Confirm the bulk_calculations row is really this user's (RLS via
    // the token above already enforces this, but a clear error is nicer
    // than a silent Stripe metadata mismatch later).
    const { data: bulkRow } = await supabase.from("bulk_calculations").select("id").eq("id", refId).maybeSingle();
    if (!bulkRow) return jsonResponse({ error: "Bulk calculation not found" }, { status: 404 });
    metadata.bulk_calc_id = refId;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      // Ties the Stripe session to our own user id so the webhook knows
      // whose transaction/profile to update.
      client_reference_id: user.id,
      customer_email: user.email,
      metadata,
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`,
    });
    return jsonResponse({ url: session.url });
  } catch (err) {
    return jsonResponse({ error: err.message || "Failed to create checkout session" }, { status: 500 });
  }
};
