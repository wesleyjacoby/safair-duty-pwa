export const $ = (sel, el = document) => el.querySelector(sel);
export function badge(text, tone = "") {
	const span = document.createElement("span");
	span.className = `badge ${tone}`;
	span.textContent = text;
	return span;
}
export function chip(text) {
	const span = document.createElement("span");
	span.className = "chip";
	span.textContent = text;
	return span;
}
export function renderList(container, items) {
	container.innerHTML = "";
	items.forEach((n) => container.appendChild(n));
}
