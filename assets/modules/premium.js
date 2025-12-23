// assets/modules/premium.js
// Lightweight premium gating scaffold.
//
// For now this is a simple local flag so we can build Pro features without
// implementing billing yet. Later you can replace `isPro()` with Google Play
// Billing / App Store logic (or a server token).

const KEY = "sacaaduty.isPro";

export function isPro() {
	return localStorage.getItem(KEY) === "1";
}

export function setPro(v) {
	localStorage.setItem(KEY, v ? "1" : "0");
}

// Convenience for dev/testing: if the URL has ?pro=1, enable Pro.
export function bootProFromQuery() {
	try {
		const u = new URL(window.location.href);
		if (u.searchParams.get("pro") === "1") setPro(true);
		if (u.searchParams.get("pro") === "0") setPro(false);
	} catch (_) {
		// ignore
	}
}
