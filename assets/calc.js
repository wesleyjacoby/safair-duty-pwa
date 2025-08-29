// assets/calc.js
// Core calculations for legality, fatigue, and cumulative limits.
// Uses the global Luxon (UMD): <script src="vendor/luxon.min.js"></script>
const { DateTime, Interval } = luxon;

/* ======================== Config ======================== */
// Treat all OM time-bands in local SA time unless you later add time-zone inputs.
const LOCAL_TZ = "Africa/Johannesburg";

// WOCL window per FRMP alignment: 02:00–06:00 (with ±30m chronotype shift)
const WOCL_START = { h: 2, m: 0 };
const WOCL_END = { h: 6, m: 0 };

/* FDP table (minutes): acclimatised, two-pilot, scheduled.
   Bands are local report-time ranges; columns are sectors 1..8.
   Replace numbers if your OM has slightly different values. */
const FDP_TABLE = {
	"0500-0659": [780, 735, 690, 645, 600, 555, 540, 540], // 13:00, 12:15, ...
	"0700-1359": [840, 795, 750, 705, 660, 615, 570, 540], // 14:00, 13:15, ...
	"1400-2059": [780, 735, 690, 645, 600, 555, 540, 540],
	"2100-2159": [720, 675, 630, 585, 540, 540, 540, 540],
	"2200-0459": [660, 615, 570, 540, 540, 540, 540, 540],
};

/* ======================== Utilities ======================== */
export function minutesBetween(aIso, bIso) {
	const a = DateTime.fromISO(aIso);
	const b = DateTime.fromISO(bIso);
	if (!a.isValid || !b.isValid) return 0;
	return Math.max(0, b.diff(a, "minutes").minutes);
}

export function minToHM(mins) {
	const m = Math.max(0, Math.round(mins));
	const h = Math.floor(m / 60);
	const mm = `${m % 60}`.padStart(2, "0");
	return `${h}:${mm}`;
}

function localize(dt) {
	return dt.setZone(LOCAL_TZ, { keepLocalTime: true });
}

/* ======================== Disruptive flags (advisory) ======================== */
export function classifyDisruptive(reportIso, offIso) {
	const rpt = DateTime.fromISO(reportIso);
	const off = DateTime.fromISO(offIso);
	if (!rpt.isValid || !off.isValid) return [];

	const rLocal = localize(rpt);
	const oLocal = localize(off);
	const flags = [];

	if (rLocal.hour === 5) flags.push("Early start");
	if (oLocal.hour >= 23 || oLocal.hour <= 1) flags.push("Late finish");

	// Night duty if any overlap with 02:00–04:59 local
	const nightStart = rLocal.startOf("day").set({ hour: 2 });
	const nightEnd = rLocal.startOf("day").set({ hour: 5 });
	const duty = Interval.fromDateTimes(rLocal, oLocal);
	if (duty.overlaps(Interval.fromDateTimes(nightStart, nightEnd)))
		flags.push("Night duty");

	return flags;
}

/* ======================== FDP Limit: OM-style table lookup ======================== */
export function fdpLimitAccl(reportIso, sectors = 1) {
	const rpt = DateTime.fromISO(reportIso);
	if (!rpt.isValid) return 0;
	const r = localize(rpt);
	const hhmm = r.toFormat("HHmm");
	let band = "2200-0459";
	if (hhmm >= "0500" && hhmm <= "0659") band = "0500-0659";
	else if (hhmm >= "0700" && hhmm <= "1359") band = "0700-1359";
	else if (hhmm >= "1400" && hhmm <= "2059") band = "1400-2059";
	else if (hhmm >= "2100" && hhmm <= "2159") band = "2100-2159";
	// else remains 2200-0459
	const s = Math.max(1, Math.min(8, sectors | 0));
	return FDP_TABLE[band][s - 1] || 0;
}

/* ======================== Split duty extension (placeholder) ======================== */
export function splitDutyExtensionMins(consecutiveRestMins) {
	const r = Math.max(0, consecutiveRestMins | 0);
	if (r < 180) return 0;
	return Math.floor(r / 2);
}

/* ======================== Earliest next report (rest rules) ======================== */
export function earliestNextReport(offIso, location = "Home") {
	const off = DateTime.fromISO(offIso);
	if (!off.isValid)
		return { earliest: DateTime.invalid("bad off"), basis: "invalid" };

	if (location === "Home") {
		return { earliest: off.plus({ hours: 12 }), basis: "Home: 12h min rest" };
	}

	// Away logic with local-night heuristic
	const try10 = off.plus({ hours: 10 });
	const restInt10 = Interval.fromDateTimes(off, try10);

	const dn = off.startOf("day");
	const night1 = Interval.fromDateTimes(dn.set({ hour: 22 }), dn.endOf("day"));
	const night2 = Interval.fromDateTimes(
		dn.minus({ days: 1 }).set({ hour: 22 }),
		dn.set({ hour: 8 })
	);

	const hasNight10 = restInt10.overlaps(night1) || restInt10.overlaps(night2);
	if (hasNight10)
		return { earliest: try10, basis: "Away: 10h incl. local night" };

	const try12 = off.plus({ hours: 12 });
	const restInt12 = Interval.fromDateTimes(off, try12);
	const hasNight12 = restInt12.overlaps(night1) || restInt12.overlaps(night2);
	if (hasNight12)
		return { earliest: try12, basis: "Away: 12h rest (no local night in 10h)" };

	const try14 = off.plus({ hours: 14 });
	return { earliest: try14, basis: "Away: 14h rest (outside local night)" };
}

