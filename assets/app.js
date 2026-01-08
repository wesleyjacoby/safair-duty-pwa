// assets/app.js
// Rolling windows anchor to selected duty; months default collapsed (persisted).
// Replaced slider with segmented Yes/No; JS keeps hidden #sbCalled in sync.
// Adds Planning Mode assumptions for What-if (ghost duties, in-memory only).

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

import { bootProFromQuery, isPro } from "./modules/premium.js";
import {
	anchorForDraft,
	prevForDraft,
	withDraftDuty,
} from "./modules/whatif.js";

const { DateTime } = luxon;

/* ---------------- Version ---------------- */
const APP_VERSION = "v1.0.7";

/* ---------------- Dexie ---------------- */
const db = new Dexie("safair-duty-db");
db.version(2).stores({ duties: "++id, report, off, dutyType, location" });

/* ---------------- State/els ---------------- */
let selectedId = null;
let editingId = null;

const storageKeys = {
	history: "collapsedMonths.history",
	flags: "collapsedMonths.flags",
	seeded: "collapsedMonths.seeded",
};

const collapsed = {
	history: new Set(
		JSON.parse(localStorage.getItem(storageKeys.history) || "[]")
	),
	flags: new Set(JSON.parse(localStorage.getItem(storageKeys.flags) || "[]")),
};
let seeded = localStorage.getItem(storageKeys.seeded) === "1";

function saveCollapsed() {
	localStorage.setItem(
		storageKeys.history,
		JSON.stringify([...collapsed.history])
	);
	localStorage.setItem(storageKeys.flags, JSON.stringify([...collapsed.flags]));
	localStorage.setItem(storageKeys.seeded, seeded ? "1" : "0");
}

const el = (id) => document.getElementById(id);

const themeBtn = el("themeBtn");
const btnExport = el("btnExport");
const btnImport = el("btnImport");
const importFile = el("importFile");
const btnClear = el("btnClear");

const btnWhatIf = el("btnWhatIf");
const whatIfWrap = el("whatIfWrap");

const legalityBadges = el("legalityBadges");
const legalityNotes = el("legalityNotes");
const legalityContext = el("legalityContext");
const whatIfBadges = el("whatIfBadges");
const whatIfContext = el("whatIfContext");
const quickStatsBox = el("quickStats");
const flagsFeed = el("flagsFeed");
const historyDiv = el("history");
const versionStamp = el("versionStamp");

const form = el("dutyForm");
const btnDeleteDuty = el("btnDeleteDuty");
const btnEditDuty = el("btnEditDuty");
const btnCancelEdit = el("btnCancelEdit");
const dutyTypeSel = el("dutyType");
const sbSection = el("sbSection");

/* segmented control + hidden checkbox */
const sbCalledChk = el("sbCalled");
const sbSeg = el("sbSeg");
const sbYes = el("sbYes");
const sbNo = el("sbNo");

const saveBtn = form?.querySelector('button[type="submit"]');

/* ---------------- Planning Mode elements (optional) ---------------- */
const planBar = el("planBar");
const btnAddAssumption = el("btnAddAssumption");
const btnClearAssumptions = el("btnClearAssumptions");
const assumptionMenu = el("assumptionMenu");
const assumptionCount = el("assumptionCount");

const assumptionEditor = el("assumptionEditor");
const assumptionEditorTitle = el("assumptionEditorTitle");
const assumptionEditorBody = el("assumptionEditorBody");
const btnAssumptionAdd = el("btnAssumptionAdd");
const btnAssumptionCancel = el("btnAssumptionCancel");

const assumptionListWrap = el("assumptionListWrap");
const assumptionList = el("assumptionList");

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

