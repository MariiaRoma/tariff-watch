// POST /.netlify/functions/notify
// Called by the GitHub Actions sync workflow after it detects rate
// changes — NOT meant to be called from the browser. Protected by a
// shared secret header (X-Notify-Secret) that must match the
// NOTIFY_SECRET environment variable.
//
// Body: { changes: [{ id, hs, desc, oldRate, newRate }, ...] }
//
// For every stored subscription whose watchlist includes one of the
// changed ids, sends a real Web Push notification via VAPID. Removes
// any subscription the push service reports as gone (404/410) so the
// store doesn't accumulate dead devices.
import webpush from "web-push";
import { getStore } from "@netlify/blobs";
import { SUBSCRIPTIONS_STORE, jsonResponse } from "./_shared.mjs";

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const providedSecret = req.headers.get("x-notify-secret");
  if (!process.env.NOTIFY_SECRET || providedSecret !== process.env.NOTIFY_SECRET) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return jsonResponse({ error: "Server missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars" }, { status: 500 });
  }
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, { status: 400 });
  }
  const changes = Array.isArray(body?.changes) ? body.changes : [];
  if (changes.length === 0) {
    return jsonResponse({ ok: true, sent: 0, skipped: 0, failed: 0, note: "No changes provided" });
  }
  const changedIds = new Set(changes.map((c) => c.id));

  const store = getStore(SUBSCRIPTIONS_STORE);
  const { blobs } = await store.list();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    blobs.map(async ({ key }) => {
      const record = await store.get(key, { type: "json" });
      if (!record) return;

      const watched = new Set(record.watchlist || []);
      const relevant = changes.filter((c) => watched.has(c.id));
      if (relevant.length === 0) {
        skipped++;
        return;
      }

      const title = relevant.length === 1 ? `${relevant[0].hs} changed to ${relevant[0].newRate}%` : `${relevant.length} watched tariff codes changed`;
      const body = relevant
        .slice(0, 3)
        .map((c) => `${c.hs}: ${c.oldRate}% \u2192 ${c.newRate}%`)
        .join(", ");

      const payload = JSON.stringify({
        title,
        body,
        url: "/",
      });

      try {
        await webpush.sendNotification(record.subscription, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // Subscription is gone (user uninstalled, cleared data, etc.) — clean it up.
          await store.delete(key);
        }
        failed++;
      }
    })
  );

  return jsonResponse({ ok: true, sent, skipped, failed, changeCount: changes.length });
};
