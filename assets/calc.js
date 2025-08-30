// assets/calc.js
// OM-aligned legality engine — "Always acclimatised" (Table 9-1 only).
// Luxon is loaded globally via index.html.

const { DateTime, Interval, Duration } = luxon;

/** ---------------- Config ---------------- */
export const RULES = {
	localNight: { from: { h: 22, m: 0 }, to: { h: 6, m: 0 } }, // 22:00–06:00
	windows: {
		last7Days: 7,
		last14Days: 14,
		last28Days: 28,
		avgWeeklyCapHrs: 50, // ≤50 h averaged over 4 weeks (28d)
		maxDuty7DaysHrs: 60, // ≤60 h duty in 7 days
	},
};

/** ---------------- Utilities ---------------- */
export function dt(v) {
	return v instanceof DateTime ? v : DateTime.fromISO(v, { zone: "local" });
}
export function durMins(a, b) {
	const A = dt(a),
		B = dt(b);
	if (!A?.isValid || !B?.isValid) return 0;
	return Math.max(0, Math.round(B.diff(A, "minutes").minutes));
}
export function toHM(totalMins) {
	const m = Math.max(0, Math.round(totalMins));
	const h = Math.floor(m / 60);
	const mm = String(m % 60).padStart(2, "0");
	return `${h}:${mm}`;
}
export function dayKey(v) {
	return dt(v).toFormat("yyyy-LL-dd");
}

export function normalizeDuty(d) {
	const n = { ...d };
	n.id ??= crypto.randomUUID?.() ?? String(Math.random());
	n.report = d.report ? dt(d.report).toISO() : null;
	n.off = d.off ? dt(d.off).toISO() : null;
	n.dutyType = d.dutyType || "FDP";
	n.sectors = Number(d.sectors ?? 0);
	n.location = d.location || "Home";
	n.discretionMins = Number(d.discretionMins ?? 0);
	n.discretionReason = d.discretionReason || "";
	n.discretionBy = d.discretionBy || "";
	n.notes = d.notes || "";
	// Standby
	n.sbType = d.sbType || "Home";
	n.sbStart = d.sbStart ? dt(d.sbStart).toISO() : null;
	n.sbEnd = d.sbEnd ? dt(d.sbEnd).toISO() : null;
	n.sbCalled = Boolean(d.sbCalled);
	n.sbCall = d.sbCall ? dt(d.sbCall).toISO() : null;
	return n;
}

/** ---------------- OM Table 9-1 (mins) ----------------
 * Two-pilot, acclimatised, scheduled.
 * Sectors index is 1..8; for 8+ use column 8.
 */
const T9_1 = [
	{
		band: [5 * 60, 6 * 60 + 59],
		mins: [780, 735, 690, 645, 600, 555, 540, 540],
		label: "05:00–06:59",
	},
	{
		band: [7 * 60, 13 * 60 + 59],
		mins: [840, 795, 750, 705, 660, 615, 570, 540],
		label: "07:00–13:59",
	},
	{
		band: [14 * 60, 20 * 60 + 59],
		mins: [780, 735, 690, 645, 600, 555, 540, 540],
		label: "14:00–20:59",
	},
	{
		band: [21 * 60, 21 * 60 + 59],
		mins: [720, 675, 630, 585, 540, 540, 540, 540],
		label: "21:00–21:59",
	},
	{
		band: [22 * 60, 24 * 60 + 59],
		mins: [660, 615, 570, 540, 540, 540, 540, 540],
		label: "22:00–04:59",
	},
	{
		band: [0, 4 * 60 + 59],
		mins: [660, 615, 570, 540, 540, 540, 540, 540],
		label: "22:00–04:59",
	}, // wrap
];
function timeBandContains(minsOfDay, [start, end]) {
	if (start <= end) return minsOfDay >= start && minsOfDay <= end;
	return minsOfDay >= start || minsOfDay <= end; // wrap across midnight
}
function pickBySectors(arr, sectors) {
	const idx = Math.max(1, Math.min(sectors || 1, 8)) - 1;
	return arr[idx];
}

