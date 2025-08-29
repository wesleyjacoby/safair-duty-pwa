// sw.js — simple cache-first PWA service worker with update support
const CACHE = "safair-duty-v3"; // bump to force fresh asset pull

const ASSETS = [
	"/",
	"/index.html",
	"/assets/app.css",
	"/assets/app.js",
	"/assets/db.js",
	"/assets/calc.js",
	"/assets/ui.js",
	"/vendor/dexie.min.js",
	"/vendor/luxon.min.js",
	"/vendor/jspdf.umd.min.js",
	"/manifest.webmanifest",
];

self.addEventListener("install", (e) => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSETS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
				)
			)
			.then(() => self.clients.claim())
	);
});

self.addEventListener("fetch", (e) => {
	const { request } = e;
	if (request.method !== "GET") return;
	e.respondWith(
		caches.match(request).then(
			(cached) =>
				cached ||
				fetch(request).then((resp) => {
					// Runtime cache for same-origin GETs
					if (request.url.startsWith(self.location.origin)) {
						const clone = resp.clone();
						caches.open(CACHE).then((c) => c.put(request, clone));
					}
					return resp;
				})
		)
	);
});

// Allow page to tell the SW to activate immediately when an update is found
self.addEventListener("message", (e) => {
	if (e.data && e.data.type === "SKIP_WAITING") self.skipWaiting();
});
