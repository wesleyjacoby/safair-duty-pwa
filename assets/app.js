// assets/app.js
// UI wiring + rendering. Assumes Dexie DB, Luxon, jsPDF vendor scripts are present.

import {
	addDuty,
	getAllDuty,
	removeDuty,
	clearAll,
	addSleep,
	getAllSleep,
	loadSettings,
	saveSettings,
} from "./db.js";

import {
	classifyDisruptive,
	fdpLimitAccl,
	fatigueScore,
	minutesBetween,
	minToHM,
	earliestNextReport,
	computeCumulativeAndDaysOff,
	sleepMetricsForReport,
	woclOverlapMinutes,
	timeAwakeAroundDuty,
} from "./calc.js";

import { badge, chip, $, renderList } from "./ui.js";

// --- Release identifiers (keep in sync with sw.js) ---
const SW_REG_VERSION = "2.9"; // used for ./sw.js?v=...
const EXPECTED_CACHE = "safair-duty-v2.9"; // must equal CACHE in sw.js
const APP_VERSION = "v2.9"; // fallback label

let deferredPrompt = null;
let SETTINGS = null;
let SELECTED_ID = null;
const MAX_LIST = 20;

/* ======================== Theme ======================== */
function applyTheme(theme) {
	const t = theme === "dark" ? "dark" : "light";
	document.documentElement.setAttribute("data-theme", t);
	const btn = document.getElementById("themeBtn");
	if (btn) btn.setAttribute("aria-pressed", String(t === "dark"));
	const toggle = document.getElementById("themeToggle");
	if (toggle) toggle.checked = t === "dark";
}
async function initTheme() {
	const s = await loadSettings();
	applyTheme(s.theme || "light");
	document.getElementById("themeBtn")?.addEventListener("click", async () => {
		const isDark =
			document.documentElement.getAttribute("data-theme") === "dark";
		const next = isDark ? "light" : "dark";
		SETTINGS = await saveSettings({ theme: next });
		applyTheme(next);
	});
	document
		.getElementById("themeToggle")
		?.addEventListener("change", async (e) => {
			const next = e.target.checked ? "dark" : "light";
			SETTINGS = await saveSettings({ theme: next });
			applyTheme(next);
		});
}

/* ======================== Install prompt ======================== */
window.addEventListener("beforeinstallprompt", (e) => {
	e.preventDefault();
	deferredPrompt = e;
	const btn = $("#btnInstall");
	if (btn) btn.disabled = false;
});
$("#btnInstall")?.addEventListener("click", async () => {
	if (!deferredPrompt) return;
	deferredPrompt.prompt();
	deferredPrompt = null;
	$("#btnInstall").disabled = true;
});

/* ======================== SW updates ======================== */
function showUpdateBar(show = true) {
	const bar = document.getElementById("updateBar");
	if (!bar) return;
	bar.style.display = show ? "flex" : "none";
}

function askSwVersion() {
	return new Promise(async (resolve) => {
		try {
			const reg = await navigator.serviceWorker.getRegistration();
			if (!reg?.active) return resolve(null);
			const ch = new MessageChannel();
			ch.port1.onmessage = (ev) => resolve(ev.data || null);
			reg.active.postMessage({ type: "GET_VERSION" }, [ch.port2]);
		} catch {
			resolve(null);
		}
	});
}

async function setupSwUpdates() {
	if (!("serviceWorker" in navigator)) return;

	const reg = await navigator.serviceWorker.register(
		"./sw.js?v=" + SW_REG_VERSION
	);

	// If an update is already waiting, show the banner
	if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(true);

	// Show banner when a new worker is installed (not first install)
	reg.addEventListener("updatefound", () => {
		const sw = reg.installing;
		if (!sw) return;
		sw.addEventListener("statechange", () => {
			if (sw.state === "installed" && navigator.serviceWorker.controller) {
				showUpdateBar(true);
			}
		});
	});

	// iOS robustness: if active SW version ≠ EXPECTED_CACHE, surface banner
	const meta = await askSwVersion(); // { cache, scope }
	if (meta?.cache && EXPECTED_CACHE && meta.cache !== EXPECTED_CACHE) {
		showUpdateBar(true);
		reg.update?.();
	}

	// Re-check when app becomes visible (helps iOS)
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") reg.update?.();
	});

	// “Reload” button → activate the new SW
	document
		.getElementById("btnUpdateNow")
		?.addEventListener("click", async () => {
			const r = await navigator.serviceWorker.getRegistration();
			r?.waiting?.postMessage({ type: "SKIP_WAITING" });
			// Fallback: if Safari didn’t create .waiting, force a hard reload
			setTimeout(() => {
				window.location.reload();
			}, 800);
		});

	// When the new SW takes control, reload to pick up fresh assets
	navigator.serviceWorker.addEventListener("controllerchange", () => {
		window.location.reload();
	});

	reg.update?.();
}