/** FDP limit (mins) — Always Table 9-1 */
export function fdpLimitMins(duty) {
	const sectors = Number(duty.sectors || 1);
	const R = dt(duty.report);
	const t = R.isValid ? R.hour * 60 + R.minute : 7 * 60; // default to 07:00 band if missing
	const row = T9_1.find((r) => timeBandContains(t, r.band)) || T9_1[1];
	return {
		mins: pickBySectors(row.mins, sectors),
		table: "9-1",
		band: row.label,
	};
}

/** Rest minima (simple, practical):
 * Home: ≥12h. Away: ≥10h if local night included, else ≥12h (≥14h if clearly outside local night).
 */
function includesLocalNight(startISO, endISO) {
	const start = dt(startISO),
		end = dt(endISO);
	if (!start?.isValid || !end?.isValid) return false;
	const mkNight = (anchor) =>
		Interval.fromDateTimes(
			anchor.set({ hour: 22, minute: 0, second: 0, millisecond: 0 }),
			anchor
				.plus({ days: 1 })
				.set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
		);
	const rest = Interval.fromDateTimes(start, end);
	return (
		rest.overlaps(mkNight(start.startOf("day"))) ||
		rest.overlaps(mkNight(end.startOf("day")))
	);
}
function restRequirement(prevDuty, upcomingDuty) {
	if (!prevDuty) return { minMins: 0, label: "—" };
	const away = String(upcomingDuty.location || "").toLowerCase() === "away";
	if (!away) return { minMins: 12 * 60, label: "Home base ≥12h" };
	if (includesLocalNight(prevDuty.off, upcomingDuty.report))
		return { minMins: 10 * 60, label: "Away incl. local night ≥10h" };
	const prevOff = dt(prevDuty.off),
		rep = dt(upcomingDuty.report);
	const outsideNight =
		prevOff.hour >= 6 &&
		rep.hour <= 22 &&
		prevOff.startOf("day").toISODate() === rep.startOf("day").toISODate();
	if (outsideNight)
		return { minMins: 14 * 60, label: "Away outside local night ≥14h" };
	return { minMins: 12 * 60, label: "Away, no local night ≥12h" };
}

/** Disruptive classification (info only) */
export function classifyDisruptive(duty) {
	const R = dt(duty.report),
		O = dt(duty.off);
	if (!R.isValid || !O.isValid)
		return { early: false, late: false, night: false, any: false };
	const early = R.hour < 7;
	const night = R.hour >= 22 || R.hour < 6 || O.hour >= 22 || O.hour < 6;
	const late = O.hour >= 23;
	const any = early || night || late;
	return { early, night, late, any };
}

/** Single duty legality */
export function dutyLegality(duty, prevDuty) {
	const badges = [];

	const fdpMins = durMins(duty.report, duty.off);
	badges.push({ key: "fdp", status: "ok", text: `FDP ${toHM(fdpMins)}` });

	const { mins: limit, table, band } = fdpLimitMins(duty);
	let status = "ok";
	if (fdpMins > limit) status = "bad";
	else if (fdpMins >= limit - 30) status = "warn";
	badges.push({
		key: "limit",
		status,
		text: `Max FDP ${toHM(limit)} (T${table}, ${band})`,
	});

	badges.push({
		key: "sectors",
		status: duty.sectors > 0 ? "ok" : "warn",
		text: `Sectors ${duty.sectors}`,
	});

	if (prevDuty) {
		const restM = durMins(prevDuty.off, duty.report);
		const req = restRequirement(prevDuty, duty);
		let rs = "ok";
		if (restM < req.minMins) rs = req.minMins - restM >= 60 ? "bad" : "warn";
		badges.push({
			key: "restOM",
			status: rs,
			text: `Rest ${toHM(restM)} (min ${toHM(req.minMins)} · ${req.label})`,
		});
	} else {
		badges.push({ key: "restOM", status: "ok", text: "Rest —" });
	}

	// Standby limits
	const sbM =
		duty.sbStart && duty.sbEnd ? durMins(duty.sbStart, duty.sbEnd) : 0;
	if (sbM > 0)
		badges.push({
			key: "standby",
			status: sbM > 12 * 60 ? "bad" : "ok",
			text: `Standby ${toHM(sbM)} (≤12h)`,
		});
	if (duty.sbCalled) {
		const sum = sbM + fdpMins;
		badges.push({
			key: "sbFdp",
			status: sum > 20 * 60 ? "bad" : "ok",
			text: `Standby+FDP ${toHM(sum)} (≤20h)`,
		});
	}

	const disc = Number(duty.discretionMins || 0);
	badges.push({
		key: "disc",
		status: disc > 0 ? (disc > 30 ? "warn" : "ok") : "ok",
		text: `Discretion ${disc > 0 ? `${disc} min` : "—"}`,
	});

	const notes = [];
	if (status === "bad")
		notes.push(`FDP exceeds OM T${table} limit by ${toHM(fdpMins - limit)}.`);
	if (disc > 0)
		notes.push(
			`Discretion used: ${disc} min (${duty.discretionReason || "—"}; by ${
				duty.discretionBy || "—"
			}).`
		);
	return { badges, notes };
}

