// POST /.netlify/functions/unsubscribe
// Body: { endpoint: string }
// Removes a stored push subscription — called when the person turns
// notifications off in the app.
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

  const { endpoint } = body || {};
  if (typeof endpoint !== "string" || !endpoint) {
    return jsonResponse({ error: "Missing 'endpoint'" }, { status: 400 });
  }

  const store = getStore(SUBSCRIPTIONS_STORE);
  await store.delete(keyForEndpoint(endpoint));

  return jsonResponse({ ok: true });
};
