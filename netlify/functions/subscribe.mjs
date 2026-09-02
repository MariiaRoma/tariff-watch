// POST /.netlify/functions/subscribe
// Body: { subscription: PushSubscriptionJSON, watchlist: string[] }
// Stores (or updates) a push subscription + the HS-code ids it should
// be notified about. Called from app.js whenever the person enables
// notifications, and again whenever their watchlist changes.
import { getStore } from "@netlify/blobs";
import { SUBSCRIPTIONS_STORE, keyForEndpoint, jsonResponse } from "./_shared.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { subscription, watchlist } = body || {};
  if (
    !subscription ||
    typeof subscription.endpoint !== "string" ||
    !subscription.keys ||
    typeof subscription.keys.p256dh !== "string" ||
    typeof subscription.keys.auth !== "string"
  ) {
    return jsonResponse({ error: "Missing or malformed 'subscription'" }, { status: 400 });
  }
  if (!Array.isArray(watchlist)) {
    return jsonResponse({ error: "'watchlist' must be an array of HS entry ids" }, { status: 400 });
  }

  const store = getStore(SUBSCRIPTIONS_STORE);
  const key = keyForEndpoint(subscription.endpoint);

  await store.setJSON(key, {
    subscription,
    watchlist,
    updatedAt: new Date().toISOString(),
  });

  return jsonResponse({ ok: true, watchedCount: watchlist.length });
};