/* ---------------- Flag styles (warn/bad/info) ---------------------------- */
function ensureFlagStyles() {
	if (document.getElementById("flagStyles")) return;
	const s = document.createElement("style");
	s.id = "flagStyles";
	s.textContent = `
    #flagsFeed { list-style: none; padding: 0; margin: 0; }
    #flagsFeed li { margin: 6px 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--bd); background: var(--panel); color: inherit; }
    #flagsFeed li.month-row { background: transparent; border: none; padding: 0; margin: 6px 0 0; }
    #flagsFeed li.flag { display: flex; gap: 10px; align-items: flex-start; }
    #flagsFeed li.flag .msg { flex: 1 1 auto; }
    #flagsFeed li.flag .chip { font-size: 11px; line-height: 1; padding: 6px 8px; border-radius: 999px; border: 1px solid currentColor; }
    #flagsFeed li.warn { border-color: #b26a00; background: rgba(178,106,0,0.10); color:#6b4800; }
    #flagsFeed li.warn .chip { color: #8a5a00; background: rgba(178,106,0,0.10); border-color: #b26a00; }
    #flagsFeed li.bad  { border-color: #c62828; background: rgba(198,40,40,0.10); color:#662020; }
    #flagsFeed li.bad  .chip { color: #8f1e1e; background: rgba(198,40,40,0.10); border-color: #c62828; }
    #flagsFeed li.info { border-color: #2458e6; background: rgba(36,88,230,0.10); color:#1f3f99; }
    #flagsFeed li.info .chip { color: #1d46b3; background: rgba(36,88,230,0.10); border-color: #2458e6; }
    [data-theme="dark"] #flagsFeed li { border-color: var(--bd); background: var(--panel); }
    [data-theme="dark"] #flagsFeed li.warn { border-color: #6b4800; background: rgba(107,72,0,0.18); color:#d7a049; }
    [data-theme="dark"] #flagsFeed li.warn .chip { color:#ffd18a; background: rgba(107,72,0,0.18); border-color:#d7a049; }
    [data-theme="dark"] #flagsFeed li.bad  { border-color: #662020; background: rgba(102,32,32,0.18); color:#e36a6a; }
    [data-theme="dark"] #flagsFeed li.bad  .chip { color:#ff9b9b; background: rgba(102,32,32,0.18); border-color:#e36a6a; }
    [data-theme="dark"] #flagsFeed li.info { border-color: #1f3f99; background: rgba(31,63,153,0.18); color:#6f8df4; }
    [data-theme="dark"] #flagsFeed li.info .chip { color:#9fb6ff; background: rgba(31,63,153,0.18); border-color:#6f8df4; }
  `;
	document.head.appendChild(s);
}

/* ---------------- Helpers ---------------- */
function updateStandbyVisibility() {
	const isStandby = (dutyTypeSel.value || "").toLowerCase() === "standby";
	if (sbSection) sbSection.style.display = isStandby ? "block" : "none";
}
/* segmented control <-> hidden checkbox sync */
function setSbCalledUI(val) {
	if (sbCalledChk) sbCalledChk.checked = !!val;
	if (sbYes && sbNo) {
		sbYes.checked = !!val;
		sbNo.checked = !val;
	}
}
sbYes?.addEventListener("change", () => setSbCalledUI(true));
sbNo?.addEventListener("change", () => setSbCalledUI(false));

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
		sbType: o.sbType || "Home",
		sbStart: o.sbStart || null,
		sbEnd: o.sbEnd || null,
		sbCalled: !!sbCalledChk?.checked, // use hidden checkbox (kept in sync)
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

	el("sbType").value = n.sbType || "Home";
	el("sbStart").value = n.sbStart
		? DateTime.fromISO(n.sbStart).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	el("sbEnd").value = n.sbEnd
		? DateTime.fromISO(n.sbEnd).toFormat("yyyy-LL-dd'T'HH:mm")
		: "";
	setSbCalledUI(!!n.sbCalled);
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
	if (saveBtn) saveBtn.textContent = editingId ? "Update Duty" : "Save Duty";
}

/* ---------------- Planning assumptions (in-memory only) ------------------ */

let planning = {
	open: false,
	pendingKind: null, // "work" | "standby" | "off"
	items: [], // list of assumptions
	lastCtx: null, // { dutiesCount, ghostCount }
};

function parseHM(hm) {
	const [h, m] = String(hm || "07:00")
		.split(":")
		.map((x) => Number(x || 0));
	return { h: Math.min(23, Math.max(0, h)), m: Math.min(59, Math.max(0, m)) };
}