/* ======================== Version stamp ======================== */
async function setVersionStamp() {
	const el = document.getElementById("versionStamp");
	if (!el) return;
	let label = APP_VERSION;
	const meta = await askSwVersion();
	if (meta?.cache) label = meta.cache;
	const today = new Date().toISOString().slice(0, 10);
	el.textContent = `${label} (${today})`;
}

/* ======================== Settings form ======================== */
$("#settingsForm")?.addEventListener("submit", async (e) => {
	e.preventDefault();
	const [g, c, elev] = $("#setBands")
		.value.split(",")
		.map((n) => parseInt(n.trim(), 10))
		.map((n) => (isNaN(n) ? undefined : n));
	const chrono = $("#setChrono").value;
	SETTINGS = await saveSettings({
		chronotype: chrono,
		bands: {
			good: g ?? SETTINGS.bands.good,
			caution: c ?? SETTINGS.bands.caution,
			elevated: elev ?? SETTINGS.bands.elevated,
		},
	});
	refresh();
});

/* ======================== Duty form ======================== */
$("#dutyForm")?.addEventListener("submit", async (e) => {
	e.preventDefault();
	const form = e.target;
	const d = {
		duty_type: form.dutyType.value || "FDP",
		report: form.report.value,
		off: form.off.value,
		sectors: parseInt(form.sectors.value || "0", 10),
		location: form.location.value || "Home",
		sps: form.sps.value ? parseInt(form.sps.value, 10) : null,
	};
	if (form.date && form.date.value) d.date = form.date.value;
	await addDuty(d);
	await refresh();
	form.reset();
	$("#dutyType").value = "FDP";
	$("#sectors").value = 2;
	$("#location").value = "Home";
	$("#sps").value = 3;
});

/* ======================== Sleep form ======================== */
$("#sleepForm")?.addEventListener("submit", async (e) => {
	e.preventDefault();
	const s = {
		start: $("#sleepStart").value,
		end: $("#sleepEnd").value,
		type: $("#sleepType").value || "main",
		quality: parseInt($("#sleepQuality").value || "3", 10),
	};
	await addSleep(s);
	await refresh();
	e.target.reset();
});

/* ======================== Clear / Export / Import / PDF / Delete ======================== */
$("#btnClear")?.addEventListener("click", async () => {
	if (!confirm("Delete all locally stored data (duties, sleep, settings)?"))
		return;
	await clearAll();
	SELECTED_ID = null;
	await refresh();
});

$("#btnExport")?.addEventListener("click", async () => {
	const payload = {
		exportedAt: new Date().toISOString(),
		settings: await loadSettings(),
		duty: await getAllDuty(),
		sleep: await getAllSleep(),
	};
	const blob = new Blob([JSON.stringify(payload, null, 2)], {
		type: "application/json",
	});
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	document.body.appendChild(a);
	a.style.display = "none";
	a.href = url;
	a.download = `safair-duty-export-${new Date()
		.toISOString()
		.slice(0, 10)}.json`;
	a.click();
	URL.revokeObjectURL(url);
});

$("#btnImport")?.addEventListener("click", () => $("#importFile").click());
$("#importFile")?.addEventListener("change", async (e) => {
	const f = e.target.files?.[0];
	if (!f) return;
	const data = JSON.parse(await f.text());
	const modeReplace = confirm(
		"Import will REPLACE current data. OK to continue?"
	);
	if (!modeReplace) return;
	await clearAll();
	if (data.settings) await saveSettings(data.settings);
	if (Array.isArray(data.duty)) for (const d of data.duty) await addDuty(d);
	if (Array.isArray(data.sleep)) for (const s of data.sleep) await addSleep(s);
	e.target.value = "";
	await refresh();
	alert("Import complete.");
});

$("#btnDeleteDuty")?.addEventListener("click", async () => {
	const all = await getAllDuty();
	const sel = getSelected(all);
	if (!sel) return alert("No entry selected.");
	if (!confirm(`Delete duty on ${sel.date}?`)) return;
	await removeDuty(sel.id);
	SELECTED_ID = null;
	await refresh();
});