/* ======================== Sleep metrics for fatigue ======================== */
export function sleepMetricsForReport(allSleep, reportIso) {
	const report = DateTime.fromISO(reportIso);
	const sleeps = (allSleep || [])
		.map((s) => ({
			start: DateTime.fromISO(s.start),
			end: DateTime.fromISO(s.end),
			type: s.type,
			quality: s.quality || 3,
		}))
		.filter((s) => s.start.isValid && s.end.isValid)
		.sort((a, b) => a.start - b.start);

	const win24 = Interval.fromDateTimes(report.minus({ hours: 24 }), report);
	const win48 = Interval.fromDateTimes(report.minus({ hours: 48 }), report);

	function sumOverlapHours(win) {
		let total = 0;
		for (const s of sleeps) {
			const iv = Interval.fromDateTimes(s.start, s.end);
			const ov = win.intersection(iv);
			if (ov) total += ov.length("hours");
		}
		return Math.round(total * 10) / 10;
	}

	// Last wake before report
	let lastWake = null;
	for (let i = sleeps.length - 1; i >= 0; i--) {
		if (sleeps[i].end <= report) {
			lastWake = sleeps[i].end;
			break;
		}
	}
	if (!lastWake) {
		const d = report.startOf("day").set({ hour: 7 });
		lastWake = d > report ? d.minus({ days: 1 }) : d;
	}

	return {
		priorSleep24: sumOverlapHours(win24),
		priorSleep48: sumOverlapHours(win48),
		lastWake,
	};
}

/* ======================== WOCL overlap ======================== */
export function woclOverlapMinutes(reportIso, offIso, chronotype = "neutral") {
	const rpt = localize(DateTime.fromISO(reportIso));
	const off = localize(DateTime.fromISO(offIso));
	if (!rpt.isValid || !off.isValid) return 0;

	let shiftMin = 0;
	if (chronotype === "early") shiftMin = -30;
	if (chronotype === "late") shiftMin = 30;

	const day = rpt.startOf("day");
	const start = day
		.set({ hour: WOCL_START.h, minute: WOCL_START.m })
		.plus({ minutes: shiftMin });
	const end = day
		.set({ hour: WOCL_END.h, minute: WOCL_END.m })
		.plus({ minutes: shiftMin });

	const duty = Interval.fromDateTimes(rpt, off);
	const wocl = Interval.fromDateTimes(start, end);
	const ov = duty.overlaps(wocl) ? duty.intersection(wocl) : null;
	return ov ? Math.round(ov.length("minutes")) : 0;
}

/* ======================== Peak time awake around duty ======================== */
function estimateBedtime(offIso, chronotype = "neutral") {
	const off = DateTime.fromISO(offIso);
	const map = {
		early: { h: 21, m: 30 },
		neutral: { h: 22, m: 30 },
		late: { h: 23, m: 30 },
	};
	const t = map[chronotype] || map.neutral;
	let bed = off.set({ hour: t.h, minute: t.m, second: 0, millisecond: 0 });
	if (bed < off) bed = bed.plus({ days: 1 });
	return bed;
}

export function timeAwakeAroundDuty(allSleep, reportIso, offIso, chronotype) {
	const { lastWake } = sleepMetricsForReport(allSleep, reportIso);
	const report = DateTime.fromISO(reportIso);
	const off = DateTime.fromISO(offIso);

	let sinceWakeAtReport = 0;
	let sinceWakeAtOff = 0;
	let untilNextSleep = 0;
	let usedEstimate = false;

	if (lastWake && lastWake.isValid) {
		sinceWakeAtReport = Math.max(0, report.diff(lastWake, "hours").hours);
		sinceWakeAtOff = Math.max(0, off.diff(lastWake, "hours").hours);
	} else {
		const fallback = report.startOf("day").set({ hour: 7 });
		sinceWakeAtReport = Math.max(0, report.diff(fallback, "hours").hours);
		sinceWakeAtOff = Math.max(0, off.diff(fallback, "hours").hours);
		usedEstimate = true;
	}

	const nextSleep = estimateBedtime(offIso, chronotype);
	untilNextSleep = Math.max(0, nextSleep.diff(off, "hours").hours);

	return {
		sinceWakeAtReport: Math.round(sinceWakeAtReport * 10) / 10,
		sinceWakeAtOff: Math.round(sinceWakeAtOff * 10) / 10,
		untilNextSleep: Math.round(untilNextSleep * 10) / 10,
		usedEstimate,
	};
}

