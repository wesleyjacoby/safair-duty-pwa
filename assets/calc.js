// assets/calc.js
// OM-aligned legality + rolling windows. Assumes crew acclimatised (single table).
const { DateTime, Interval } = luxon;

/** ---------------- Config ---------------- */
export const RULES = {
	windows: {
		last7Days: 7,
		last14Days: 14,
		last28Days: 28,
		avgWeeklyCapHrs: 50, // ≤50 h averaged over 28 days
		maxDuty7DaysHrs: 60, // ≤60 h total duty in any 7 days
	},
};

/** ---------------- Utils ---------------- */
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
	if (n.id === null) delete n.id;
	n.report = d.report ? dt(d.report).toISO() : null;
	n.off = d.off ? dt(d.off).toISO() : null;
	n.dutyType = d.dutyType || "FDP";
	n.sectors = Number(d.sectors ?? 0);
	n.location = d.location || "Home";
	n.discretionMins = Number(d.discretionMins ?? 0);
	n.discretionReason = d.discretionReason || "";
	n.discretionBy = d.discretionBy || "";
	n.tags = d.tags || "";
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
 * Mapping for acclimatised crews only (simplified bands; matches your PDF choice).
 * Index by report band, then sectors 1..8.
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

/** Rest minima (away/home; local night detection) */
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

/** Disruptive classifier */
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

/** Effective standby minutes (clip to call/report if called) */
function effectiveStandbyMins(d) {
	if (!(d.sbStart && (d.sbEnd || d.sbCall || d.report))) return 0;
	const S = dt(d.sbStart);
	let E = null;
	if (d.sbCalled) {
		if (d.sbCall) E = dt(d.sbCall);
		else if (d.report) E = dt(d.report);
		else E = dt(d.sbEnd);
	} else {
		E = dt(d.sbEnd);
	}
	if (!S?.isValid || !E?.isValid || E <= S) return 0;
	return durMins(S, E);
}