$("#btnPDF")?.addEventListener("click", async () => {
	const all = await getAllDuty();
	if (!all.length) return alert("No entries to include.");
	const selected = getSelected(all);
	await generatePDF(selected, all);
});

/* ======================== History click (delegation) ======================== */
$("#history")?.addEventListener("click", (e) => {
	const li = e.target.closest("li[data-id]");
	if (!li) return;
	const id = li.dataset.id;
	if (!id) return;
	SELECTED_ID = String(id);
	refresh();
});

/* ======================== Keyboard shortcuts ======================== */
document.addEventListener("keydown", async (e) => {
	if (!["ArrowUp", "ArrowDown", "Delete"].includes(e.key)) return;
	const all = await getAllDuty();
	if (!all.length) return;
	let idx = Math.max(
		0,
		all.findIndex((d) => String(d.id) === String(SELECTED_ID))
	);
	if (e.key === "ArrowUp") idx = Math.min(idx + 1, all.length - 1); // list is newest→oldest
	if (e.key === "ArrowDown") idx = Math.max(idx - 1, 0);
	if (e.key === "Delete") {
		const sel = all[idx];
		if (sel && confirm(`Delete duty on ${sel.date}?`)) {
			await removeDuty(sel.id);
			SELECTED_ID = null;
			return refresh();
		}
		return;
	}
	SELECTED_ID = String(all[idx].id);
	refresh();
});

/* ======================== Boot / Refresh ======================== */
async function boot() {
	SETTINGS = await loadSettings();
	if ($("#setChrono")) $("#setChrono").value = SETTINGS.chronotype;
	if ($("#setBands"))
		$(
			"#setBands"
		).value = `${SETTINGS.bands.good},${SETTINGS.bands.caution},${SETTINGS.bands.elevated}`;

	await setupSwUpdates(); // register + update checks + banner logic
	await setVersionStamp(); // footer label from active SW (or fallback)
	await initTheme();

	await refresh();
}

function getSelected(allDuty) {
	if (!allDuty.length) return null;
	if (SELECTED_ID == null) SELECTED_ID = String(allDuty[0].id);
	let sel = allDuty.find((d) => String(d.id) === String(SELECTED_ID));
	if (!sel) {
		SELECTED_ID = String(allDuty[0].id);
		sel = allDuty[0];
	}
	return sel;
}

async function refresh() {
	const allDuty = await getAllDuty();
	const allSleep = await getAllSleep();

	renderHistory(allDuty);

	const selected = getSelected(allDuty);
	if (selected) {
		renderLegality(selected, allDuty);
		renderFatigue(selected, allSleep);
	} else {
		if ($("#legalityBadges")) $("#legalityBadges").innerHTML = "";
		if ($("#fatigueGauge")) $("#fatigueGauge").textContent = "—";
		if ($("#fatigueChips")) $("#fatigueChips").innerHTML = "";
		if ($("#legalityNotes")) $("#legalityNotes").innerHTML = "";
	}
}

/* ======================== Advisory SP mapping + policy flags ======================== */
function scoreToSP(score) {
	const s = Math.max(0, Math.min(100, score));
	if (s >= 90) return 2.0;
	if (s >= 80) return 2.5;
	if (s >= 70) return 3.2;
	if (s >= 60) return 3.8;
	if (s >= 50) return 4.6; // near 4.75 gate
	if (s >= 40) return 5.4;
	if (s >= 30) return 6.0;
	return 6.5;
}
function spsPolicyFlags({ spsAtSignOn, predictedSP }) {
	const flags = [];
	if (typeof spsAtSignOn === "number" && spsAtSignOn >= 6) {
		flags.push({
			level: "bad",
			text: "SPS 6–7 at sign-on: off-load per OM/FRMP.",
		});
	}
	if (typeof predictedSP === "number" && predictedSP > 4.75) {
		flags.push({
			level: "warn",
			text: "Predicted SP > 4.75 (advisory) – reduce risk per FRMS.",
		});
	}
	return flags;
}