function nextAssumptionOffsetDays() {
	// These assumptions are ALWAYS relative to the draft duty, and apply *before* it:
	// Day before = -1, then -2, -3 ...
	return -(planning.items.length + 1);
}

function setMenuOpen(open) {
	planning.open = !!open;
	if (assumptionMenu) assumptionMenu.style.display = open ? "block" : "none";
	if (btnAddAssumption)
		btnAddAssumption.setAttribute("aria-expanded", String(open));
}

function hideEditor() {
	if (assumptionEditor) assumptionEditor.style.display = "none";
	if (assumptionEditorBody) assumptionEditorBody.innerHTML = "";
	planning.pendingKind = null;
}

function showEditor(kind) {
	planning.pendingKind = kind;

	if (!assumptionEditor || !assumptionEditorBody || !assumptionEditorTitle)
		return;

	const offsetDays = nextAssumptionOffsetDays();
	const dayLabel =
		offsetDays === -1 ? "Day before" : `${Math.abs(offsetDays)} days before`;

	assumptionEditorTitle.textContent =
		kind === "work" ? "Work day" : kind === "standby" ? "Standby" : "Off day";

	let html = `
		<label>Applies to (relative to the draft duty)
			<input type="text" id="assumpDay" value="${dayLabel}" disabled />
		</label>
	`;

	if (kind === "work") {
		html += `
			<label>Start time
				<input type="time" id="assumpStart" value="07:00" />
			</label>
			<label>Duty length (hours)
				<input type="number" id="assumpHours" min="1" max="18" step="0.5" value="10" />
			</label>
			<label>Sectors
				<input type="number" id="assumpSectors" min="0" max="8" step="1" value="2" />
			</label>
			<label>Location
				<select id="assumpLocation">
					<option>Home</option>
					<option>Away</option>
				</select>
			</label>
		`;
	} else if (kind === "standby") {
		html += `
			<label>Start time
				<input type="time" id="assumpStart" value="06:00" />
			</label>
			<label>Standby length (hours)
				<input type="number" id="assumpHours" min="1" max="18" step="0.5" value="10" />
			</label>
			<label>Standby type
				<select id="assumpSbType">
					<option>Home</option>
					<option>Airport</option>
				</select>
			</label>
			<label>Location
				<select id="assumpLocation">
					<option>Home</option>
					<option>Away</option>
				</select>
			</label>
		`;
	} else {
		html += `
			<label>Note
				<input type="text" id="assumpNote" placeholder="Optional note" />
			</label>
		`;
	}

	assumptionEditorBody.innerHTML = html;
	assumptionEditor.style.display = "block";
}

function renderAssumptionsUI() {
	if (assumptionCount)
		assumptionCount.textContent = `Assumptions (days before draft): ${planning.items.length}`;

	if (!assumptionListWrap || !assumptionList) return;

	if (!planning.items.length) {
		assumptionListWrap.style.display = "none";
		assumptionList.innerHTML = "";
		return;
	}

	assumptionListWrap.style.display = "block";
	assumptionList.innerHTML = "";

	for (let i = 0; i < planning.items.length; i++) {
		const it = planning.items[i];
		const label =
			it.kind === "work"
				? `Work day (${Math.abs(it.offsetDays)}d before) · ${it.startHM} for ${
						it.hours
				  }h · ${it.sectors} legs · ${it.location}`
				: it.kind === "standby"
				? `Standby (${Math.abs(it.offsetDays)}d before) · ${it.startHM} for ${
						it.hours
				  }h · ${it.sbType} · ${it.location}`
				: `Off day (${Math.abs(it.offsetDays)}d before)${
						it.note ? ` · ${it.note}` : ""
				  }`;

		const li = document.createElement("li");
		li.innerHTML = `
			<div class="assump-row">
				<span>${label}</span>
				<button type="button" class="assump-x" data-i="${i}" title="Remove">×</button>
			</div>
		`;
		assumptionList.appendChild(li);
	}

	assumptionList.querySelectorAll(".assump-x").forEach((b) => {
		b.addEventListener("click", () => {
			const idx = Number(b.getAttribute("data-i") || -1);
			if (idx >= 0) {
				planning.items.splice(idx, 1);
				renderAssumptionsUI();
				recomputeWhatIfIfVisible();
			}
		});
	});
}

