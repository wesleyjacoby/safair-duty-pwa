// assets/ui.js
export const $ = (sel) => document.querySelector(sel);

export function badge(text, tone /* "ok" | "warn" | "bad" */) {
	const el = document.createElement("span");
	el.className = "badge" + (tone ? " " + tone : "");
	el.textContent = text;
	return el;
}

export function chip(text, tone /* optional: "ok" | "warn" | "bad" */) {
	const el = document.createElement("span");
	el.className = "chip" + (tone ? " " + tone : "");
	el.textContent = text;
	return el;
}

export function renderList(container, nodes) {
	if (!container) return;
	container.innerHTML = "";
	for (const n of nodes) {
		if (n == null) continue;
		container.appendChild(n.nodeType ? n : document.createTextNode(String(n)));
	}
}