/* ======================== Legality ======================== */
function renderLegality(d, all) {
	const badges = [];

	const limit = fdpLimitAccl(d.report, d.sectors || 1);
	const actual = minutesBetween(d.report, d.off);
	const remaining = Math.max(0, limit - actual);
	const over = Math.max(0, actual - limit);
	const time = (m) => minToHM(m);

	badges.push(
		badge(
			`FDP: ${time(actual)} / ${time(limit)} ${
				over > 0 ? `(OVER by ${time(over)})` : `(Left ${time(remaining)})`
			}`,
			over > 0 ? "bad" : "ok"
		)
	);

	const flags = classifyDisruptive(d.report, d.off);
	if (flags.length) badges.push(badge(flags.join(" · "), "warn"));

	const cum = computeCumulativeAndDaysOff(all, d.off);

	let tone7 = "ok";
	if (cum.hours7 > 60) tone7 = "bad";
	else if (cum.hours7 > 50) tone7 = "warn";
	badges.push(badge(`Duty last 7d: ${cum.hours7} h`, tone7));

	badges.push(
		badge(`Duty last 28d: ${cum.hours28} h`, cum.hours28 <= 200 ? "ok" : "warn")
	);

	const toneAvg = cum.avgWeekly28 <= 50 ? "ok" : "bad";
	badges.push(
		badge(`Avg weekly duty (28d): ${cum.avgWeekly28} h (≤50)`, toneAvg)
	);

	let toneConsec = "ok";
	if (cum.consecWork > 7) toneConsec = "bad";
	else if (cum.consecWork >= 5) toneConsec = "warn";
	badges.push(badge(`Consec work days: ${cum.consecWork}`, toneConsec));

	badges.push(
		badge(
			`2 off in last 14: ${cum.hasTwoIn14 ? "Yes" : "No"}`,
			cum.hasTwoIn14 ? "ok" : "warn"
		)
	);
	badges.push(
		badge(
			`Days off in last 28: ${cum.offIn28} (≥6)`,
			cum.offIn28 >= 6 ? "ok" : "warn"
		)
	);
	badges.push(
		badge(
			`Avg off/28d over 84d: ${cum.avgOffPer28} (≥8)`,
			cum.avgOffPer28 >= 8 ? "ok" : "warn"
		)
	);

	renderList($("#legalityBadges"), badges);

	const p = document.createElement("div");
	p.innerHTML = `<div class="small muted">
    These values are advisory and simplified (acclimatised). For edge cases, unusual pairings,
    or split duty specifics, always refer to OM / SA-CATS and company FRMS.
  </div>`;
	$("#legalityNotes").innerHTML = "";
	$("#legalityNotes").appendChild(p);
}

/* ======================== Fatigue ======================== */
function toneFromScore(score, bands) {
	if (score < bands.elevated) return { tone: "bad", label: "High" };
	if (score < bands.caution) return { tone: "warn", label: "Elevated" };
	if (score < bands.good) return { tone: "warn", label: "Caution" };
	return { tone: "ok", label: "Good" };
}

function renderFatigue(d, allSleep) {
	const sleep = sleepMetricsForReport(allSleep, d.report);
	const woclMins = woclOverlapMinutes(d.report, d.off, SETTINGS.chronotype);
	const sps = d.sps ?? null;

	const awake = timeAwakeAroundDuty(
		allSleep,
		d.report,
		d.off,
		SETTINGS.chronotype
	);
	const score = fatigueScore({
		priorSleep24: sleep.priorSleep24,
		priorSleep48: sleep.priorSleep48,
		timeAwakePeakHrs: awake.untilNextSleep,
		timeAwakeHrs: awake.sinceWakeAtReport,
		woclOverlapMins: woclMins,
		sps,
	});

	const gauge = $("#fatigueGauge");
	const band = toneFromScore(score, SETTINGS.bands);
	gauge.textContent = Math.round(score);
	gauge.classList.remove("t-ok", "t-warn", "t-bad");
	gauge.classList.add(
		band.tone === "ok" ? "t-ok" : band.tone === "warn" ? "t-warn" : "t-bad"
	);

	const chips = [];
	chips.push(
		chip(
			`Sleep 24h: ${sleep.priorSleep24}h`,
			sleep.priorSleep24 < 4
				? "bad"
				: sleep.priorSleep24 < 6
				? "warn"
				: undefined
		)
	);
	chips.push(chip(`Since wake @ report: ${awake.sinceWakeAtReport}h`));
	chips.push(chip(`Since wake @ off: ${awake.sinceWakeAtOff}h`));
	chips.push(
		chip(
			`Until next sleep: ${awake.untilNextSleep}h${
				awake.usedEstimate ? " (est.)" : ""
			}`,
			awake.untilNextSleep > 18
				? "bad"
				: awake.untilNextSleep > 16
				? "warn"
				: undefined
		)
	);
	if (woclMins > 0)
		chips.push(
			chip(
				`WOCL: ${woclMins}m${
					SETTINGS.chronotype !== "neutral" ? ` (${SETTINGS.chronotype})` : ""
				}`,
				"warn"
			)
		);

	if (sps != null) {
		const spsTone = sps >= 6 ? "bad" : sps >= 5 ? "warn" : undefined;
		chips.push(chip(`SPS ${sps}`, spsTone));
	}

	const spPred = scoreToSP(score);
	chips.push(
		chip(
			`Predicted SP ~ ${spPred.toFixed(2)} (advisory)`,
			spPred > 4.75 ? "warn" : undefined
		)
	);

	const flags = spsPolicyFlags({ spsAtSignOn: sps, predictedSP: spPred });
	for (const f of flags) chips.push(chip(f.text, f.level));

	chips.push(chip(band.label, band.tone));
	renderList($("#fatigueChips"), chips);
}

