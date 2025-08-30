// assets/app.js

import {
	normalizeDuty,
	dt,
	durMins,
	toHM,
	dutyLegality,
	rollingStats,
	badgesFromRolling,
	quickStats,
	flagsForDuty,
} from "./calc.js";

const { DateTime } = luxon;

/* ---------------- Version ---------------- */
const APP_VERSION = "v1.0.1";

/* ---------------- Dexie ---------------- */
const db = new Dexie("safair-duty-db");
db.version(2).stores({ duties: "++id, report, off, dutyType, location" });

/* ---------------- State/els ---------------- */
let selectedId = null; // currently selected in Duty Log
let editingId = null; // id being edited (null => creating)

const el = (id) => document.getElementById(id);

const themeBtn = el("themeBtn");
const btnExport = el("btnExport");
const btnImport = el("btnImport");
const importFile = el("importFile");
const btnClear = el("btnClear");

const legalityBadges = el("legalityBadges");
const legalityNotes = el("legalityNotes");
const legalityContext = el("legalityContext");
const quickStatsBox = el("quickStats");
const flagsFeed = el("flagsFeed");
const historyDiv = el("history");
const versionStamp = el("versionStamp");

const form = el("dutyForm");
const btnDeleteDuty = el("btnDeleteDuty");
const btnEditDuty = el("btnEditDuty"); // <-- wire this
const btnCancelEdit = el("btnCancelEdit"); // optional button in HTML
const dutyTypeSel = el("dutyType");
const sbSection = el("sbSection");
const sbCalled = el("sbCalled");
const saveBtn = form?.querySelector('button[type="submit"]');

/* ---------------- Theme ---------------- */
function isDark() {
	return (localStorage.getItem("theme") || "light") === "dark";
}
function setTheme(dark) {
	document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
	localStorage.setItem("theme", dark ? "dark" : "light");
	themeBtn.textContent = dark ? "Light" : "Dark";
	themeBtn.setAttribute("aria-pressed", String(dark));
}
setTheme(isDark());
themeBtn?.addEventListener("click", () => setTheme(!isDark()));

/* ---------------- Toast ---------------- */
function toast(msg, type = "info", ms = 2000) {
	let host = document.getElementById("toasts");
	if (!host) {
		host = document.createElement("div");
		host.id = "toasts";
		host.setAttribute("aria-live", "polite");
		Object.assign(host.style, {
			position: "fixed",
			right: "14px",
			bottom: "14px",
			zIndex: 9999,
			display: "grid",
			gap: "8px",
			maxWidth: "80vw",
		});
		document.body.appendChild(host);
	}
	const n = document.createElement("div");
	n.textContent = msg;
	const bg =
		type === "bad"
			? "#c62828"
			: type === "warn"
			? "#b26a00"
			: type === "success"
			? "#1e8e3e"
			: "#2458e6";
	Object.assign(n.style, {
		padding: "10px 12px",
		borderRadius: "10px",
		color: "#fff",
		font: "14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif",
		boxShadow: "0 6px 20px rgba(0,0,0,.15)",
		background: bg,
	});
	host.appendChild(n);
	setTimeout(() => {
		n.style.opacity = "0";
		n.style.transform = "translateY(6px)";
		n.style.transition = "all .2s ease";
		setTimeout(() => n.remove(), 220);
	}, ms);
}