/** Rolling windows & quick stats */
export function isWorkingDuty(d) {
	return (d?.dutyType || "").toLowerCase() !== "rest";
}
export function groupByDay(duties) {
	const map = new Map();
	for (const d of duties) {
		if (!d.report || !d.off) continue;
		const key = dayKey(d.report);
		(map.get(key) || map.set(key, []).get(key)).push(d);
	}
	return map;
}

export function rollingStats(allDuties, ref = DateTime.local()) {
	const duties = [...allDuties]
		.filter((d) => d.report && d.off)
		.sort((a, b) => dt(a.report) - dt(b.report));
	const now = dt(ref);

	const sumWindow = (days) => {
		const start = now.minus({ days }).startOf("day");
		const end = now.endOf("day");
		let m = 0;
		for (const d of duties) {
			if (!isWorkingDuty(d)) continue;
			const R = dt(d.report),
				O = dt(d.off);
			if (R > end || O < start) continue;
			const s = R < start ? start : R;
			const e = O > end ? end : O;
			m += durMins(s, e);
		}
		return m;
	};

	const mins7 = sumWindow(RULES.windows.last7Days);
	const mins28 = sumWindow(RULES.windows.last28Days);
	const avgWeeklyHrs28 = mins28 / 4 / 60;

	const byDay = groupByDay(duties);
	let consecWorkDays = 0;
	for (let i = 0; i < 60; i++) {
		const day = now.minus({ days: i }).toFormat("yyyy-LL-dd");
		const hadWork = (byDay.get(day) || []).some(isWorkingDuty);
		if (hadWork) consecWorkDays++;
		else break;
	}

	const countOffDays = (days) => {
		let count = 0;
		for (let i = 0; i < days; i++) {
			const day = now.minus({ days: i }).toFormat("yyyy-LL-dd");
			const hadWork = (byDay.get(day) || []).some(isWorkingDuty);
			if (!hadWork) count++;
		}
		return count;
	};

	const hasTwoConsecutiveOffIn14 = (() => {
		let streak = 0;
		for (let i = 0; i < RULES.windows.last14Days; i++) {
			const day = now.minus({ days: i }).toFormat("yyyy-LL-dd");
			const hadWork = (byDay.get(day) || []).some(isWorkingDuty);
			if (!hadWork) {
				streak++;
				if (streak >= 2) return true;
			} else streak = 0;
		}
		return false;
	})();

	const offDaysIn28 = countOffDays(RULES.windows.last28Days);
	const meetsSixOffIn28 = offDaysIn28 >= 6;

	const start28 = now.minus({ days: RULES.windows.last28Days }).startOf("day");
	let discretionCount28 = 0;
	for (const d of duties) {
		const R = dt(d.report);
		if (R >= start28 && R <= now && Number(d.discretionMins || 0) > 0)
			discretionCount28++;
	}

	return {
		mins7,
		mins28,
		avgWeeklyHrs28,
		consecWorkDays,
		hasTwoConsecutiveOffIn14,
		offDaysIn28,
		meetsSixOffIn28,
		discretionCount28,
	};
}