/* ======================== Fatigue score (advisory) ======================== */
export function fatigueScore({
	priorSleep24,
	priorSleep48,
	timeAwakeHrs,
	timeAwakePeakHrs,
	woclOverlapMins,
	sps,
}) {
	const awake =
		typeof timeAwakePeakHrs === "number" ? timeAwakePeakHrs : timeAwakeHrs;
	let score = 100;

	// Sleep debt penalties
	if (priorSleep24 < 7) score -= (7 - priorSleep24) * 6;
	if (priorSleep48 < 14) score -= (14 - priorSleep48) * 2;

	// Wakefulness penalties (nonlinear)
	if (awake > 12) score -= (awake - 12) * 3;
	if (awake > 16) score -= (awake - 16) * 5;
	if (awake > 18) score -= (awake - 18) * 7;

	// WOCL exposure
	score -= Math.min(60, woclOverlapMins || 0) * 0.4;

	// SPS (1–7, neutral at 3)
	if (sps && sps >= 1 && sps <= 7) score -= (sps - 3) * 4;

	return Math.max(0, Math.min(100, Math.round(score)));
}

/* ======================== Cumulative + Days-off ======================== */
export function computeCumulativeAndDaysOff(allDuties, refIso) {
	const ref = DateTime.fromISO(refIso);
	if (!ref.isValid)
		return {
			hours7: 0,
			hours28: 0,
			avgWeekly28: 0,
			consecWork: 0,
			offIn28: 0,
			hasTwoIn14: false,
			avgOffPer28: 0,
		};

	const normalized = (allDuties || [])
		.map((d) => {
			const report = DateTime.fromISO(d.report || d.reportIso);
			const off = DateTime.fromISO(d.off || d.offIso);
			const mins =
				report.isValid && off.isValid ? off.diff(report, "minutes").minutes : 0;
			return { ...d, report, off, mins };
		})
		.filter((d) => d.report.isValid && d.off.isValid && d.mins > 0);

	const win7Start = ref.minus({ days: 6 }).startOf("day");
	const win28Start = ref.minus({ days: 27 }).startOf("day");

	function sumDutyMinutesWithin(startDT, endDT) {
		const win = Interval.fromDateTimes(startDT, endDT.endOf("day"));
		let total = 0;
		for (const d of normalized) {
			const iv = Interval.fromDateTimes(d.report, d.off);
			const ov = win.intersection(iv);
			if (ov) total += ov.length("minutes");
		}
		return total;
	}

	const mins7 = sumDutyMinutesWithin(win7Start, ref);
	const mins28 = sumDutyMinutesWithin(win28Start, ref);

	const hours7 = Math.round((mins7 / 60) * 10) / 10;
	const hours28 = Math.round((mins28 / 60) * 10) / 10;
	const avgWeekly28 = Math.round((hours28 / 4) * 10) / 10;

	// Day buckets for last 84 days (for days-off stats)
	const dayBuckets = [];
	for (let i = 83; i >= 0; i--) {
		const day = ref.minus({ days: i }).startOf("day");
		const worked = normalized.some((d) =>
			Interval.fromDateTimes(d.report, d.off).overlaps(
				Interval.fromDateTimes(day.startOf("day"), day.endOf("day"))
			)
		);
		dayBuckets.push({ day, worked });
	}

	// Consecutive work days ending today
	let consecWork = 0;
	for (let i = dayBuckets.length - 1; i >= 0; i--) {
		if (dayBuckets[i].worked) consecWork++;
		else break;
	}

	const last28 = dayBuckets.slice(-28);
	const last14 = dayBuckets.slice(-14);
	const offIn28 = last28.filter((d) => !d.worked).length;

	let hasTwoIn14 = false;
	for (let i = 0; i < last14.length - 1; i++) {
		if (!last14[i].worked && !last14[i + 1].worked) {
			hasTwoIn14 = true;
			break;
		}
	}

	const win1 = dayBuckets.slice(0, 28);
	const win2 = dayBuckets.slice(28, 56);
	const win3 = dayBuckets.slice(56, 84);
	const avgOffPer28 =
		Math.round(
			((win1.filter((d) => !d.worked).length +
				win2.filter((d) => !d.worked).length +
				win3.filter((d) => !d.worked).length) /
				3) *
				10
		) / 10;

	return {
		hours7,
		hours28,
		avgWeekly28,
		consecWork,
		offIn28,
		hasTwoIn14,
		avgOffPer28,
	};
}
