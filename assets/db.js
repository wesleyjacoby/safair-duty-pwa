// assets/db.js
// Dexie-backed persistence for duties, sleep, and settings.

export const db = new Dexie("safair-duty");

// v1: duty + sleep
db.version(1).stores({
	duty: "++id, date, duty_type, report, off",
	sleep: "++id, start, end, type",
});

// v2: add settings store
db.version(2).stores({
	duty: "++id, date, duty_type, report, off",
	sleep: "++id, start, end, type",
	settings: "id", // id = "defaults"
});

/* ---------------- Duties ---------------- */
export async function addDuty(entry) {
	// Normalize a few fields
	const e = { ...entry };
	if (!e.date && e.report) {
		try {
			e.date = new Date(e.report).toISOString().slice(0, 10);
		} catch {}
	}
	if (typeof e.sectors === "string") e.sectors = parseInt(e.sectors || "0", 10);
	return db.duty.add(e);
}

export async function getAllDuty() {
	// Latest first by id (monotonic)
	const rows = await db.duty.orderBy("id").reverse().toArray();
	// Ensure consistent shape
	return rows.map((r) => ({
		id: r.id,
		date: r.date,
		duty_type: r.duty_type || r.dutyType || "FDP",
		report: r.report || r.reportIso || "",
		off: r.off || r.offIso || "",
		sectors:
			typeof r.sectors === "number"
				? r.sectors
				: parseInt(r.sectors || "0", 10),
		location: r.location || "Home",
		sps: r.sps ?? null,
	}));
}

/* ---------------- Sleep ---------------- */
export async function addSleep(entry) {
	const e = { ...entry };
	return db.sleep.add(e);
}

export async function getAllSleep() {
	return db.sleep.orderBy("start").toArray();
}

/* ---------------- Settings ---------------- */
export async function saveSettings(partial) {
	const current = await loadSettings();
	const next = { ...current, ...partial };
	next.id = "defaults";
	await db.settings.put(next);
	return next;
}

export async function loadSettings() {
	const s = await db.settings.get("defaults");
	return (
		s || {
			id: "defaults",
			chronotype: "neutral", // "early" | "neutral" | "late"
			bands: { good: 80, caution: 60, elevated: 45 }, // fatigue gauge thresholds
		}
	);
}

/* ---------------- Utilities ---------------- */
export async function clearAll() {
	await db.delete();
	await db.open();
}
