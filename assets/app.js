// assets/app.js
// UI wiring + rendering. Assumes Dexie DB and Luxon vendor scripts are present.

import {
	addDuty,
	getAllDuty,
	clearAll,
	addSleep,
	getAllSleep,
	loadSettings,
	saveSettings,
} from "./db.js";

import {
	classifyDisruptive,
	fdpLimitAccl,
	splitDutyExtensionMins,
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

let deferredPrompt = null;
let SETTINGS = null;
let SELECTED_ID = null;

const MAX_LIST = 20;

/* ======================== Install prompt ======================== */
window.addEventListener("beforeinstallprompt", (e) => {
	e.preventDefault();
	deferredPrompt = e;
	$("#btnInstall").disabled = false;
});
$("#btnInstall").addEventListener("click", async () => {
	if (!deferredPrompt) return;
	deferredPrompt.prompt();
	deferredPrompt = null;
	$("#btnInstall").disabled = true;
});

/* ======================== Settings form ======================== */
$("#settingsForm").addEventListener("submit", async (e) => {
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
$("#dutyForm").addEventListener("submit", async (e) => {
	e.preventDefault();
	const form = e.target;
	const d = {
		date: form.date.value,
		duty_type: form.dutyType.value || "FDP",
		report: form.report.value,
		off: form.off.value,
		sectors: parseInt(form.sectors.value || "0", 10),
		location: form.location.value || "Home",
		sps: form.sps.value ? parseInt(form.sps.value, 10) : null,
	};
	await addDuty(d);
	await refresh();

	// Reset but keep handy defaults
	form.reset();
	$("#dutyType").value = "FDP";
	$("#sectors").value = 2;
	$("#location").value = "Home";
	$("#sps").value = 3;
});

/* ======================== Sleep form ======================== */
$("#sleepForm").addEventListener("submit", async (e) => {
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

/* ======================== Clear / Export / PDF ======================== */
$("#btnClear").addEventListener("click", async () => {
	if (!confirm("Delete all locally stored data (duties, sleep, settings)?"))
		return;
	await clearAll();
	SELECTED_ID = null;
	await refresh();
});

$("#btnExport").addEventListener("click", async () => {
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
$("#btnPDF").addEventListener("click", async () => {
	const all = await getAllDuty();
	if (!all.length) return alert("No entries to include.");
	const selected = getSelected(all);
	await generatePDF(selected, all);
});

/* ======================== History click (delegated) ======================== */
// History: event delegation (works after re-renders)
$("#history").addEventListener("click", (e) => {
	const li = e.target.closest("li[data-id]");
	if (!li) return;
	const id = li.dataset.id; // keep as string
	if (!id) return;
	SELECTED_ID = id; // store as string
	refresh();
});

/* ======================== Boot / Refresh ======================== */
async function boot() {
	SETTINGS = await loadSettings();
	$("#setChrono").value = SETTINGS.chronotype;
	$(
		"#setBands"
	).value = `${SETTINGS.bands.good},${SETTINGS.bands.caution},${SETTINGS.bands.elevated}`;

	// defaults for New Duty inputs
	$("#dutyType").value = "FDP";
	$("#sectors").value = 2;
	$("#location").value = "Home";
	$("#sps").value = 3;

	await refresh();
}

function getSelected(allDuty) {
	if (!allDuty.length) return null;

	// Normalize SELECTED_ID to string
	if (SELECTED_ID == null) SELECTED_ID = String(allDuty[0].id);

	// Find by string compare to handle number/string mismatches
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
		$("#legalityBadges").innerHTML = "";
		$("#fatigueGauge").textContent = "—";
		$("#fatigueChips").innerHTML = "";
		$("#legalityNotes").innerHTML = "";
	}
}

/* ======================== Legality ======================== */
/** Legality per OM/SA-CATS (acclimatised). Days-off checks included. */
function renderLegality(d, all) {
	const badges = [];

	// FDP limit + actual FDP
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

	// Disruptive
	const flags = classifyDisruptive(d.report, d.off);
	if (flags.length) badges.push(badge(flags.join(" · "), "warn"));

	// Cumulative checks (incl. new avg weekly)
	const cum = computeCumulativeAndDaysOff(all, d.off);
	const tone7 = cum.hours7 <= 60 ? "ok" : "bad";
	badges.push(badge(`Duty last 7d: ${cum.hours7} h (≤60)`, tone7));

	// Keep 28d total visible (optional)
	badges.push(
		badge(`Duty last 28d: ${cum.hours28} h`, cum.hours28 <= 200 ? "ok" : "warn")
	);

	// NEW: Avg weekly duty (28d)
	const toneAvg = cum.avgWeekly28 <= 50 ? "ok" : "bad";
	badges.push(
		badge(`Avg weekly duty (28d): ${cum.avgWeekly28} h (≤50)`, toneAvg)
	);

	// Days-off rules
	if (cum.consecWork > 7) badges.push(badge(`>7 consecutive work days`, "bad"));
	else badges.push(badge(`Consec work days: ${cum.consecWork}`, "ok"));
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
function renderFatigue(d, allSleep) {
	const sleep = sleepMetricsForReport(allSleep, d.report);
	const woclMins = woclOverlapMinutes(d.report, d.off, SETTINGS.chronotype);
	const sps = d.sps || null;

	const awake = timeAwakeAroundDuty(
		allSleep,
		d.report,
		d.off,
		SETTINGS.chronotype
	);
	const score = fatigueScore({
		priorSleep24: sleep.priorSleep24,
		priorSleep48: sleep.priorSleep48,
		timeAwakePeakHrs: awake.untilNextSleep, // peak exposure
		timeAwakeHrs: awake.sinceWakeAtReport, // fallback for visibility
		woclOverlapMins: woclMins,
		sps,
	});

	const { good, caution, elevated } = SETTINGS.bands;

	$("#fatigueGauge").textContent = Math.round(score);
	const chips = [];
	chips.push(chip(`Sleep 24h: ${sleep.priorSleep24}h`));
	chips.push(chip(`Since wake @ report: ${awake.sinceWakeAtReport}h`));
	chips.push(chip(`Since wake @ off: ${awake.sinceWakeAtOff}h`));
	chips.push(
		chip(
			`Until next sleep: ${awake.untilNextSleep}h${
				awake.usedEstimate ? " (est.)" : ""
			}`
		)
	);
	if (woclMins > 0)
		chips.push(
			chip(
				`WOCL: ${woclMins}m ${
					SETTINGS.chronotype !== "neutral" ? `(${SETTINGS.chronotype})` : ""
				}`
			)
		);
	if (sps) chips.push(chip(`SPS ${sps}`));

	if (score < elevated) chips.push(chip("High"));
	else if (score < caution) chips.push(chip("Elevated"));
	else if (score < good) chips.push(chip("Caution"));
	else chips.push(chip("Good"));

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
	const enr = earliestNextReport(latest.off, latest.location);
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

	doc.setFont("helvetica", "bold");
	doc.setFontSize(18);
	doc.text("Safair Duty & Fatigue Summary", pad, y);
	y += 26;

	doc.setFontSize(12);
	doc.setFont("helvetica", "");
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
	doc.text(`Last 7 days duty: ${cum.hours7} h (limit 60)`, pad, y);
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
	doc.setFont("helvetica", "bold");
	doc.text(`Fatigue score: ${Math.round(score)} / 100`, pad, y);
	y += 22;

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

/* ======================== History & Sleep list ======================== */
function makeToggle(label) {
	const btn = document.createElement("button");
	btn.className = "btn ghost small";
	btn.type = "button";
	btn.textContent = label;
	return btn;
}

function renderHistory(all) {
	const wrap = $("#history");
	wrap.innerHTML = "";
	if (!all.length) {
		wrap.textContent = "No entries yet.";
		return;
	}

	let expanded = wrap.dataset.expanded === "1";
	const list = expanded ? all : all.slice(0, MAX_LIST);

	const ul = document.createElement("ul");
	list.forEach((d) => {
		const li = document.createElement("li");
		li.dataset.id = d.id;
		if (d.id === SELECTED_ID) li.classList.add("active");
		li.textContent = `${d.date} • ${d.duty_type} • ${
			d.sectors || 0
		} sectors • ${d.report} → ${d.off}`;
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

boot();