/* ======================== PDF ======================== */
async function generatePDF(latest, all) {
	const sleepAll = await getAllSleep();
	const { jsPDF } = window.jspdf;
	const doc = new jsPDF({ unit: "pt", format: "a4" });
	const pad = 40;
	let y = pad;

	const cum = computeCumulativeAndDaysOff(all, latest.off);
	const sleep = sleepMetricsForReport(sleepAll, latest.report);
	const woclMins = woclOverlapMinutes(
		latest.report,
		latest.off,
		SETTINGS.chronotype
	);
	const awake = timeAwakeAroundDuty(
		sleepAll,
		latest.report,
		latest.off,
		SETTINGS.chronotype
	);
	const sps = latest.sps || null;

	const meta = await askSwVersion();
	const versionLabel = meta?.cache || APP_VERSION;

	doc.setFont("helvetica", "bold");
	doc.setFontSize(18);
	doc.text("Safair Duty & Fatigue Summary", pad, y);
	y += 26;

	doc.setFontSize(12);
	doc.setFont("helvetica", "");
	doc.text(`Version: ${versionLabel}`, pad, y);
	y += 14;
	doc.text(`Date: ${latest.date}`, pad, y);
	y += 14;
	doc.text(
		`Duty: ${latest.duty_type} • Sectors: ${latest.sectors || 0} • ${
			latest.report
		} → ${latest.off}`,
		pad,
		y
	);
	y += 14;
	doc.text(`Location: ${latest.location || "Home"}`, pad, y);
	y += 18;

	doc.setFont("helvetica", "bold");
	doc.text("Legality", pad, y);
	y += 14;
	const limit = fdpLimitAccl(latest.report, latest.sectors || 1);
	const actual = minutesBetween(latest.report, latest.off);
	const remain = Math.max(0, limit - actual);
	const over = Math.max(0, actual - limit);

	doc.setFont("helvetica", "");
	doc.text(
		`FDP actual: ${minToHM(actual)}  |  FDP limit: ${minToHM(limit)}`,
		pad,
		y
	);
	y += 14;
	if (over > 0) {
		doc.setTextColor(180, 30, 30);
		doc.text(`OVER by ${minToHM(over)}`, pad, y);
		doc.setTextColor(0);
	} else {
		doc.text(`Remaining: ${minToHM(remain)}`, pad, y);
	}
	y += 18;

	const flags = classifyDisruptive(latest.report, latest.off);
	if (flags.length) {
		doc.text(`Disruptive: ${flags.join(", ")}`, pad, y);
		y += 18;
	}

	doc.setFont("helvetica", "bold");
	doc.text("Cumulative", pad, y);
	y += 14;
	doc.setFont("helvetica", "");
	doc.text(`Last 7 days duty: ${cum.hours7} h`, pad, y);
	y += 14;
	doc.text(`Last 28 days total: ${cum.hours28} h`, pad, y);
	y += 14;
	doc.text(
		`Avg weekly over last 28 days: ${cum.avgWeekly28} h (limit 50)`,
		pad,
		y
	);
	y += 18;

	doc.setFont("helvetica", "bold");
	doc.text("Days Off", pad, y);
	y += 14;
	doc.setFont("helvetica", "");
	doc.text(`Consecutive work days (ending today): ${cum.consecWork}`, pad, y);
	y += 14;
	doc.text(`Days off in last 28 days: ${cum.offIn28} (≥6)`, pad, y);
	y += 14;
	doc.text(
		`Two consecutive days off in last 14 days: ${
			cum.hasTwoIn14 ? "Yes" : "No"
		}`,
		pad,
		y
	);
	y += 14;
	doc.text(`Avg days off / 28d over 84d: ${cum.avgOffPer28} (≥8)`, pad, y);
	y += 22;

	doc.setFont("helvetica", "bold");
	doc.text("Fatigue (Advisory)", pad, y);
	y += 14;
	doc.setFont("helvetica", "");
	doc.text(`Chronotype: ${SETTINGS.chronotype}`, pad, y);
	y += 14;
	doc.text(`SPS: ${sps ?? "n/a"}`, pad, y);
	y += 14;
	doc.text(
		`Sleep last 24h: ${sleep.priorSleep24} h | Sleep last 48h: ${sleep.priorSleep48} h`,
		pad,
		y
	);
	y += 14;
	doc.text(
		`Since wake @ report: ${awake.sinceWakeAtReport} h | @ off: ${awake.sinceWakeAtOff} h | Until next sleep: ${awake.untilNextSleep} h`,
		pad,
		y
	);
	y += 14;
	doc.text(`WOCL overlap: ${woclMins} min`, pad, y);
	y += 18;

	const score = fatigueScore({
		priorSleep24: sleep.priorSleep24,
		priorSleep48: sleep.priorSleep48,
		timeAwakePeakHrs: awake.untilNextSleep,
		timeAwakeHrs: awake.sinceWakeAtReport,
		woclOverlapMins: woclMins,
		sps,
	});
	const spPred = scoreToSP(score);
	doc.setFont("helvetica", "bold");
	doc.text(`Fatigue score: ${Math.round(score)} / 100`, pad, y);
	y += 14;
	doc.setFont("helvetica", "");
	doc.text(`Predicted SP (advisory): ~${spPred.toFixed(2)}`, pad, y);
	y += 18;

	const policy = spsPolicyFlags({ spsAtSignOn: sps, predictedSP: spPred });
	if (policy.length) {
		for (const f of policy) {
			if (f.level === "bad") doc.setTextColor(180, 30, 30);
			else if (f.level === "warn") doc.setTextColor(176, 128, 0);
			doc.text(`• ${f.text}`, pad, y);
			y += 14;
			doc.setTextColor(0);
		}
		y += 6;
	}

	const next = earliestNextReport(latest.off, latest.location);
	doc.setFont("helvetica", "bold");
	doc.text("Earliest Next Report", pad, y);
	y += 14;
	doc.setFont("helvetica", "");
	doc.text(`${next.earliest.toISO({ suppressMilliseconds: true })}`, pad, y);
	y += 14;
	doc.text(`Basis: ${next.basis}`, pad, y);
	y += 22;

	doc.setFont("helvetica", "italic");
	doc.setTextColor(120);
	doc.text(
		"Advisory only; supports judgement and company FRMS. Not a substitute for OM/FRMP.",
		pad,
		y
	);

	doc.save(`safair-duty-${latest.date}.pdf`);
}