function ghostDutiesForDraft(draft) {
	const when = dt(draft.report || draft.sbStart);
	if (!when?.isValid) return [];

	const baseDay = when.startOf("day"); // draft day 00:00
	const ghosts = [];

	for (const it of planning.items) {
		const day = baseDay.plus({ days: it.offsetDays });
		if (it.kind === "off") continue;

		const { h, m } = parseHM(it.startHM);
		const start = day.set({ hour: h, minute: m, second: 0, millisecond: 0 });
		const end = start.plus({ minutes: Math.round(Number(it.hours || 0) * 60) });

		if (it.kind === "work") {
			ghosts.push(
				normalizeDuty({
					id: `__GHOST_${Math.abs(it.offsetDays)}__`,
					dutyType: "FDP",
					report: start.toISO(),
					off: end.toISO(),
					sectors: Number(it.sectors || 0),
					location: it.location || "Home",
					discretionMins: 0,
				})
			);
		} else if (it.kind === "standby") {
			ghosts.push(
				normalizeDuty({
					id: `__GHOST_${Math.abs(it.offsetDays)}__`,
					dutyType: "Standby",
					report: null,
					off: null,
					sectors: 0,
					location: it.location || "Home",
					discretionMins: 0,
					sbType: it.sbType || "Home",
					sbStart: start.toISO(),
					sbEnd: end.toISO(),
					sbCalled: false,
					sbCall: null,
				})
			);
		}
	}

	return ghosts;
}

