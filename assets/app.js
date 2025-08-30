// assets/app.js
// UI wiring + storage + exports. OM Table 9-1 (always acclimatised).

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
const APP_VERSION = "v1.0.0";

/* ---------------- Dexie ---------------- */
const db = new Dexie("safair-duty-db");
db.version(2).stores({ duties: "++id, report, off, dutyType, location" });

/* ---------------- State/els ---------------- */
let selectedId = null;
const el = (id) => document.getElementById(id);

const themeBtn = el("themeBtn");
const btnExport = el("btnExport");
const btnImport = el("btnImport");
const importFile = el("importFile");
const btnPDF = el("btnPDF");
const btnClear = el("btnClear");

const legalityBadges = el("legalityBadges");
const legalityNotes = el("legalityNotes");
const quickStatsBox = el("quickStats");
const historyDiv = el("history");
const flagsFeed = el("flagsFeed");
const versionStamp = el("versionStamp");

const form = el("dutyForm");
const btnDeleteDuty = el("btnDeleteDuty");
const dutyTypeSel = el("dutyType");
const sbSection = el("sbSection");
const sbCalled = el("sbCalled");

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
function toast(msg, type = "info", ms = 2200) {
	let h = document.getElementById("toasts");
	if (!h) {
		h = document.createElement("div");
		h.id = "toasts";
		h.setAttribute("aria-live", "polite");
		Object.assign(h.style, {
			position: "fixed",
			right: "14px",
			bottom: "14px",
			zIndex: 9999,
			display: "grid",
			gap: "8px",
			maxWidth: "80vw",
		});
		document.body.appendChild(h);
	}
	const e = document.createElement("div");
	e.textContent = msg;
	const bg =
		type === "bad"
			? "#c62828"
			: type === "warn"
			? "#b26a00"
			: type === "success"
			? "#1e8e3e"
			: "#2458e6";
	Object.assign(e.style, {
		padding: "10px 12px",
		borderRadius: "10px",
		color: "#fff",
		font: "14px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Inter,sans-serif",
		boxShadow: "0 6px 20px rgba(0,0,0,.15)",
		background: bg,
	});
	h.appendChild(e);
	setTimeout(() => {
		e.style.opacity = "0";
		e.style.transform = "translateY(6px)";
		e.style.transition = "all .2s ease";
		setTimeout(() => e.remove(), 220);
	}, ms);
}