/* ======================== History & list ======================== */
function makeToggle(label) {
	const btn = document.createElement("button");
	btn.className = "btn ghost small";
	btn.type = "button";
	btn.textContent = label;
	return btn;
}

function renderHistory(all) {
	const wrap = $("#history");
	if (!wrap) return;
	wrap.innerHTML = "";
	if (!all.length) {
		wrap.textContent = "No entries yet.";
		return;
	}

	let expanded = wrap.dataset.expanded === "1";
	const list = expanded ? all : all.slice(0, MAX_LIST);

	const ul = document.createElement("ul");
	ul.setAttribute("role", "listbox");
	list.forEach((d) => {
		const li = document.createElement("li");
		li.dataset.id = d.id;
		if (String(d.id) === String(SELECTED_ID)) li.classList.add("active");
		li.textContent = `${d.date} • ${d.duty_type} • ${
			d.sectors || 0
		} sectors • ${d.report} → ${d.off}`;
		li.setAttribute("role", "option");
		ul.appendChild(li);
	});
	wrap.appendChild(ul);

	if (all.length > MAX_LIST) {
		const btn = makeToggle(
			expanded ? "Show less" : `Show more (${all.length - MAX_LIST})`
		);
		btn.addEventListener("click", () => {
			wrap.dataset.expanded = expanded ? "0" : "1";
			renderHistory(all);
		});
		wrap.appendChild(btn);
	}
}

// Kick things off
boot();
