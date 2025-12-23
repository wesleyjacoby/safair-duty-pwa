// assets/modules/whatif.js
// What-if simulator helpers.
// Pure functions used by app.js to compute legality + rolling stats for
// a draft duty *without saving it*.

const WHATIF_ID = "__WHATIF__";

/**
 * Insert a duty into a list and return a NEW list sorted newest->oldest by
 * report/sbStart.
 *
 * NOTE: We include a small stable tie-break so equal timestamps don’t cause
 * inconsistent ordering.
 */
export function withDraftDuty(allDuties, draftDuty, safeMillis) {
	const combined = [...(allDuties || [])];
	combined.push({ ...draftDuty, id: WHATIF_ID });

	combined.sort((a, b) => {
		const ta = safeMillis(a.report || a.sbStart);
		const tb = safeMillis(b.report || b.sbStart);
		if (tb !== ta) return tb - ta;

		// Stable tie-break: keep the draft on top if times match
		const aIsDraft = a.id === WHATIF_ID ? 1 : 0;
		const bIsDraft = b.id === WHATIF_ID ? 1 : 0;
		return bIsDraft - aIsDraft;
	});

	return combined;
}

/**
 * Find the "previous duty" relative to the draft duty inside a sorted list
 * (newest->oldest). Returns the next element (older), or null.
 */
export function prevForDraft(sortedCombined) {
	const idx = sortedCombined.findIndex((d) => d.id === WHATIF_ID);
	return idx >= 0 ? sortedCombined[idx + 1] || null : null;
}

/**
 * Derive the anchor DateTime for the draft.
 */
export function anchorForDraft(draftDuty, dt) {
	return dt(draftDuty.report || draftDuty.sbStart || Date.now());
}