/* ---------------- Helpers ---------------- */
function formToDuty() {
	const f = new FormData(form);
	const o = Object.fromEntries(f.entries());
	o.sbCalled = sbCalled.checked;
	return normalizeDuty({
		id: selectedId,
		report: o.report,
		off: o.off,
		dutyType: o.dutyType,
		sectors: Number(o.sectors || 0),
		location: o.location,
		discretionMins: Number(o.discretionMins || 0),
		discretionReason: o.discretionReason,
		discretionBy: o.discretionBy,
		notes: o.notes,
		sbType: o.sbType,
		sbStart: o.sbStart || null,
		sbEnd: o.sbEnd || null,
		sbCalled: o.sbCalled,
		sbCall: o.sbCall || null,
	});
}
function dutyToForm(d) {
	const n = normalizeDuty(d);
	form.reset();
	el("report").value = n.report
		? DateTime.fromISO(n.report).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	el("off").value = n.off
		? DateTime.fromISO(n.off).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	dutyTypeSel.value = n.dutyType || "FDP";
	el("sectors").value = Number(n.sectors || 0);
	el("location").value = n.location || "Home";
	el("discretionMins").value = Number(n.discretionMins || 0);
	el("discretionReason").value = n.discretionReason || "";
	el("discretionBy").value = n.discretionBy || "";
	el("notes").value = n.notes || "";
	el("sbType").value = n.sbType || "Home";
	el("sbStart").value = n.sbStart
		? DateTime.fromISO(n.sbStart).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	el("sbEnd").value = n.sbEnd
		? DateTime.fromISO(n.sbEnd).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	sbCalled.checked = !!n.sbCalled;
	el("sbCall").value = n.sbCall
		? DateTime.fromISO(n.sbCall).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	updateStandbyVisibility();
}
function updateStandbyVisibility() {
	const isStandby = (dutyTypeSel.value || "").toLowerCase() === "standby";
	sbSection.style.display = isStandby ? "block" : "none";
}
function safeMillis(v) {
	const D = dt(v);
	return D?.isValid ? D.toMillis() : 0;
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

	if (isStandby && !d.sbCalled && !hasFDP) {
		if (!d.sbStart || !d.sbEnd) {
			alert("Please enter Standby Window Start and End.");
			return;
		}
		d.sectors = 0; // standby-only -> no legs
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

	if (d.id) {
		const updated = await db.duties.update(d.id, d);
		if (!updated) {
			const copy = { ...d };
			delete copy.id;
			d.id = await db.duties.add(copy);
		}
	} else {
		d.id = await db.duties.add(d);
	}

	selectedId = d.id;
	await renderAll();
	toast("Duty saved", "success");
	selectedId = null;
	form.reset();
	updateStandbyVisibility();
}
async function deleteSelected() {
	if (!selectedId) return;
	if (!confirm("Delete selected duty?")) return;
	await db.duties.delete(selectedId);
	selectedId = null;
	form.reset();
	await renderAll();
	toast("Duty deleted", "warn");
}
async function clearAll() {
	if (!confirm("This will clear all local data. Continue?")) return;
	await db.duties.clear();
	selectedId = null;
	form.reset();
	await renderAll();
	toast("All data cleared", "bad");
}

/* ---------------- Render ---------------- */
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
	const months = [...byMonth.keys()].sort().reverse(); // newest first
	if (!months.length) {
		const li = document.createElement("li");
		li.textContent = "No flagged items.";
		listEl.appendChild(li);
		return;
	}
	for (const ym of months) {
		const head = document.createElement("li");
		head.textContent = DateTime.fromFormat(ym, "yyyy-LL").toFormat("LLLL yyyy");
		Object.assign(head.style, {
			background: "transparent",
			border: "none",
			padding: "6px 0 0",
			color: "var(--muted)",
			fontWeight: "700",
		});
		listEl.appendChild(head);
		for (const f of byMonth.get(ym)) {
			const li = document.createElement("li");
			li.innerHTML = `<strong>${f.level.toUpperCase()}:</strong> ${f.text}`;
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
	// (4) remove earliest/latest report cards
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
	); // (5) no undefined now

	if (standby) {
		boxEl.appendChild(make(`Standby used: ${standby.usedPct}%`));
		boxEl.appendChild(
			make(
				`Avg callout notice: ${
					standby.avgCallNoticeMins ? toHM(standby.avgCallNoticeMins) : "—"
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
				selectedId = d.id;
				dutyToForm(d);
				await computeAndRender();
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

	let selected = selectedId ? duties.find((d) => d.id === selectedId) : null;
	if (!selected && duties.length) {
		selected = duties[0];
		selectedId = selected.id;
		dutyToForm(selected);
	}

	const prev = selected
		? duties[duties.findIndex((d) => d.id === selected.id) + 1] || null
		: null;

	// Single-duty legality & notes
	let combined = [];
	if (selected) {
		const { badges, notes } = dutyLegality(selected, prev);
		combined.push(...badges);
		if (notes.length) {
			legalityNotes.style.display = "block";
			legalityNotes.textContent = notes.join(" ");
		} else {
			legalityNotes.style.display = "none";
			legalityNotes.textContent = "";
		}
	} else {
		legalityNotes.style.display = "none";
		legalityNotes.textContent = "";
	}

	// Rolling badges (2 & 3 handled in calc.js)
	const roll = rollingStats(duties, DateTime.local());
	combined.push(...badgesFromRolling(roll));
	renderBadges(legalityBadges, combined);

	// Flagged items (6) — group by month, show up to last 12 months
	const oldest = DateTime.local().minus({ months: 12 }).startOf("month");
	const byMonth = new Map();
	for (let i = 0; i < duties.length; i++) {
		const d = duties[i],
			dPrev = duties[i + 1] || null;
		const when = dt(d.report || d.sbStart);
		if (!when?.isValid || when < oldest) continue;
		const ym = when.toFormat("yyyy-LL");
		const group = byMonth.get(ym) || [];
		const fs = flagsForDuty(d, dPrev, roll);
		for (const f of fs)
			group.push({
				level: f.level,
				text: `${when.toFormat("dd LLL")}: ${f.text}`,
			});
		if (fs.length) byMonth.set(ym, group);
	}
	renderFlagsGrouped(flagsFeed, byMonth);

	// Quick stats & history
	renderQuickStats(quickStatsBox, quickStats(duties));
	renderHistory(historyDiv, duties);
	versionStamp.textContent = APP_VERSION;
}

/* ---------------- Wrapper ---------------- */
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

/* ---------------- PDF ---------------- */
async function exportPDF() {
	const duties = await getAllDutiesSorted();
	const { jsPDF } = window.jspdf;
	const doc = new jsPDF({ orientation: "p", unit: "pt", format: "a4" });
	const margin = 36;
	let y = margin;
	const line = (t, size = 11, bold = false) => {
		doc.setFont("helvetica", bold ? "bold" : "normal");
		doc.setFontSize(size);
		const lines = doc.splitTextToSize(t, 522);
		for (const L of lines) {
			if (y > 800) {
				doc.addPage();
				y = margin;
			}
			doc.text(L, margin, y);
			y += size + 4;
		}
	};

	line("Safair Duty Tracker — Duty Log & Legality (OM-aligned)", 14, true);
	line(APP_VERSION, 10);
	line(DateTime.local().toFormat("cccc, d LLLL yyyy HH:mm"), 10);
	y += 4;

	const roll = rollingStats(duties, DateTime.local());
	const quick = quickStats(duties);
	line("Summary", 12, true);
	line(
		`Last 7d duty: ${toHM(
			roll.mins7
		)} (≤60h) | Avg weekly (28d): ${roll.avgWeeklyHrs28.toFixed(
			1
		)} h (≤50h) | Consecutive work days: ${roll.consecWorkDays}`,
		10
	);
	line(
		`Two-off-in-14: ${
			roll.hasTwoConsecutiveOffIn14 ? "Yes" : "No"
		} | Off days in 28: ${roll.offDaysIn28}`,
		10
	);
	line(
		`Avg duty length: ${toHM(
			quick.averages.avgDutyLen
		)} | Avg sectors: ${quick.averages.avgSectors.toFixed(
			2
		)} | Common report window: ${quick.averages.commonReportWindow || "—"}`,
		10
	);
	y += 6;

	if (duties.length) {
		const sel = duties[0],
			prev = duties[1] || null;
		const fs = flagsForDuty(sel, prev, roll);
		if (fs.length) {
			line("Flagged Items (most recent duty)", 12, true);
			for (const f of fs) line(`[${f.level.toUpperCase()}] ${f.text}`, 10);
			y += 6;
		}
	}

	line("Duties", 12, true);
	line(
		"Date  | Report → Off | Type | Sectors | FDP | Location | Disc (min) | Notes",
		10,
		true
	);
	for (const d of duties) {
		const R = DateTime.fromISO(
			d.report || d.sbStart || DateTime.local().toISO()
		).toFormat("dd LLL yyyy");
		const Rt = d.report
			? DateTime.fromISO(d.report).toFormat("HH:mm")
			: d.sbStart
			? DateTime.fromISO(d.sbStart).toFormat("HH:mm")
			: "—";
		const Ot = d.off
			? DateTime.fromISO(d.off).toFormat("HH:mm")
			: d.sbEnd
			? DateTime.fromISO(d.sbEnd).toFormat("HH:mm")
			: "—";
		const fdp =
			d.report && d.off
				? toHM(durMins(d.report, d.off))
				: d.sbStart && d.sbEnd
				? `SB ${toHM(durMins(d.sbStart, d.sbEnd))}`
				: "—";
		const row = `${R} | ${Rt} → ${Ot} | ${d.dutyType || ""} | ${
			d.sectors || 0
		} | ${fdp} | ${d.location || ""} | ${d.discretionMins || 0} | ${
			d.notes || ""
		}`;
		line(row, 10);
		y += 2;
	}

	doc.save(`duties-${DateTime.local().toFormat("yyyyLLdd-HHmm")}.pdf`);
	toast("PDF generated", "info", 1600);
}

/* ---------------- Events ---------------- */
form?.addEventListener("submit", async (e) => {
	e.preventDefault();
	await saveDuty();
});
btnDeleteDuty?.addEventListener("click", deleteSelected);
btnClear?.addEventListener("click", clearAll);

dutyTypeSel?.addEventListener("change", updateStandbyVisibility);

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
	selectedId = null;
	await renderAll();
	toast("Imported data", "success");
}
btnPDF?.addEventListener("click", exportPDF);

/* Keyboard: selection & delete */
document.addEventListener("keydown", async (e) => {
	if (
		["INPUT", "TEXTAREA", "SELECT"].includes(
			(e.target.tagName || "").toUpperCase()
		)
	)
		return;
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
		dutyToForm(next);
		await computeAndRender();
	}
});

/* ---------------- Boot ---------------- */
window.addEventListener("load", () => {
	versionStamp.textContent = APP_VERSION;
	updateStandbyVisibility();
	renderAll();
});
