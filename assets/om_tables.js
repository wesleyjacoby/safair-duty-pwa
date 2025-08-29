// OM Section 9: FDP tables (Two-pilot, acclimatised and not; plus notes).
// Times expressed in hours:minutes; keys are report time ranges and sector counts.

export const OM_RULES = {
	timezone: "Africa/Johannesburg",

	// Two-pilot crews – acclimatised (Table 9-1)
	FDP_ACCL: [
		{
			range: [5, 6, 59],
			limits: [
				"13:00",
				"12:15",
				"11:30",
				"10:45",
				"10:00",
				"9:15",
				"9:00",
				"9:00",
			],
		},
		{
			range: [7, 13, 59],
			limits: [
				"14:00",
				"13:15",
				"12:30",
				"11:45",
				"11:00",
				"10:15",
				"9:30",
				"9:00",
			],
		},
		{
			range: [14, 20, 59],
			limits: [
				"13:00",
				"12:15",
				"11:30",
				"10:45",
				"10:00",
				"9:15",
				"9:00",
				"9:00",
			],
		},
		{
			range: [21, 21, 59],
			limits: [
				"12:00",
				"11:15",
				"10:30",
				"9:45",
				"9:00",
				"9:00",
				"9:00",
				"9:00",
			],
		},
		{
			range: [22, 4, 59],
			limits: [
				"11:00",
				"10:15",
				"9:30",
				"9:00",
				"9:00",
				"9:00",
				"9:00",
				"9:00",
			],
		},
	],
	// Two-pilot crews – NOT acclimatised (Table 9-2)
	FDP_NOT_ACCL: [
		{
			restWindow: "≤18 || ≥30",
			limits: ["13:00", "12:15", "11:30", "10:55", "10:00", "9:15", "9:00"],
		},
		{
			restWindow: "18–30",
			limits: ["12:00", "11:15", "10:30", "9:45", "9:00", "9:00", "9:00"],
		},
	],

	// Split-duty extension (Table 9-6)
	SPLIT_DUTY: [
		{ minRestHrs: 0, maxRestHrs: 2.99, extension: 0 },
		{ minRestHrs: 3, maxRestHrs: 10, extensionHalf: true }, // 50% of consecutive rest
	],

	// In-flight relief
	RELIEF: {
		minRestForCreditMins: 180,
		seat: { credit: 1 / 3, maxFDP: 15 * 60 },
		bunk: { credit: 1 / 2, maxFDP: 18 * 60 },
	},

	// Positioning rules
	POSITIONING: {
		countsAsDuty: true,
		countsAsSector: false,
		preFdpCountsInFdp: true,
	},

	// Rest minima (9.2.8.5)
	REST: {
		homeMinHrs: 12,
		away: {
			acclimLocalNight: 10, // includes a local night with suitable accom
			noLocalNight: 12,
			outsideLocalNight: 14,
		},
		afterFdp18Plus: { restHrs: 18, includeLocalNight: true },
	},

	// Disruptive / night windows
	DISRUPTIVE: {
		earlyType: { start: ["05:00", "05:59"], finish: ["23:00", "01:59"] },
		lateType: { start: ["05:00", "06:59"], finish: ["00:00", "01:59"] },
		nightDuty: { window: ["02:00", "04:59"] },
	},

	// Cumulative duty & days off (9.2.11.1, 9.2.10)
	CUMULATIVE: {
		avgWeekMax7d: 60,
		avgWeekMax4w: 50,
		daysOff: {
			maxConsecOn: 7,
			twoIn14: true,
			sixIn4w: true,
			avg8In4wOver3: true,
		},
	},

	// Notes affecting FDP
	NOTES: {
		noAutopilot: { maxFdpHours: 11, maxSectors: 4 },
	},
};