/* ---------------- Injected CSS for Flag list (light + dark tuned; accent removed) ---------------- */
function ensureFlagStyles() {
	if (document.getElementById("flagStyles")) return;
	const s = document.createElement("style");
	s.id = "flagStyles";
	s.textContent = `
    #flagsFeed { list-style: none; padding: 0; margin: 0; }
    #flagsFeed li { margin: 6px 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--surface-3, #e6e6e6); background: var(--surface-1, #fff); color: inherit; }
    #flagsFeed li.month { background: transparent; border: none; padding: 6px 0 0; color: var(--muted, #6b7280); font-weight: 700; }
    #flagsFeed li.flag { display: flex; gap: 10px; align-items: flex-start; }
    #flagsFeed li.flag .msg { flex: 1 1 auto; }
    #flagsFeed li.flag .chip { font-size: 11px; line-height: 1; padding: 6px 8px; border-radius: 999px; border: 1px solid currentColor; }

    /* -------- Light theme (default) -------- */
    /* Warn (amber) */
    #flagsFeed li.warn { border-color: #b26a00; background: rgba(178,106,0,0.10); }
    #flagsFeed li.warn .chip { color: #8a5a00; background: rgba(178,106,0,0.10); border-color: #b26a00; }
    /* Bad (red) */
    #flagsFeed li.bad { border-color: #c62828; background: rgba(198,40,40,0.10); }
    #flagsFeed li.bad .chip { color: #8f1e1e; background: rgba(198,40,40,0.10); border-color: #c62828; }
    /* Info (blue) */
    #flagsFeed li.info { border-color: #2458e6; background: rgba(36,88,230,0.10); }
    #flagsFeed li.info .chip { color: #1d46b3; background: rgba(36,88,230,0.10); border-color: #2458e6; }

    /* -------- Dark theme -------- */
    [data-theme="dark"] #flagsFeed li { border-color: var(--surface-3, #2f2f33); background: var(--surface-1, #111214); }
    /* Warn */
    [data-theme="dark"] #flagsFeed li.warn { border-color: #6b4800; background: rgba(107,72,0,0.18); }
    [data-theme="dark"] #flagsFeed li.warn .chip { color: #ffd18a; background: rgba(107,72,0,0.18); border-color: #d7a049; }
    /* Bad */
    [data-theme="dark"] #flagsFeed li.bad { border-color: #662020; background: rgba(102,32,32,0.18); }
    [data-theme="dark"] #flagsFeed li.bad .chip { color: #ff9b9b; background: rgba(102,32,32,0.18); border-color: #e36a6a; }
    /* Info */
    [data-theme="dark"] #flagsFeed li.info { border-color: #1f3f99; background: rgba(31,63,153,0.18); }
    [data-theme="dark"] #flagsFeed li.info .chip { color: #9fb6ff; background: rgba(31,63,153,0.18); border-color: #6f8df4; }
  `;
	document.head.appendChild(s);
}

/* ---------------- Helpers ---------------- */
function updateStandbyVisibility() {
	const isStandby = (dutyTypeSel.value || "").toLowerCase() === "standby";
	if (sbSection) sbSection.style.display = isStandby ? "block" : "none";
}
function formToDuty() {
	const f = new FormData(form);
	const o = Object.fromEntries(f.entries());
	const d = normalizeDuty({
		id: editingId,
		dutyType: o.dutyType,
		report: o.report || null,
		off: o.off || null,
		sectors: Number(o.sectors || 0),
		location: o.location || "Home",
		discretionMins: Number(o.discretionMins || 0),
		discretionReason: o.discretionReason || "",
		discretionBy: o.discretionBy || "",
		tags: o.tags || "",
		notes: o.notes || "",
		sbType: o.sbType || "Home",
		sbStart: o.sbStart || null,
		sbEnd: o.sbEnd || null,
		sbCalled: el("sbCalled")?.checked || false,
		sbCall: o.sbCall || null,
	});
	return d;
}
function dutyToForm(d) {
	const n = normalizeDuty(d);
	form.reset();
	el("dutyType").value = n.dutyType || "FDP";
	el("report").value = n.report
		? DateTime.fromISO(n.report).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	el("off").value = n.off
		? DateTime.fromISO(n.off).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	el("sectors").value = Number(n.sectors || 0);
	el("location").value = n.location || "Home";
	el("discretionMins").value = Number(n.discretionMins || 0);
	el("discretionReason").value = n.discretionReason || "";
	el("discretionBy").value = n.discretionBy || "";
	if (el("tags")) el("tags").value = n.tags || "";
	el("notes").value = n.notes || "";

	el("sbType").value = n.sbType || "Home";
	el("sbStart").value = n.sbStart
		? DateTime.fromISO(n.sbStart).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	el("sbEnd").value = n.sbEnd
		? DateTime.fromISO(n.sbEnd).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	if (sbCalled) sbCalled.checked = !!n.sbCalled;
	el("sbCall").value = n.sbCall
		? DateTime.fromISO(n.sbCall).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	updateStandbyVisibility();
}
function safeMillis(v) {
	const D = dt(v);
	return D?.isValid ? D.toMillis() : 0;
}
function setSaveLabel() {
	if (!saveBtn) return;
	saveBtn.textContent = editingId ? "Update Duty" : "Save Duty";
}

