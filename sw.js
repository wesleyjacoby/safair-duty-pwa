// sw.js — cache-first PWA SW tailored for GitHub Pages
const CACHE = "safair-duty-v3.12"; // ← bump each release

// Assets relative to the repo root (no leading slash)
const ASSETS = [
	"index.html",
	"manifest.webmanifest",
	"assets/app.css",
	"assets/app.js",
	"assets/calc.js",
	"assets/db.js",
	"assets/ui.js",
	"assets/om_tables.js",
	"vendor/dexie.min.js",
	"vendor/luxon.min.js",
	"vendor/jspdf.umd.min.js",
	"icons/icon-192.png",
	"icons/icon-512.png",
];

// Resolve against SW scope so it works under /<repo> on GH Pages
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

// Navigation: network first → cache fallback (offline SPA)
self.addEventListener("fetch", (event) => {
	const req = event.request;
	if (req.method !== "GET") return;

	if (req.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					return await fetch(req);
				} catch {
					const cache = await caches.open(CACHE);
					const cachedIndex = await cache.match(
						ASSET_URLS.find((u) => u.endsWith("index.html"))
					);
					return cachedIndex || Response.error();
				}
			})()
		);
		return;
	}

	// Other GETs: cache-first, then network; runtime cache same-origin
	event.respondWith(
		(async () => {
			const cached = await caches.match(req, { ignoreSearch: true });
			if (cached) return cached;
			const resp = await fetch(req);
			try {
				if (req.url.startsWith(self.location.origin) && resp && resp.ok) {
					const clone = resp.clone();
					const cache = await caches.open(CACHE);
					cache.put(req, clone);
				}
			} catch {}
			return resp;
		})()
	);
});

// sw.js — add/confirm this message handler
self.addEventListener("message", (e) => {
	const type = e.data && e.data.type;
	if (type === "SKIP_WAITING") {
		self.skipWaiting();
	} else if (type === "GET_VERSION") {
		// reply to the client with the current cache label
		const port = e.ports && e.ports[0];
		port &&
			port.postMessage({ cache: CACHE, scope: self.registration?.scope || "" });
	}
});
