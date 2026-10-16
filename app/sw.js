// Story Studio service worker: offline app shell and the Android share target.
// Bump VERSION whenever a cached file changes so installed apps update.
const VERSION = "story-studio-v1";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/edit-core.js",
  "./js/render.js",
  "./js/media.js",
  "./js/transcribe.js",
  "./js/store.js",
  "./vendor/mediabunny.min.mjs",
  "./vendor/mediabunny-aac-encoder.min.mjs",
  "./fonts/montserrat-800-latin.woff2",
  "./fonts/montserrat-800-latin-ext.woff2",
  "./fonts/abril-fatface-latin.woff2",
  "./fonts/abril-fatface-latin-ext.woff2",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== "story-studio-share").map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return; // transcription APIs go straight to the network

  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(receiveShare(event.request));
    return;
  }
  if (event.request.method !== "GET") return;

  // Pages: network first so updates arrive, cache when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html")),
    );
    return;
  }

  // Assets: cache first, refreshed in the background.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});

async function receiveShare(request) {
  const scope = new URL(self.registration.scope);
  try {
    const form = await request.formData();
    const file = form.getAll("video").find((f) => f && typeof f === "object");
    if (file) {
      const cache = await caches.open("story-studio-share");
      await cache.put(
        "shared-video",
        new Response(file, { headers: { "content-type": file.type || "video/mp4", "x-file-name": encodeURIComponent(file.name || "shared.mp4") } }),
      );
    }
  } catch {
    // fall through to the app; it will show the home screen
  }
  return Response.redirect(new URL("./?shared=1", scope).href, 303);
}