/* ---------------- CRUD ---------------- */
async function getAllDutiesSorted() {
	const all = await db.duties.toArray();
	all.sort(
		(a, b) =>
			safeMillis(b.report || b.sbStart) - safeMillis(a.report || a.sbStart)
	);
	return all;
}
async function saveDuty() {
	const d = formToDuty();

	const isStandby = (d.dutyType || "").toLowerCase() === "standby";
	const hasFDP = Boolean(d.report && d.off);

	// Validate
	if (isStandby && !d.sbCalled && !hasFDP) {
		if (!d.sbStart || !d.sbEnd) {
			alert("Please enter Standby Window Start and End.");
			return;
		}
		d.sectors = 0;
	} else {
		if (!d.report || !d.off) {
			alert("Please enter both Sign On and Sign Off.");
			return;
		}
		if (dt(d.off) <= dt(d.report)) {
			alert("Sign off must be after sign on.");
			return;
		}
	}

	// Save
	if (editingId) {
		await db.duties.update(editingId, d);
		toast("Duty updated", "success");
	} else {
		d.id = await db.duties.add(d);
		toast("Duty saved", "success");
	}

	// Reset edit mode
	editingId = null;
	setSaveLabel();
	form.reset();
	updateStandbyVisibility();

	// Select the new/updated row and re-render
	selectedId = d.id || selectedId;
	await renderAll();
}
async function deleteSelected() {
	if (!selectedId) return;
	if (!confirm("Delete selected duty?")) return;
	await db.duties.delete(selectedId);
	selectedId = null;
	editingId = null;
	setSaveLabel();
	await renderAll();
	toast("Duty deleted", "warn");
}
async function clearAll() {
	if (!confirm("This will clear all local data. Continue?")) return;
	await db.duties.clear();
	selectedId = null;
	editingId = null;
	setSaveLabel();
	form.reset();
	updateStandbyVisibility();
	await renderAll();
	toast("All data cleared", "bad");
}

/* ---------------- Edit flow ---------------- */
async function startEdit() {
	if (!selectedId) {
		toast("Select a duty to edit", "warn");
		return;
	}
	const d = await db.duties.get(selectedId);
	if (!d) {
		toast("Selected duty not found", "bad");
		return;
	}
	editingId = d.id;
	dutyToForm(d);
	setSaveLabel();
	form?.scrollIntoView({ behavior: "smooth", block: "start" });
	toast("Editing selected duty", "info", 1200);
}
function cancelEdit() {
	if (!editingId) return;
	editingId = null;
	setSaveLabel();
	form.reset();
	updateStandbyVisibility();
	toast("Edit cancelled", "info", 1000);
}

