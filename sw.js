// sw.js — cache-first PWA SW tailored for GitHub Pages (user or project site)
const CACHE = "safair-duty-v3.01"; // ← bump to force fresh asset pull

// List assets relative to the repo root (no leading slash)
const ASSETS = [
	"index.html",
	"assets/app.css",
	"assets/app.js",
	"assets/db.js",
	"assets/calc.js",
	"assets/ui.js",
	"vendor/dexie.min.js",
	"vendor/luxon.min.js",
	"vendor/jspdf.umd.min.js",
	"manifest.webmanifest",
	"icons/icon-192.png",
	"icons/icon-512.png",
];

// Resolve each asset against the SW scope (handles /<repo>/ correctly)
const SCOPE_URL = self.registration
	? new URL(self.registration.scope)
	: new URL("./", self.location);
const ASSET_URLS = ASSETS.map((p) => new URL(p, SCOPE_URL).toString());

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(ASSET_URLS))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// Clean old caches
			const keys = await caches.keys();
			await Promise.all(
				keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
			);

			// (Optional) speed up navigations when online
			if (self.registration.navigationPreload) {
				try {
					await self.registration.navigationPreload.enable();
				} catch {}
			}

			await self.clients.claim();
		})()
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	// Offline SPA navigation: fall back to cached index.html
	if (request.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					// If navigation preload is available, prefer it
					const preload = await event.preloadResponse;
					if (preload) return preload;
					return await fetch(request);
				} catch {
					const cache = await caches.open(CACHE);
					const cachedIndex = await cache.match(
						ASSET_URLS.find((u) => u.endsWith("/index.html")) ||
							ASSET_URLS.find((u) => u.endsWith("index.html"))
					);
					return cachedIndex || Response.error();
				}
			})()
		);
		return;
	}

	// Cache-first for same-origin GETs, then network (runtime cache)
	event.respondWith(
		(async () => {
			const cached = await caches.match(request, { ignoreSearch: true });
			if (cached) return cached;

			const resp = await fetch(request);
			try {
				if (request.url.startsWith(self.location.origin)) {
					const clone = resp.clone();
					const cache = await caches.open(CACHE);
					cache.put(request, clone);
				}
			} catch {
				/* ignore put errors */
			}
			return resp;
		})()
	);
});

// Messages from the page (update + version query)
self.addEventListener("message", (e) => {
	const data = e.data || {};
	if (data.type === "SKIP_WAITING") {
		self.skipWaiting();
	}
	if (data.type === "GET_VERSION") {
		const payload = { cache: CACHE, scope: self.registration.scope };
		if (e.ports && e.ports[0]) {
			e.ports[0].postMessage(payload); // reply via MessageChannel
		} else {
			// broadcast (fallback)
			self.clients.matchAll({ type: "window" }).then((clients) => {
				clients.forEach((c) => c.postMessage({ type: "VERSION", ...payload }));
			});
		}
	}
});
