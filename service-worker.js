/**
 * Tariff Watch — service worker
 * Cache-first app shell so the watchlist, calculator, and last-synced
 * sample data all work offline once a visitor has opened the app once.
 * Bump CACHE_NAME whenever data.js / app.js / styles.css change so
 * returning visitors pick up the new version instead of a stale cache.
 */

const CACHE_NAME = "tariff-watch-v2026-09-02";
const APP_SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {
      /* if a sandboxed preview blocks caching, the app still runs uncached */
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200 && response.type === "basic") {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

/**
 * Push notifications
 * -------------------
 * The notify.mjs Netlify Function sends a JSON payload shaped like
 * { title, body, url }. If a push ever arrives without a parseable body
 * (shouldn't happen from our own backend, but push transport is
 * best-effort), fall back to a generic message rather than throwing —
 * a broken push handler can silently disable future notifications on
 * some browsers.
 */
self.addEventListener("push", (event) => {
  let data = { title: "Tariff Watch", body: "A watched tariff rate changed.", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch (e) {
    /* keep the fallback message */
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "icons/icon-192.png",
      badge: "icons/icon-192.png",
      data: { url: data.url || "/" },
      tag: "tariff-watch-rate-change", // collapses multiple pending notifications into one
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