/* ---------------- Rendering ---------------- */
function renderBadges(container, badges) {
	container.innerHTML = "";
	for (const b of badges) {
		const s = document.createElement("span");
		s.className = `badge ${b.status}`;
		s.textContent = b.text;
		container.appendChild(s);
	}
}
function renderFlagsGrouped(listEl, byMonth) {
	listEl.innerHTML = "";
	const months = [...byMonth.keys()].sort().reverse();
	if (!months.length) {
		const li = document.createElement("li");
		li.textContent = "No flagged items.";
		listEl.appendChild(li);
		return;
	}
	for (const ym of months) {
		const head = document.createElement("li");
		head.className = "month";
		head.textContent = DateTime.fromFormat(ym, "yyyy-LL").toFormat("LLLL yyyy");
		listEl.appendChild(head);
		for (const f of byMonth.get(ym)) {
			const li = document.createElement("li");
			li.className = `flag ${f.level}`; // warn/bad/info
			li.setAttribute("aria-label", f.level);
			li.innerHTML = `<span class="chip">${f.level.toUpperCase()}</span><span class="msg">${
				f.text
			}</span>`;
			listEl.appendChild(li);
		}
	}
}
function renderQuickStats(boxEl, stats) {
	const { averages, counts, standby } = stats;
	boxEl.innerHTML = "";
	const make = (t) => {
		const s = document.createElement("span");
		s.className = "badge";
		s.textContent = t;
		return s;
	};

	boxEl.appendChild(
		make(
			`Avg duty length: ${
				averages.avgDutyLen ? toHM(averages.avgDutyLen) : "—"
			}`
		)
	);
	boxEl.appendChild(
		make(
			`Avg sectors/duty: ${
				averages.avgSectors ? averages.avgSectors.toFixed(2) : "—"
			}`
		)
	);
	boxEl.appendChild(
		make(`Common report window: ${averages.commonReportWindow || "—"}`)
	);

	boxEl.appendChild(
		make(`Disruptive starts (this month): ${counts.disruptiveThisMonth}`)
	);
	boxEl.appendChild(make(`Duties with discretion: ${counts.withDiscretion}`));
	boxEl.appendChild(
		make(`Airport standby calls: ${counts.airportStandbyCalls}`)
	);
	boxEl.appendChild(
		make(`Away-nights (this month): ${counts.awayNightsThisMonth}`)
	);

	if (standby) {
		boxEl.appendChild(make(`Standby used: ${standby.usedPct}%`));
		boxEl.appendChild(
			make(
				`Avg callout notice: ${
					standby.avgCalloutNoticeMins
						? toHM(standby.avgCalloutNoticeMins)
						: standby.avgCallNoticeMins
						? toHM(standby.avgCallNoticeMins)
						: "—"
				}`
			)
		);
	}
}
function renderHistory(div, duties) {
	div.innerHTML = "";
	if (!duties.length) {
		div.textContent = "No duties yet.";
		return;
	}

	// Group by month
	const groups = new Map();
	for (const d of duties) {
		const key = dt(d.report || d.sbStart || Date.now()).toFormat("yyyy-LL");
		(groups.get(key) || groups.set(key, []).get(key)).push(d);
	}

	for (const [ym, arr] of groups) {
		const wrap = document.createElement("div");
		const title = document.createElement("div");
		title.className = "muted";
		title.style.margin = "8px 0";
		title.textContent = DateTime.fromFormat(ym, "yyyy-LL").toFormat(
			"LLLL yyyy"
		);
		wrap.appendChild(title);

		for (const d of arr) {
			const R = d.report ? dt(d.report) : dt(d.sbStart);
			const O = d.off ? dt(d.off) : dt(d.sbEnd);
			const row = document.createElement("div");
			row.tabIndex = 0;
			row.className = "chip";
			row.style.cursor = "pointer";
			row.style.justifyContent = "space-between";
			row.style.display = "flex";
			row.style.gap = "10px";
			row.style.margin = "6px 0";
			if (selectedId === d.id) row.classList.add("ok");

			const left = R?.isValid
				? `${R.toFormat("dd LLL HH:mm")} → ${
						O?.isValid ? O.toFormat("HH:mm") : "—"
				  }`
				: "—";

			const hasFDP = Boolean(d.report && d.off);
			const isStandbyOnly =
				String(d.dutyType || "").toLowerCase() === "standby" &&
				!d.sbCalled &&
				!hasFDP;
			const sbText =
				d.sbStart && d.sbEnd ? `SB ${toHM(durMins(d.sbStart, d.sbEnd))}` : "—";
			const fdpText = hasFDP ? toHM(durMins(d.report, d.off)) : sbText;

			const right = isStandbyOnly
				? `Standby · ${sbText}`
				: `${d.dutyType || "FDP"} · ${Number(
						d.sectors || 0
				  )} legs · ${fdpText}`;

			row.innerHTML = `<span>${left}</span><span>${right}</span>`;
			row.addEventListener("click", async () => {
				selectedId = d.id; // select only
				await computeAndRender(); // rolling windows anchor to this date
				renderHistory(div, duties);
			});
			row.addEventListener("keydown", async (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					row.click();
				}
			});
			wrap.appendChild(row);
		}

		div.appendChild(wrap);
	}
}