/** Single-duty legality */
export function dutyLegality(duty, prevDuty) {
	const badges = [],
		notes = [];
	const type = String(duty.dutyType || "").toLowerCase();
	const isStandby = type === "standby";
	const hasFDP = Boolean(duty.report && duty.off);

	// Standby-only day (no FDP)
	if (isStandby && !duty.sbCalled && !hasFDP && duty.sbStart && duty.sbEnd) {
		const sbM = effectiveStandbyMins(duty); // equals full window here
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

	const sbEffM = effectiveStandbyMins(duty);
	if (sbEffM > 0) {
		const s2 = sbEffM > 12 * 60 ? "bad" : sbEffM >= 11 * 60 ? "warn" : "ok";
		const called = duty.sbCalled && hasFDP;
		badges.push({
			key: "standby",
			status: s2,
			text: `Standby ${called ? "(used) " : ""}${toHM(sbEffM)} (≤12h)`,
		});
	}
	if (isStandby && duty.sbCalled && hasFDP) {
		const sum = sbEffM + fdpM;
		const s3 = sum > 20 * 60 ? "bad" : sum >= 20 * 60 - 30 ? "warn" : "ok";
		badges.push({
			key: "sbFdp",
			status: s3,
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
export function isWorkingDuty(d) {
	return (d?.dutyType || "").toLowerCase() !== "rest";
}
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
	const duties = [...allDuties].sort((a, b) => {
		const A = dt(a.report || a.sbStart || 0),
			B = dt(b.report || b.sbStart || 0);
		return A - B;
	});
	const now = dt(ref);

	function intervalsOf(d) {
		const intervals = [];
		// FDP
		if (d.report && d.off) {
			const R = dt(d.report),
				O = dt(d.off);
			if (R.isValid && O.isValid && O > R) intervals.push({ s: R, e: O });
		}
		// Standby (clip to call or report if called)
		if (d.sbStart && (d.sbEnd || d.sbCall || d.report)) {
			const S = dt(d.sbStart);
			let E = null;
			if (d.sbCalled) {
				if (d.sbCall) E = dt(d.sbCall);
				else if (d.report) E = dt(d.report);
				else E = dt(d.sbEnd);
			} else {
				E = dt(d.sbEnd);
			}
			if (S?.isValid && E?.isValid && E > S) intervals.push({ s: S, e: E });
		}
		return intervals;
	}

	// ✅ Rolling consecutive-hours window (7 days = 168 hours), not calendar days.
	function sumWindow(days) {
		const start = now.minus({ hours: days * 24 });
		const end = now;
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

	const mins7 = sumWindow(RULES.windows.last7Days);
	const mins28 = sumWindow(RULES.windows.last28Days);
	const avgWeeklyHrs28 = mins28 / 4 / 60;

	// Consecutive work days (standby counts)
	const byDay = groupByDay(duties);
	let consecWorkDays = 0;
	for (let i = 0; i < 60; i++) {
		const day = now.minus({ days: i }).toFormat("yyyy-LL-dd");
		const hadWork = (byDay.get(day) || []).some(isWorkingDuty);
		if (hadWork) consecWorkDays++;
		else break;
	}

	// Off-day counts (calendar-day based, as before)
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

	// ✅ Rolling 28-day (672-hour) lookback for discretion count.
	const start28 = now.minus({ hours: RULES.windows.last28Days * 24 });
	let discretionCount28 = 0;
	for (const d of duties) {
		const R = dt(d.report || d.sbStart);
		if (R >= start28 && R <= now && Number(d.discretionMins || 0) > 0)
			discretionCount28++;
	}

	// ✅ NEW: Off days in calendar year (YTD: 1 Jan → anchor day inclusive).
	// We intentionally do NOT count future days in the year (unknown roster) as "off".
	const calYear = now.year;
	const yearStart = now.startOf("year").startOf("day");
	const yearEnd = now.startOf("day"); // anchor day (inclusive)
	let offDaysInYear = 0;
	{
		let cur = yearStart;
		while (cur <= yearEnd) {
			const key = cur.toFormat("yyyy-LL-dd");
			const hadWork = (byDay.get(key) || []).some(isWorkingDuty);
			if (!hadWork) offDaysInYear++;
			cur = cur.plus({ days: 1 });
		}
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

		// NEW fields
		calYear,
		offDaysInYear,
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

	// ✅ NEW pill: appears next to "Off days in 28" in the badge flow.
	b.push({
		key: "offYear",
		status: "ok",
		text: `Off days in ${roll.calYear}: ${roll.offDaysInYear}`,
	});

	b.push({
		key: "disc28",
		status: roll.discretionCount28 > 0 ? "warn" : "ok",
		text: `Discretion (28d): ${roll.discretionCount28}`,
	});
	return b;
}

/** Flags — mirror badge WARN/BAD (plus info) */
export function flagsForDuty(duty, prevDuty, roll) {
	const flags = [];
	const type = String(duty.dutyType || "").toLowerCase();
	const isStandby = type === "standby";
	const hasFDP = Boolean(duty.report && duty.off);

	// Standby-only
	if (isStandby && !duty.sbCalled && !hasFDP) {
		const sbM = effectiveStandbyMins(duty);
		if (sbM > 12 * 60)
			flags.push({ level: "bad", text: `Standby ${toHM(sbM)} exceeds 12h.` });
		else if (sbM >= 11 * 60)
			flags.push({
				level: "warn",
				text: `Standby ${toHM(sbM)} within 1h of 12h cap.`,
			});
		return flags;
	}

	// FDP & sectors
	if (hasFDP) {
		const { mins: lim } = fdpLimitMins(duty);
		const fdp = durMins(duty.report, duty.off);
		if (fdp > lim)
			flags.push({
				level: "bad",
				text: `FDP ${toHM(fdp)} exceeds limit ${toHM(lim)}.`,
			});
		else if (fdp >= lim - 30)
			flags.push({
				level: "warn",
				text: `FDP within 30 min of limit (${toHM(fdp)}/${toHM(lim)}).`,
			});
		if (Number(duty.sectors || 0) <= 0)
			flags.push({ level: "warn", text: "FDP recorded with 0 sectors." });
	}

	// Rest
	if (hasFDP && prevDuty?.off) {
		const restM = durMins(prevDuty.off, duty.report);
		const req = restRequirement(prevDuty, duty);
		if (restM < req.minMins)
			flags.push({
				level: req.minMins - restM >= 60 ? "bad" : "warn",
				text: `Rest ${toHM(restM)} < ${toHM(req.minMins)} (${req.label}).`,
			});
	}

	// Standby attachments
	const sbEffM = effectiveStandbyMins(duty);
	if (sbEffM > 12 * 60)
		flags.push({ level: "bad", text: `Standby ${toHM(sbEffM)} exceeds 12h.` });
	else if (sbEffM >= 11 * 60)
		flags.push({
			level: "warn",
			text: `Standby ${toHM(sbEffM)} within 1h of 12h cap.`,
		});
	if (isStandby && duty.sbCalled && hasFDP) {
		const sum = sbEffM + durMins(duty.report, duty.off);
		if (sum > 20 * 60)
			flags.push({
				level: "bad",
				text: `Standby+FDP ${toHM(sum)} exceeds 20h.`,
			});
		else if (sum >= 20 * 60 - 30)
			flags.push({
				level: "warn",
				text: `Standby+FDP within 30 min of 20h cap (${toHM(sum)}).`,
			});
	}

	// Rolling mirrors
	if (roll) {
		if (roll.mins7 > RULES.windows.maxDuty7DaysHrs * 60)
			flags.push({
				level: "bad",
				text: `Last 7d duty ${toHM(roll.mins7)} > ${
					RULES.windows.maxDuty7DaysHrs
				}h.`,
			});
		else if (roll.mins7 >= RULES.windows.maxDuty7DaysHrs * 60 - 60)
			flags.push({
				level: "warn",
				text: `Last 7d duty within 60 min of ${RULES.windows.maxDuty7DaysHrs}h.`,
			});

		if (roll.avgWeeklyHrs28 > RULES.windows.avgWeeklyCapHrs)
			flags.push({
				level: "bad",
				text: `Avg weekly (28d) ${roll.avgWeeklyHrs28.toFixed(1)}h > 50h.`,
			});
		else if (roll.avgWeeklyHrs28 > RULES.windows.avgWeeklyCapHrs - 2)
			flags.push({
				level: "warn",
				text: `Avg weekly (28d) approaching 50h (${roll.avgWeeklyHrs28.toFixed(
					1
				)}h).`,
			});

		if (roll.consecWorkDays >= 7)
			flags.push({
				level: "bad",
				text: `${roll.consecWorkDays} consecutive work days (≥7).`,
			});
		else if (roll.consecWorkDays >= 6)
			flags.push({
				level: "warn",
				text: `${roll.consecWorkDays} consecutive work days (≥6).`,
			});

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
	}

	// Info
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

/** Quick stats (lightweight) */
export function quickStats(all) {
	const d = [...all];
	if (!d.length)
		return {
			averages: { avgDutyLen: 0, avgSectors: 0, commonReportWindow: "" },
			counts: {
				disruptiveThisMonth: 0,
				withDiscretion: 0,
				airportStandbyCalls: 0,
				awayNightsThisMonth: 0,
			},
			standby: { usedPct: 0, avgCalloutNoticeMins: 0 },
		};

	let totalMins = 0,
		totalDuties = 0,
		totalSectors = 0;
	const windows = [];
	const now = DateTime.local();
	const thisMonthStart = now.startOf("month");
	let disruptiveThisMonth = 0,
		withDiscretion = 0,
		airportStandbyCalls = 0,
		awayNightsThisMonth = 0;
	let sbDays = 0,
		sbUsed = 0,
		callNoticeMins = [];

	for (const x of d) {
		const R = dt(x.report),
			O = dt(x.off),
			S = dt(x.sbStart),
			E = dt(x.sbEnd);
		// Duty length for averages: prefer FDP, fall back to standby-only
		if (R?.isValid && O?.isValid) {
			totalMins += durMins(R, O);
			totalDuties++;
		} else if (S?.isValid && E?.isValid) {
			totalMins += durMins(S, E);
			totalDuties++;
		}
		totalSectors += Number(x.sectors || 0);

		if (R?.isValid) windows.push(R.hour);
		if ((x.discretionMins || 0) > 0) withDiscretion++;

		// Month-specific counts
		if (R?.isValid && R >= thisMonthStart) {
			if (
				R.hour < 7 ||
				(O?.isValid && O.hour >= 23) ||
				R.hour >= 22 ||
				(O?.isValid && O.hour >= 22)
			)
				disruptiveThisMonth++;
			if (String(x.location || "").toLowerCase() === "away")
				awayNightsThisMonth++;
		}

		// Standby stats
		if (S?.isValid && E?.isValid) {
			sbDays++;
			if (x.sbCalled) sbUsed++;
			if (x.sbCalled && x.sbCall) {
				const call = dt(x.sbCall);
				if (call?.isValid && call > S) callNoticeMins.push(durMins(S, call));
			}
			if (String(x.sbType || "").toLowerCase() === "airport" && x.sbCalled)
				airportStandbyCalls++;
		}
	}

	const commonReportWindow = (() => {
		if (!windows.length) return "";
		const buckets = new Array(24).fill(0);
		for (const h of windows) buckets[h]++;
		const best = buckets.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v)[0];
		if (!best || best.v === 0) return "";
		const h = String(best.i).padStart(2, "0");
		return `${h}:00–${String((best.i + 1) % 24).padStart(2, "0")}:00`;
	})();

	const averages = {
		avgDutyLen: totalDuties ? Math.round(totalMins / totalDuties) : 0,
		avgSectors: totalDuties ? totalSectors / totalDuties : 0,
		commonReportWindow,
	};
	const counts = {
		disruptiveThisMonth,
		withDiscretion,
		airportStandbyCalls,
		awayNightsThisMonth,
	};
	const standby = {
		usedPct: sbDays ? Math.round((sbUsed * 100) / sbDays) : 0,
		avgCalloutNoticeMins: callNoticeMins.length
			? Math.round(
					callNoticeMins.reduce((a, b) => a + b, 0) / callNoticeMins.length
			  )
			: 0,
	};

	return { averages, counts, standby };
}
