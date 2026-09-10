// POST /.netlify/functions/create-portal-session
// Called from the browser by a signed-in, subscribed user. Returns a URL
// to Stripe's hosted Customer Portal, where they can update payment
// details or cancel the White-Label subscription themselves.
//
// Header: Authorization: Bearer <Supabase access token>
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

  const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, { status: 401 });
  }

  const { data: profileRow } = await supabase
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (!profileRow?.stripe_customer_id) {
    return jsonResponse({ error: "No active subscription found for this account" }, { status: 404 });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const origin = req.headers.get("origin") || new URL(req.url).origin;

  try {
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profileRow.stripe_customer_id,
      return_url: `${origin}/`,
    });
    return jsonResponse({ url: portalSession.url });
  } catch (err) {
    return jsonResponse({ error: err.message || "Failed to create portal session" }, { status: 500 });
  }
};
