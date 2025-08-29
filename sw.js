// sw.js
// Simple “cache-first, then network” service worker for your PWA.

const CACHE = "safair-duty-v2";

// Build asset list relative to the SW scope (handles subpaths better than absolute "/")
const ASSETS = [
	"./",
	"./index.html",
	"./manifest.webmanifest",
	"./assets/app.css",
	"./assets/app.js",
	"./assets/calc.js",
	"./assets/db.js",
	"./assets/ui.js",
	"./assets/om_tables.js",
	"./vendor/luxon.min.js",
	"./vendor/dexie.min.js",
	"./vendor/jspdf.umd.min.js",
	"./icons/icon-192.png",
	"./icons/icon-512.png",
];

// Install: pre-cache the app shell
self.addEventListener("install", (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
	self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(keys.map((k) => (k === CACHE ? null : caches.delete(k))))
			)
	);
	self.clients.claim();
});

// Fetch: cache-first for GET; fall back to network; on failure, serve index.html (SPA fallback)
self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return; // Don’t intercept non-GETs

	event.respondWith(
		caches.match(req).then((cached) => {
			if (cached) return cached;
			return fetch(req)
				.then((res) => {
					// Stash successful GETs for future offline use
					if (res && res.ok) {
						const clone = res.clone();
						caches.open(CACHE).then((c) => c.put(req, clone));
					}
					return res;
				})
				.catch(() => {
					// SPA / offline fallback to the app shell
					return caches.match("./index.html");
				});
		})
	);
});
