// Shared helpers for the push-notification Netlify Functions.
import crypto from "node:crypto";

export const SUBSCRIPTIONS_STORE = "push-subscriptions";

/**
 * Turns a push subscription's endpoint URL into a short, stable key we
 * can use in Netlify Blobs. Endpoint URLs are unique per browser
 * installation, so hashing one gives us a natural upsert key: the same
 * device subscribing twice overwrites its own record instead of
 * creating duplicates.
 */
export function keyForEndpoint(endpoint) {
  return crypto.createHash("sha256").update(endpoint).digest("hex");
}

export function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      // Keep this API reachable from the app's own origin only isn't
      // strictly enforceable here (Functions don't know the site's own
      // domain in a portable way), but browsers only send subscription
      // payloads from pages that already asked for Notification
      // permission, which limits accidental cross-site abuse in
      // practice for an MVP. Tighten with a real allow-list origin
      // check before this handles real user volume.
      ...(init.headers || {}),
    },
  });
}