async function computeAndRender() {
	const duties = await getAllDutiesSorted();

	if (!selectedId && duties.length) selectedId = duties[0].id;

	const selected = duties.find((d) => d.id === selectedId) || null;
	const prev = selected
		? duties[duties.findIndex((d) => d.id === selected.id) + 1] || null
		: null;

	// Context line for Duty Legality
	if (selected) {
		const when = dt(selected.report || selected.sbStart);
		const kind = String(selected.dutyType || "").toUpperCase();
		if (legalityContext)
			legalityContext.textContent = `Selected: ${
				when?.isValid ? when.toFormat("ccc, dd LLL yyyy HH:mm") : "—"
			} · ${kind}`;
	} else {
		if (legalityContext)
			legalityContext.textContent = "Select a duty from the log.";
	}

	// Single-duty legality
	let combined = [];
	if (selected) {
		const { badges, notes } = dutyLegality(selected, prev);
		combined.push(...badges);
		if (legalityNotes) {
			if (notes.length) {
				legalityNotes.style.display = "block";
				legalityNotes.textContent = notes.join(" ");
			} else {
				legalityNotes.style.display = "none";
				legalityNotes.textContent = "";
			}
		}
	} else {
		if (legalityNotes) {
			legalityNotes.style.display = "none";
			legalityNotes.textContent = "";
		}
	}

	// Rolling windows anchored to selected duty date
	const anchorRef = selected
		? dt(selected.report || selected.sbStart)
		: DateTime.local();
	const roll = rollingStats(duties, anchorRef);
	combined.push(...badgesFromRolling(roll));
	renderBadges(legalityBadges, combined);

	// Flags — compute per item’s own day (accurate historical feed)
	const oldest = DateTime.local().minus({ months: 12 }).startOf("month");
	const byMonth = new Map();
	for (let i = 0; i < duties.length; i++) {
		const d = duties[i],
			dPrev = duties[i + 1] || null,
			when = dt(d.report || d.sbStart);
		if (!when?.isValid || when < oldest) continue;
		const rollAtWhen = rollingStats(duties, when);
		const fs = flagsForDuty(d, dPrev, rollAtWhen);
		if (fs.length) {
			const ym = when.toFormat("yyyy-LL");
			const arr = byMonth.get(ym) || [];
			for (const f of fs)
				arr.push({
					level: f.level,
					text: `${when.toFormat("dd LLL")}: ${f.text}`,
				});
			byMonth.set(ym, arr);
		}
	}
	renderFlagsGrouped(flagsFeed, byMonth);

	// Quick stats + History
	renderQuickStats(quickStatsBox, quickStats(duties));
	renderHistory(historyDiv, duties);
	versionStamp.textContent = APP_VERSION;
}
async function renderAll() {
	await computeAndRender();
}