export function badgesFromRolling(roll) {
	const b = [];
	const s7 =
		roll.mins7 > RULES.windows.maxDuty7DaysHrs * 60
			? "bad"
			: roll.mins7 > RULES.windows.maxDuty7DaysHrs * 60 - 60
			? "warn"
			: "ok";
	b.push({
		key: "duty7",
		status: s7,
		text: `Last 7d duty ${toHM(roll.mins7)} (≤${
			RULES.windows.maxDuty7DaysHrs
		}h)`,
	});

	let sAvg = "ok";
	if (roll.avgWeeklyHrs28 > RULES.windows.avgWeeklyCapHrs) sAvg = "bad";
	else if (roll.avgWeeklyHrs28 > RULES.windows.avgWeeklyCapHrs - 2)
		sAvg = "warn";
	b.push({
		key: "avgWeekly",
		status: sAvg,
		text: `Avg weekly (28d) ${roll.avgWeeklyHrs28.toFixed(1)} h (≤50h)`,
	});

	b.push({
		key: "consec",
		status:
			roll.consecWorkDays >= 7
				? "bad"
				: roll.consecWorkDays >= 6
				? "warn"
				: "ok",
		text: `Consecutive work days ${roll.consecWorkDays}`,
	});
	b.push({
		key: "twoOff14",
		status: roll.hasTwoConsecutiveOffIn14 ? "ok" : "warn",
		text: `≥2 consecutive off in 14: ${
			roll.hasTwoConsecutiveOffIn14 ? "Yes" : "No"
		}`,
	});
	b.push({
		key: "sixOff28",
		status: roll.meetsSixOffIn28 ? "ok" : "warn",
		text: `Off days in 28: ${roll.offDaysIn28}`,
	});
	b.push({
		key: "disc28",
		status: roll.discretionCount28 > 0 ? "warn" : "ok",
		text: `Discretion (28d): ${roll.discretionCount28}`,
	});
	return b;
}