async function recomputeWhatIfIfVisible() {
	if (!whatIfShown) return;
	await simulateWhatIf(true);
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

function isNonCountingWindowType(typeLower) {
	return (
		typeLower === "flight watch" ||
		typeLower === "home reserve" ||
		typeLower === "sick"
	);
}

function isSickType(typeLower) {
	return typeLower === "sick";
}

async function saveDuty() {
	const d = formToDuty();

	const type = String(d.dutyType || "").toLowerCase();
	const isStandby = type === "standby";
	const isNonCountingWindow = isNonCountingWindowType(type);
	const isSick = isSickType(type);

	const hasFDP = Boolean(d.report && d.off);

	// Standby-only: require standby window.
	if (isStandby && !d.sbCalled && !hasFDP) {
		if (!d.sbStart || !d.sbEnd) {
			alert("Please enter Standby Window Start and End.");
			return;
		}
		d.sectors = 0;
	} else if (isNonCountingWindow) {
		// FIX: Sick can be saved with NO times.
		// (If you *do* enter one time, require the other too.)
		if (isSick) {
			const any = Boolean(d.report || d.off);
			const both = Boolean(d.report && d.off);
			if (any && !both) {
				alert(
					"For Sick: either leave times blank, or enter both Sign On and Sign Off."
				);
				return;
			}
			if (both && dt(d.off) <= dt(d.report)) {
				alert("Sign off must be after sign on.");
				return;
			}
			d.sectors = 0;
		} else {
			// Flight Watch / Home Reserve: must have report/off (your current rule)
			if (!d.report || !d.off) {
				alert("Please enter both Sign On and Sign Off.");
				return;
			}
			if (dt(d.off) <= dt(d.report)) {
				alert("Sign off must be after sign on.");
				return;
			}
			d.sectors = 0;
		}
	} else {
		// Normal duties: must have report/off
		if (!d.report || !d.off) {
			alert("Please enter both Sign On and Sign Off.");
			return;
		}
		if (dt(d.off) <= dt(d.report)) {
			alert("Sign off must be after sign on.");
			return;
		}
	}

	if (editingId) {
		await db.duties.update(editingId, d);
		toast("Duty updated", "success");
	} else {
		d.id = await db.duties.add(d);
		toast("Duty saved", "success");
	}

	editingId = null;
	setSaveLabel();
	form.reset();
	setSbCalledUI(false); // reset segmented control
	updateStandbyVisibility();

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
	setSbCalledUI(false);
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
	setSbCalledUI(false);
	updateStandbyVisibility();
	toast("Edit cancelled", "info", 1000);
}

/* ---------------- What-if simulator (Pro) ---------------- */
async function simulateWhatIf(recomputeOnly = false) {
	// Normal click toggles; recomputeOnly keeps it visible and just updates badges.
	if (whatIfShown && !recomputeOnly) {
		hideWhatIf();
		return;
	}

	if (!isPro()) {
		toast("What-if is a Pro feature (subscription).", "warn", 2200);
		return;
	}

	// Build draft duty from the current form values.
	const draft = formToDuty();
	delete draft.id;

	const type = String(draft.dutyType || "").toLowerCase();
	const isStandby = type === "standby";
	const isNonCountingWindow = isNonCountingWindowType(type);
	const isSick = isSickType(type);

	const hasFDP = Boolean(draft.report && draft.off);

	// Validate like Save Duty, but don't block with alerts (use toast).
	if (isStandby && !draft.sbCalled && !hasFDP) {
		if (!draft.sbStart || !draft.sbEnd) {
			toast("What-if needs Standby Window Start and End.", "warn", 2400);
			return;
		}
		draft.sectors = 0;
	} else if (isNonCountingWindow) {
		// FIX: Sick in What-if can be blank times; if one time entered, require both.
		if (isSick) {
			const any = Boolean(draft.report || draft.off);
			const both = Boolean(draft.report && draft.off);
			if (any && !both) {
				toast(
					"For Sick: leave times blank, or enter both Sign On and Sign Off.",
					"warn",
					2600
				);
				return;
			}
			if (both && dt(draft.off) <= dt(draft.report)) {
				toast("Sign off must be after sign on.", "warn", 2400);
				return;
			}
			draft.sectors = 0;
		} else {
			if (!draft.report || !draft.off) {
				toast("What-if needs Sign On and Sign Off.", "warn", 2400);
				return;
			}
			if (dt(draft.off) <= dt(draft.report)) {
				toast("Sign off must be after sign on.", "warn", 2400);
				return;
			}
			draft.sectors = 0;
		}
	} else {
		if (!draft.report || !draft.off) {
			toast("What-if needs Sign On and Sign Off.", "warn", 2400);
			return;
		}
		if (dt(draft.off) <= dt(draft.report)) {
			toast("Sign off must be after sign on.", "warn", 2400);
			return;
		}
	}

	const duties = await getAllDutiesSorted();

	// Add ghosts (assumptions) before draft date
	const ghosts = ghostDutiesForDraft(draft);
	const dutiesPlusGhosts = [...duties, ...ghosts];

	// Draft inserted + sorted newest->oldest (IMPORTANT: pass dt + safeMillis)
	const combined = withDraftDuty(dutiesPlusGhosts, draft, dt, safeMillis);

	const prev = prevForDraft(combined);
	const anchor = anchorForDraft(draft, dt);

	// Compute badges (single-duty + rolling)
	const one = dutyLegality({ ...draft }, prev);
	const roll = rollingStats(combined, anchor);
	const badges = [...one.badges, ...badgesFromRolling(roll)];

	planning.lastCtx = { dutiesCount: duties.length, ghostCount: ghosts.length };

	const when = dt(draft.report || draft.sbStart);
	const kind = String(draft.dutyType || "").toUpperCase();
	const ghostInfo = ghosts.length
		? ` · +${ghosts.length} assumptions (before)`
		: "";
	const ctx = `What-if (not saved): ${
		when?.isValid ? when.toFormat("ccc, dd LLL yyyy HH:mm") : "—"
	} · ${kind}${ghostInfo}`;

	showWhatIf(ctx, badges);

	// Planning UI only makes sense when preview is visible
	if (planBar) planBar.style.display = "flex";
	renderAssumptionsUI();

	// Show any single-duty notes (FDP exceed, discretion, etc.)
	if (legalityNotes) {
		if (one.notes?.length) {
			legalityNotes.style.display = "block";
			legalityNotes.textContent = one.notes.join(" ");
		} else {
			// Don't stomp the normal selected-duty notes; leave as-is.
		}
	}
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

let whatIfShown = false;

function hideWhatIf() {
	whatIfShown = false;

	if (whatIfBadges) whatIfBadges.innerHTML = "";

	if (whatIfContext) {
		whatIfContext.textContent = "";
		whatIfContext.style.display = "block"; // it lives in the wrapper now
	}

	if (whatIfWrap) {
		whatIfWrap.classList.remove("ok", "warn", "bad");
		whatIfWrap.style.display = "none";
	}

	// hide planning UI when preview hides
	setMenuOpen(false);
	hideEditor();
	renderAssumptionsUI();
	if (planBar) planBar.style.display = "none";

	if (btnWhatIf) btnWhatIf.textContent = "What-if";
}

function showWhatIf(contextText, badges) {
	whatIfShown = true;

	// Render badges (keep your grid layout)
	if (whatIfBadges) {
		renderBadges(whatIfBadges, badges || []);
	}

	// Set context text
	if (whatIfContext) {
		whatIfContext.textContent = contextText || "What-if preview (not saved)";
	}

	// Determine severity for wrapper tint
	let sev = "ok";
	if ((badges || []).some((b) => b.status === "bad")) sev = "bad";
	else if ((badges || []).some((b) => b.status === "warn")) sev = "warn";

	if (whatIfWrap) {
		whatIfWrap.classList.remove("ok", "warn", "bad");
		whatIfWrap.classList.add(sev);
		whatIfWrap.style.display = "block";
	}

	if (btnWhatIf) btnWhatIf.textContent = "Hide What-if";
}

/* ---------------- Month toggles ---------------- */
function buildMonthToggle(text, ym, set, onToggle) {
	const btn = document.createElement("button");
	btn.className = "month-toggle";
	btn.setAttribute("type", "button");
	const expanded = !set.has(ym);
	btn.setAttribute("aria-expanded", String(expanded));
	btn.innerHTML = `<span class="caret"></span><span>${text}</span>`;
	btn.addEventListener("click", () => {
		if (set.has(ym)) set.delete(ym);
		else set.add(ym);
		saveCollapsed();
		onToggle();
	});
	return btn;
}

function renderFlagsGrouped(listEl, byMonth) {
	listEl.innerHTML = "";
	const months = [...byMonth.keys()].sort().reverse();
	if (!seeded && months.length) {
		months.forEach((m) => collapsed.flags.add(m)); // default collapsed
		seeded = true;
		saveCollapsed();
	}
	if (!months.length) {
		const li = document.createElement("li");
		li.textContent = "No flagged items.";
		listEl.appendChild(li);
		return;
	}
	for (const ym of months) {
		const header = document.createElement("li");
		header.className = "month-row";
		const title = DateTime.fromFormat(ym, "yyyy-LL").toFormat("LLLL yyyy");
		const btn = buildMonthToggle(title, ym, collapsed.flags, () =>
			renderFlagsGrouped(listEl, byMonth)
		);
		header.appendChild(btn);
		listEl.appendChild(header);

		const body = document.createElement("li");
		body.className = "month-body";
		if (collapsed.flags.has(ym)) body.classList.add("collapsed");

		const ul = document.createElement("ul");
		ul.style.listStyle = "none";
		ul.style.padding = "0";
		ul.style.margin = "6px 0 0";
		for (const f of byMonth.get(ym)) {
			const li = document.createElement("li");
			li.className = `flag ${f.level}`;
			li.setAttribute("aria-label", f.level);
			li.innerHTML = `<span class="chip">${f.level.toUpperCase()}</span><span class="msg">${
				f.text
			}</span>`;
			ul.appendChild(li);
		}
		body.appendChild(ul);
		listEl.appendChild(body);
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

	const groups = new Map();
	for (const d of duties) {
		const key = dt(d.report || d.sbStart || Date.now()).toFormat("yyyy-LL");
		(groups.get(key) || groups.set(key, []).get(key)).push(d);
	}
	const months = [...groups.keys()].sort().reverse();
	if (!seeded && months.length) {
		months.forEach((m) => collapsed.history.add(m)); // default collapsed
	}

	for (const ym of months) {
		const wrap = document.createElement("div");
		wrap.className = "month-wrap";

		const head = document.createElement("div");
		const title = DateTime.fromFormat(ym, "yyyy-LL").toFormat("LLLL yyyy");
		const btn = buildMonthToggle(title, ym, collapsed.history, () =>
			renderHistory(div, duties)
		);
		head.appendChild(btn);
		wrap.appendChild(head);

		const body = document.createElement("div");
		body.className = "month-body";
		if (collapsed.history.has(ym)) body.classList.add("collapsed");

		for (const d of groups.get(ym)) {
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
				await computeAndRender();
				renderHistory(div, duties);
			});
			row.addEventListener("keydown", async (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					row.click();
				}
			});
			body.appendChild(row);
		}

		wrap.appendChild(body);
		div.appendChild(wrap);
	}

	if (!seeded && months.length) {
		seeded = true;
		saveCollapsed();
	}
}

