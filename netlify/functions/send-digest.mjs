// POST /.netlify/functions/send-digest
// Called weekly by a scheduled GitHub Actions job — NOT meant to be
// called from the browser. Same shared-secret protection as notify.mjs.
//
// Summarizes the last 7 days of rate changes into ONE push notification
// per device that opted into weekly-digest mode (instead of the instant
// per-change push that notify.mjs sends everyone else).
import webpush from "web-push";
import { getStore } from "@netlify/blobs";
import { SUBSCRIPTIONS_STORE, jsonResponse } from "./_shared.mjs";
import tariffData from "../../data.json";

export default async (req) => {
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, { status: 405 });
  }

  const providedSecret = (req.headers.get("x-notify-secret") || "").trim();
  const expectedSecret = (process.env.NOTIFY_SECRET || "").trim();
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  }

  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
    return jsonResponse({ error: "Server missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars" }, { status: 500 });
  }
  webpush.setVapidDetails(VAPID_SUBJECT || "mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

  // "Changed this week" = has a recorded prior rate (so it's a real
  // change, not just a fresh sync) whose date falls in the last 7 days.
  // Same definition the in-app "Recently Changed" feed uses, just
  // windowed to a week instead of showing everything.
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const changedThisWeek = tariffData.items.filter((item) => {
    if (item.priorRate == null || item.priorRate === item.rate) return false;
    const changeTime = Date.parse(item.changeDate || item.effectiveDate || "");
    return !Number.isNaN(changeTime) && changeTime >= oneWeekAgo;
  });
  const changedById = new Map(changedThisWeek.map((item) => [item.id, item]));

  const store = getStore(SUBSCRIPTIONS_STORE);
  const { blobs } = await store.list();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  await Promise.all(
    blobs.map(async ({ key }) => {
      const record = await store.get(key, { type: "json" });
      if (!record || record.notificationMode !== "weekly") {
        skipped++;
        return;
      }

      const watched = new Set(record.watchlist || []);
      const relevant = [...changedById.values()].filter((item) => watched.has(item.id));
      if (relevant.length === 0) {
        skipped++;
        return;
      }

      const title = `Weekly digest: ${relevant.length} change${relevant.length === 1 ? "" : "s"} on your watchlist`;
      const body = relevant
        .slice(0, 3)
        .map((c) => `${c.hs}: ${c.priorRate}% \u2192 ${c.rate}%`)
        .join(", ");

      const payload = JSON.stringify({ title, body, url: "/" });

      try {
        await webpush.sendNotification(record.subscription, payload);
        sent++;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await store.delete(key);
        }
        failed++;
      }
    })
  );

  return jsonResponse({ ok: true, sent, skipped, failed, changedThisWeekCount: changedThisWeek.length });
};
