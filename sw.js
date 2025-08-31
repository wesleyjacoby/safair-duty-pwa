/* sw.js — offline-first PWA for Safair Duty Tracker
   - Precache core assets
   - Cache-first for same-origin static assets
   - Network-first for navigations (fallback to cached index.html)
*/
const CACHE = "safair-duty-v1.0.2"; // bump on any asset changes

const CORE_ASSETS = [
	"./",
	"./index.html",
	"./assets/app.css",
	"./assets/app.js",
	"./assets/calc.js",
	"./vendor/luxon.min.js",
	"./vendor/dexie.min.js",
	"./vendor/jspdf.umd.min.js",
	"./icons/icon-192.png",
	"./icons/icon-512.png",
	"./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE).then((cache) => cache.addAll(CORE_ASSETS))
	);
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys.map((k) => (k === CACHE ? null : caches.delete(k)))
			);
			await self.clients.claim();
		})()
	);
});

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (req.method !== "GET") return;

	if (req.mode === "navigate") {
		event.respondWith(
			(async () => {
				try {
					return await fetch(req);
				} catch {
					const cache = await caches.open(CACHE);
					const offline = await cache.match("./index.html");
					return offline || Response.error();
				}
			})()
		);
		return;
	}

	if (url.origin === self.location.origin) {
		event.respondWith(
			(async () => {
				const cache = await caches.open(CACHE);
				const cached = await cache.match(req);
				if (cached) {
					fetch(req)
						.then((res) => {
							if (res && res.ok) cache.put(req, res.clone());
						})
						.catch(() => {});
					return cached;
				}
				const res = await fetch(req);
				if (res && res.ok) cache.put(req, res.clone());
				return res;
			})()
		);
	}
});

self.addEventListener("message", (event) => {
	if (event.data === "SKIP_WAITING") self.skipWaiting();
});
