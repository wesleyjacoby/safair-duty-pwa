// assets/calc.js
// OM-aligned legality engine — "Always acclimatised" (Table 9-1 only).
const { DateTime, Interval } = luxon;

/** ---------------- Config ---------------- */
export const RULES = {
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
export function toHM(m) {
	m = Math.max(0, Math.round(m));
	const h = Math.floor(m / 60),
		mm = String(m % 60).padStart(2, "0");
	return `${h}:${mm}`;
}
export function dayKey(v) {
	return dt(v).toFormat("yyyy-LL-dd");
}

export function normalizeDuty(d) {
	const n = { ...d };
	if (n.id === null) delete n.id; // Dexie assigns ++id
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

/** ---------------- OM Table 9-1 (mins) ---------------- */
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
	},
];
function timeBandContains(t, [a, b]) {
	return a <= b ? t >= a && t <= b : t >= a || t <= b;
}
function pickBySectors(arr, sec) {
	const i = Math.max(1, Math.min(sec || 1, 8)) - 1;
	return arr[i];
}
export function fdpLimitMins(duty) {
	const sectors = Number(duty.sectors || 1);
	const R = dt(duty.report);
	const t = R.isValid ? R.hour * 60 + R.minute : 7 * 60;
	const row = T9_1.find((r) => timeBandContains(t, r.band)) || T9_1[1];
	return { mins: pickBySectors(row.mins, sectors), band: row.label };
}

/** Rest minima (simple) */
function includesLocalNight(aISO, bISO) {
	const a = dt(aISO),
		b = dt(bISO);
	if (!a?.isValid || !b?.isValid) return false;
	const mkNight = (anchor) =>
		Interval.fromDateTimes(
			anchor.set({ hour: 22, minute: 0, second: 0, millisecond: 0 }),
			anchor
				.plus({ days: 1 })
				.set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
		);
	const rest = Interval.fromDateTimes(a, b);
	return (
		rest.overlaps(mkNight(a.startOf("day"))) ||
		rest.overlaps(mkNight(b.startOf("day")))
	);
}
function restRequirement(prev, upc) {
	if (!prev) return { minMins: 0, label: "—" };
	const away = String(upc.location || "").toLowerCase() === "away";
	if (!away) return { minMins: 12 * 60, label: "Home base ≥12h" };
	if (includesLocalNight(prev.off, upc.report))
		return { minMins: 10 * 60, label: "Away incl. local night ≥10h" };
	const po = dt(prev.off),
		r = dt(upc.report);
	const outside =
		po.hour >= 6 &&
		r.hour <= 22 &&
		po.startOf("day").toISODate() === r.startOf("day").toISODate();
	if (outside)
		return { minMins: 14 * 60, label: "Away outside local night ≥14h" };
	return { minMins: 12 * 60, label: "Away, no local night ≥12h" };
}

/** Disruptive (info) */
export function classifyDisruptive(d) {
	const R = dt(d.report),
		O = dt(d.off);
	if (!R.isValid || !O.isValid)
		return { early: false, late: false, night: false, any: false };
	const early = R.hour < 7,
		late = O.hour >= 23,
		night = R.hour >= 22 || R.hour < 6 || O.hour >= 22 || O.hour < 6;
	return { early, late, night, any: early || late || night };
}