async function computeAndRender() {
	const duties = await getAllDutiesSorted();
	// Avoid stale what-if results when the selection/data changes.
	if (whatIfShown) hideWhatIf();

	if (!selectedId && duties.length) selectedId = duties[0].id;

	const selected = duties.find((d) => d.id === selectedId) || null;
	const prev = selected
		? duties[duties.findIndex((d) => d.id === selected.id) + 1] || null
		: null;

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

	const anchorRef = selected
		? dt(selected.report || selected.sbStart)
		: DateTime.local();
	const roll = rollingStats(duties, anchorRef);
	combined.push(...badgesFromRolling(roll));
	renderBadges(legalityBadges, combined);

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
btnWhatIf?.addEventListener("click", () => simulateWhatIf(false));
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

/* Planning Mode UI events (only if HTML exists) */
btnAddAssumption?.addEventListener("click", () => {
	setMenuOpen(!planning.open);
});

assumptionMenu?.addEventListener("click", (e) => {
	const btn = e.target.closest(".assump-item");
	if (!btn) return;
	const kind = btn.getAttribute("data-kind");
	setMenuOpen(false);
	showEditor(kind);
});

btnAssumptionCancel?.addEventListener("click", () => {
	hideEditor();
});

btnAssumptionAdd?.addEventListener("click", () => {
	if (!planning.pendingKind) return;

	const offsetDays = nextAssumptionOffsetDays();

	if (planning.pendingKind === "work") {
		const startHM = el("assumpStart")?.value || "07:00";
		const hours = Number(el("assumpHours")?.value || 10);
		const sectors = Number(el("assumpSectors")?.value || 2);
		const location = el("assumpLocation")?.value || "Home";

		planning.items.push({
			kind: "work",
			offsetDays,
			startHM,
			hours,
			sectors,
			location,
		});
	} else if (planning.pendingKind === "standby") {
		const startHM = el("assumpStart")?.value || "06:00";
		const hours = Number(el("assumpHours")?.value || 10);
		const sbType = el("assumpSbType")?.value || "Home";
		const location = el("assumpLocation")?.value || "Home";

		planning.items.push({
			kind: "standby",
			offsetDays,
			startHM,
			hours,
			sbType,
			location,
		});
	} else {
		const note = el("assumpNote")?.value || "";
		planning.items.push({ kind: "off", offsetDays, note });
	}

	hideEditor();
	renderAssumptionsUI();
	recomputeWhatIfIfVisible();
});

btnClearAssumptions?.addEventListener("click", () => {
	planning.items = [];
	hideEditor();
	setMenuOpen(false);
	renderAssumptionsUI();
	recomputeWhatIfIfVisible();
});

// Close dropdown on outside click
document.addEventListener("click", (e) => {
	if (!planning.open) return;
	const inBtn = btnAddAssumption && btnAddAssumption.contains(e.target);
	const inMenu = assumptionMenu && assumptionMenu.contains(e.target);
	if (!inBtn && !inMenu) setMenuOpen(false);
});

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
	bootProFromQuery();
	versionStamp.textContent = APP_VERSION;
	updateStandbyVisibility();
	ensureFlagStyles();
	setSaveLabel();
	setSbCalledUI(false); // default selection: No
	hideWhatIf();
	renderAssumptionsUI(); // initialize if planning UI exists
	if (planBar) planBar.style.display = "none";
	renderAll();
});
