// POST /.netlify/functions/create-checkout-session
// Called from the browser by a signed-in user. Verifies their Supabase
// session, then creates a Stripe Checkout Session for a single one-time
// product and returns its hosted URL for the browser to redirect to.
//
// Header: Authorization: Bearer <Supabase access token>
// Body: { priceId }
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
  // secret/service-role key needed here at all.
  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
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
  const priceId = body?.priceId;
  if (!priceId) {
    return jsonResponse({ error: "Missing priceId" }, { status: 400 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: priceId, quantity: 1 }],
      // Ties the Stripe session to our own user id so the webhook (built
      // next) knows whose transaction/profile to update.
      client_reference_id: user.id,
      customer_email: user.email,
      metadata: { product: "exposure_pdf" },
      success_url: `${origin}/?checkout=success`,
      cancel_url: `${origin}/?checkout=cancelled`,
    });
    return jsonResponse({ url: session.url });
  } catch (err) {
    return jsonResponse({ error: err.message || "Failed to create checkout session" }, { status: 500 });
  }
};