/** Single duty legality */
export function dutyLegality(duty, prevDuty) {
	const badges = [],
		notes = [];
	const type = String(duty.dutyType || "").toLowerCase();
	const isStandby = type === "standby";
	const hasFDP = Boolean(duty.report && duty.off);

	// Standby-only day
	if (isStandby && !duty.sbCalled && !hasFDP && duty.sbStart && duty.sbEnd) {
		const sbM = durMins(duty.sbStart, duty.sbEnd);
		const s = sbM > 12 * 60 ? "bad" : sbM >= 11 * 60 ? "warn" : "ok";
		badges.push({
			key: "standby",
			status: s,
			text: `Standby ${toHM(sbM)} (≤12h)`,
		});
		badges.push({ key: "restOM", status: "ok", text: "Rest — (no FDP)" });
		badges.push({ key: "sectors", status: "ok", text: "Sectors —" });
		const disc = Number(duty.discretionMins || 0);
		badges.push({
			key: "disc",
			status: disc > 0 ? (disc > 30 ? "warn" : "ok") : "ok",
			text: `Discretion ${disc > 0 ? `${disc} min` : "—"}`,
		});
		return { badges, notes };
	}

	// FDP path
	const fdpM = durMins(duty.report, duty.off);
	badges.push({ key: "fdp", status: "ok", text: `FDP ${toHM(fdpM)}` });

	const { mins: limit, band } = fdpLimitMins(duty);
	let s = "ok";
	if (fdpM > limit) s = "bad";
	else if (fdpM >= limit - 30) s = "warn";
	// (1) remove "T-9.1" mention per request
	badges.push({
		key: "limit",
		status: s,
		text: `Max FDP ${toHM(limit)} (${band})`,
	});

	badges.push({
		key: "sectors",
		status: duty.sectors > 0 ? "ok" : "warn",
		text: `Sectors ${duty.sectors || 0}`,
	});

	if (hasFDP && prevDuty?.off) {
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
		badges.push({
			key: "restOM",
			status: "ok",
			text: hasFDP ? "Rest —" : "Rest — (no FDP)",
		});
	}

	const sbM =
		duty.sbStart && duty.sbEnd ? durMins(duty.sbStart, duty.sbEnd) : 0;
	if (sbM > 0)
		badges.push({
			key: "standby",
			status: sbM > 12 * 60 ? "bad" : "ok",
			text: `Standby ${toHM(sbM)} (≤12h)`,
		});
	if (isStandby && duty.sbCalled) {
		const sum = sbM + fdpM;
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

	if (s === "bad")
		notes.push(`FDP exceeds OM limit by ${toHM(duty.off ? fdpM - limit : 0)}.`);
	if (disc > 0)
		notes.push(
			`Discretion used: ${disc} min (${duty.discretionReason || "—"}; by ${
				duty.discretionBy || "—"
			}).`
		);
	return { badges, notes };
}

/** Rolling windows & quick stats */

// Work day = anything except explicit "Rest"
export function isWorkingDuty(d) {
	return (d?.dutyType || "").toLowerCase() !== "rest";
}

// For consecutive-days logic we need to place all work (FDP or Standby) on a calendar day
export function groupByDay(duties) {
	const map = new Map();
	for (const d of duties) {
		const start = d.report || d.sbStart;
		if (!start) continue;
		const key = dayKey(start);
		(map.get(key) || map.set(key, []).get(key)).push(d);
	}
	return map;
}

export function rollingStats(allDuties, ref = DateTime.local()) {
	// sort by start time (report or sbStart)
	const duties = [...allDuties].sort((a, b) => {
		const A = dt(a.report || a.sbStart || 0),
			B = dt(b.report || b.sbStart || 0);
		return A - B;
	});
	const now = dt(ref);

	// Build intervals that represent "duty time" (FDP plus standby portions)
	function intervalsOf(d) {
		const intervals = [];
		// FDP
		if (d.report && d.off) {
			const R = dt(d.report),
				O = dt(d.off);
			if (R.isValid && O.isValid && O > R) intervals.push({ s: R, e: O });
		}
		// Standby (clip to call or report if called)
		if (d.sbStart && d.sbEnd) {
			const S = dt(d.sbStart),
				E = dt(d.sbEnd);
			if (S?.isValid && E?.isValid) {
				let sbEndEff = E;
				if (d.sbCalled) {
					if (d.sbCall) sbEndEff = dt(d.sbCall);
					else if (d.report) sbEndEff = dt(d.report);
				}
				if (sbEndEff > S) intervals.push({ s: S, e: sbEndEff });
			}
		}
		return intervals;
	}

	function sumWindow(days) {
		const start = now.minus({ days }).startOf("day");
		const end = now.endOf("day");
		let minutes = 0;
		for (const d of duties) {
			if (!isWorkingDuty(d)) continue;
			for (const { s, e } of intervalsOf(d)) {
				if (e < start || s > end) continue;
				const clipS = s < start ? start : s;
				const clipE = e > end ? end : e;
				minutes += durMins(clipS, clipE);
			}
		}
		return minutes;
	}

	const mins7 = sumWindow(RULES.windows.last7Days); // (2) includes standby now
	const mins28 = sumWindow(RULES.windows.last28Days);
	const avgWeeklyHrs28 = mins28 / 4 / 60;

	// Consecutive work days (3) — standby counts as work
	const byDay = groupByDay(duties);
	let consecWorkDays = 0;
	for (let i = 0; i < 60; i++) {
		const day = now.minus({ days: i }).toFormat("yyyy-LL-dd");
		const hadWork = (byDay.get(day) || []).some(isWorkingDuty);
		if (hadWork) consecWorkDays++;
		else break;
	}

	// Off-day counts (presence based)
	function countOffDays(days) {
		let c = 0;
		for (let i = 0; i < days; i++) {
			const day = now.minus({ days: i }).toFormat("yyyy-LL-dd");
			const hadWork = (byDay.get(day) || []).some(isWorkingDuty);
			if (!hadWork) c++;
		}
		return c;
	}
	const offDaysIn28 = countOffDays(RULES.windows.last28Days);

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

	// Discretion count in 28d (only when a duty record has discretion mins)
	const start28 = now.minus({ days: RULES.windows.last28Days }).startOf("day");
	let discretionCount28 = 0;
	for (const d of duties) {
		const R = dt(d.report || d.sbStart);
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
		meetsSixOffIn28: offDaysIn28 >= 6,
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

/** Quick stats & flags */
export function quickStats(allDuties) {
	const duties = allDuties.filter((d) => d.report && d.off).map(normalizeDuty);
	if (!duties.length)
		return {
			averages: { avgDutyLen: 0, avgSectors: 0, commonReportWindow: null },
			counts: {
				disruptiveThisMonth: 0,
				withDiscretion: 0,
				airportStandbyCalls: 0,
				awayNightsThisMonth: 0,
			},
			standby: { usedPct: 0, avgCallNoticeMins: 0 },
		};

	let totalLen = 0,
		totalSectors = 0;
	const hourBins = new Map();
	for (const d of duties) {
		totalLen += durMins(d.report, d.off);
		totalSectors += Number(d.sectors || 0);
		const h = dt(d.report).hour;
		hourBins.set(h, (hourBins.get(h) || 0) + 1);
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

	const now = DateTime.local(),
		startOfMonth = now.startOf("month"),
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

	for (const d of allDuties) {
		const type = String(d.dutyType || "").toLowerCase();

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

		if (d.report && d.off) {
			if (inMonth(d)) {
				if (classifyDisruptive(d).any) disruptiveThisMonth++;
				if (Number(d.discretionMins || 0) > 0) withDiscretion++;
				if (String(d.location || "").toLowerCase() === "away") {
					const R = dt(d.report),
						O = dt(d.off);
					if (R.startOf("day").toISODate() !== O.startOf("day").toISODate())
						awayNightsThisMonth++;
				}
			}
		}
	}

	return {
		averages: { avgDutyLen, avgSectors, commonReportWindow },
		counts: {
			disruptiveThisMonth,
			withDiscretion,
			airportStandbyCalls,
			awayNightsThisMonth,
		}, // (5) always present
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
	const type = String(duty.dutyType || "").toLowerCase();
	const isStandby = type === "standby";
	const hasFDP = Boolean(duty.report && duty.off);

	if (isStandby && !duty.sbCalled && !hasFDP) {
		const sbM =
			duty.sbStart && duty.sbEnd ? durMins(duty.sbStart, duty.sbEnd) : 0;
		if (sbM > 12 * 60)
			flags.push({ level: "bad", text: `Standby ${toHM(sbM)} exceeds 12h.` });
		return flags;
	}

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

	if (hasFDP && prevDuty?.off) {
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
	if (isStandby && duty.sbCalled) {
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