/** Quick stats & flags (unchanged aside from no tags) */
export function quickStats(allDuties) {
	const duties = allDuties.filter((d) => d.report && d.off).map(normalizeDuty);
	if (!duties.length)
		return {
			averages: {
				avgDutyLen: 0,
				avgSectors: 0,
				earliestReportISO: null,
				latestReportISO: null,
				commonReportWindow: null,
			},
			counts: {
				disruptiveThisMonth: 0,
				withDiscretion: 0,
				airportStandbyCalls: 0,
				awayNightsThisMonth: 0,
			},
			standby: { usedPct: 0, avgCallNoticeMins: 0 },
		};

	let totalLen = 0,
		totalSectors = 0,
		earliest = null,
		latest = null;
	const hourBins = new Map();
	for (const d of duties) {
		totalLen += durMins(d.report, d.off);
		totalSectors += Number(d.sectors || 0);
		const R = dt(d.report);
		if (!earliest || R < earliest) earliest = R;
		if (!latest || R > latest) latest = R;
		hourBins.set(R.hour, (hourBins.get(R.hour) || 0) + 1);
	}
	const avgDutyLen = totalLen / duties.length;
	const avgSectors = totalSectors / duties.length;
	let topHour = null,
		topCount = -1;
	for (const [h, c] of hourBins.entries())
		if (c > topCount) {
			topCount = c;
			topHour = h;
		}
	const commonReportWindow =
		topHour != null
			? `${String(topHour).padStart(2, "0")}:00–${String(
					(topHour + 1) % 24
			  ).padStart(2, "0")}:00`
			: null;

	const now = DateTime.local();
	const startOfMonth = now.startOf("month"),
		endOfMonth = now.endOf("month");
	const inMonth = (d) =>
		dt(d.report) >= startOfMonth && dt(d.report) <= endOfMonth;

	let disruptiveThisMonth = 0,
		withDiscretion = 0,
		airportStandbyCalls = 0,
		awayNightsThisMonth = 0;
	let standbyTotalDays = 0,
		standbyUsedDays = 0,
		callNoticeSum = 0,
		callNoticeCount = 0;

	for (const d of duties) {
		const type = String(d.dutyType || "").toLowerCase();
		if (inMonth(d)) {
			if (classifyDisruptive(d).any) disruptiveThisMonth++;
			if (Number(d.discretionMins || 0) > 0) withDiscretion++;
			if (type.includes("standby") && d.sbCalled) airportStandbyCalls++;
			if (String(d.location || "").toLowerCase() === "away") {
				const R = dt(d.report),
					O = dt(d.off);
				if (R.startOf("day").toISODate() !== O.startOf("day").toISODate())
					awayNightsThisMonth++;
			}
		}
		if (type.includes("standby")) {
			standbyTotalDays++;
			if (d.sbCalled) {
				standbyUsedDays++;
				if (d.sbCall && d.report) {
					callNoticeSum += Math.max(0, durMins(d.sbCall, d.report));
					callNoticeCount++;
				}
			}
		}
	}

	return {
		averages: {
			avgDutyLen,
			avgSectors,
			earliestReportISO: earliest ? earliest.toISO() : null,
			latestReportISO: latest ? latest.toISO() : null,
			commonReportWindow,
		},
		counts: {
			disruptiveThisMonth,
			withDiscretion,
			airportStandbyCalls,
			awayNightsThisMonth,
		},
		standby: {
			usedPct: standbyTotalDays
				? Math.round((standbyUsedDays / standbyTotalDays) * 100)
				: 0,
			avgCallNoticeMins: callNoticeCount
				? Math.round(callNoticeSum / callNoticeCount)
				: 0,
		},
	};
}

export function flagsForDuty(duty, prevDuty, roll) {
	const flags = [];
	const { mins: lim } = fdpLimitMins(duty);
	const fdp = durMins(duty.report, duty.off);
	if (fdp > lim)
		flags.push({
			level: "bad",
			text: `FDP ${toHM(fdp)} exceeds OM limit ${toHM(lim)}.`,
		});
	else if (fdp >= lim - 30)
		flags.push({
			level: "warn",
			text: `FDP within 30 min of OM limit (${toHM(fdp)}/${toHM(lim)}).`,
		});

	if (prevDuty) {
		const restM = durMins(prevDuty.off, duty.report);
		const req = restRequirement(prevDuty, duty);
		if (restM < req.minMins)
			flags.push({
				level: req.minMins - restM >= 60 ? "bad" : "warn",
				text: `Rest ${toHM(restM)} < ${toHM(req.minMins)} (${req.label}).`,
			});
	}

	const sbM =
		duty.sbStart && duty.sbEnd ? durMins(duty.sbStart, duty.sbEnd) : 0;
	if (sbM > 12 * 60)
		flags.push({ level: "bad", text: `Standby ${toHM(sbM)} exceeds 12h.` });
	if (duty.sbCalled) {
		const sum = sbM + fdp;
		if (sum > 20 * 60)
			flags.push({
				level: "bad",
				text: `Standby+FDP ${toHM(sum)} exceeds 20h.`,
			});
	}

	if (!roll.hasTwoConsecutiveOffIn14)
		flags.push({
			level: "warn",
			text: "No ≥2 consecutive off days in last 14.",
		});
	if (!roll.meetsSixOffIn28)
		flags.push({
			level: "warn",
			text: `Only ${roll.offDaysIn28} off days in last 28.`,
		});

	if (classifyDisruptive(duty).any)
		flags.push({ level: "info", text: "Disruptive duty (early/night/late)." });
	if (Number(duty.discretionMins || 0) > 0)
		flags.push({
			level: "info",
			text: `Discretion used: ${duty.discretionMins} min (${
				duty.discretionReason || "—"
			}).`,
		});

	return flags;
}