/* ---------------- Export / Import ---------------- */
function dutiesToJSON(d) {
	return JSON.stringify(d, null, 2);
}
function dutiesFromJSON(text) {
	const arr = JSON.parse(text);
	if (!Array.isArray(arr)) throw new Error("Invalid JSON");
	return arr.map(normalizeDuty);
}
function dutiesToCSV(duties) {
	const heads = [
		"report",
		"off",
		"dutyType",
		"sectors",
		"location",
		"discretionMins",
		"discretionReason",
		"discretionBy",
		"tags",
		"notes",
		"sbType",
		"sbStart",
		"sbEnd",
		"sbCalled",
		"sbCall",
	];
	const esc = (v) =>
		v === null || v === undefined
			? ""
			: /[",\n]/.test(String(v))
			? `"${String(v).replace(/"/g, '""')}"`
			: String(v);
	const rows = [heads.join(",")];
	for (const d of duties)
		rows.push(heads.map((h) => esc(d[h] ?? "")).join(","));
	return rows.join("\n");
}
async function exportJSON() {
	const duties = await getAllDutiesSorted();
	const blob = new Blob([dutiesToJSON(duties)], { type: "application/json" });
	downloadBlob(
		blob,
		`duties-${DateTime.local().toFormat("yyyyLLdd-HHmm")}.json`
	);
	toast("Exported JSON", "info", 1600);
}
async function exportCSV() {
	const duties = await getAllDutiesSorted();
	const blob = new Blob([dutiesToCSV(duties)], { type: "text/csv" });
	downloadBlob(
		blob,
		`duties-${DateTime.local().toFormat("yyyyLLdd-HHmm")}.csv`
	);
	toast("Exported CSV", "info", 1600);
}
function downloadBlob(blob, filename) {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

/* ---------------- Events ---------------- */
form?.addEventListener("submit", async (e) => {
	e.preventDefault();
	await saveDuty();
});
btnDeleteDuty?.addEventListener("click", deleteSelected);
btnEditDuty?.addEventListener("click", startEdit);
btnCancelEdit?.addEventListener("click", (e) => {
	e.preventDefault();
	cancelEdit();
});
btnClear?.addEventListener("click", clearAll);
btnExport?.addEventListener("click", async () => {
	const choice = prompt('Export format: type "json" or "csv"', "json");
	if (!choice) return;
	if (choice.toLowerCase().startsWith("c")) await exportCSV();
	else await exportJSON();
});
btnImport?.addEventListener("click", () => importFile.click());
importFile?.addEventListener("change", async (e) => {
	const file = e.target.files?.[0];
	if (file) await importJSONFile(file);
	importFile.value = "";
});
async function importJSONFile(file) {
	const text = await file.text();
	const arr = dutiesFromJSON(text);
	if (!confirm(`Import ${arr.length} duties? This will replace current data.`))
		return;
	await db.transaction("rw", db.duties, async () => {
		await db.duties.clear();
		for (const d of arr) await db.duties.add(d);
	});
	editingId = null;
	selectedId = null;
	setSaveLabel();
	await renderAll();
	toast("Imported data", "success");
}

dutyTypeSel?.addEventListener("change", updateStandbyVisibility);

/* Keyboard: selection, delete, edit shortcut + cancel on Esc */
document.addEventListener("keydown", async (e) => {
	const tag = (e.target.tagName || "").toUpperCase();
	const inField = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
	if (!inField && e.key.toLowerCase() === "e") {
		e.preventDefault();
		await startEdit();
		return;
	}
	if (e.key === "Escape") {
		cancelEdit();
		return;
	}
	if (inField) return;

	if (e.key === "Delete") {
		e.preventDefault();
		await deleteSelected();
	}
	if (e.key === "ArrowUp" || e.key === "ArrowDown") {
		const duties = await getAllDutiesSorted();
		if (!duties.length) return;
		const idx = selectedId ? duties.findIndex((d) => d.id === selectedId) : 0;
		const nextIdx =
			e.key === "ArrowUp"
				? Math.max(0, idx - 1)
				: Math.min(duties.length - 1, idx + 1);
		const next = duties[nextIdx];
		selectedId = next.id;
		await computeAndRender();
	}
});

/* ---------------- Boot ---------------- */
window.addEventListener("load", () => {
	versionStamp.textContent = APP_VERSION;
	updateStandbyVisibility();
	ensureFlagStyles();
	setSaveLabel();
	renderAll();
});
