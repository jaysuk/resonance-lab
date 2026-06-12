/**
 * Parser for RRF accelerometer capture files (M956 output in 0:/sys/accelerometer/): a header line
 * starting with "Sample" followed by one column per axis, sample rows, and a trailing line carrying
 * "...Rate <hz> overflows <n>". Store-agnostic and pure so captures parse identically in tests.
 */

export interface AccelCapture {
	/** Axis labels from the header (e.g. ["X","Y","Z"]). */
	axes: Array<string>;
	/** One channel per axis, in g. */
	channels: Array<Float64Array>;
	/** Sampling rate reported by the firmware (Hz). */
	samplingRate: number;
	/** Number of sample overflows the firmware reported (any > 0 means the capture is suspect). */
	overflows: number;
}

// Firmware variants punctuate the trailer differently ("Rate 1342 overflows 0",
// "Rate: 1342, overflows: 0", trailing commas from the CSV writer...) - match loosely.
const TRAILER_RE = /rate\D{0,3}(\d+(?:\.\d+)?)\D+overflows\D{0,3}(\d+)/i;

/** True once the capture file carries its rate/overflows trailer, i.e. the firmware finished writing. */
export function hasCaptureTrailer(text: string): boolean {
	return TRAILER_RE.test(text.slice(-200));
}

export function parseAccelCsv(text: string): AccelCapture {
	const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
	if (lines.length < 3) {
		throw new Error("Accelerometer CSV too short");
	}
	const headers = lines[0].split(",").map((h) => h.trim());
	if (headers[0] !== "Sample" || headers.length < 2) {
		throw new Error("Not an accelerometer CSV (missing Sample header)");
	}

	// Sampling rate + overflow count live at the end, appended after the samples. Scan the last few
	// lines: some firmware builds emit the trailer on its own line, some append extra blank cells.
	let trailer: RegExpExecArray | null = null;
	let trailerIdx = lines.length;
	for (let i = lines.length - 1; i >= Math.max(1, lines.length - 3) && !trailer; i--) {
		trailer = TRAILER_RE.exec(lines[i]);
		if (trailer) {
			trailerIdx = i;
		}
	}
	if (!trailer) {
		throw new Error("Accelerometer CSV is missing its rate/overflows trailer (truncated capture?)");
	}
	const samplingRate = parseFloat(trailer[1]);
	const overflows = parseInt(trailer[2], 10);

	const axes = headers.slice(1);
	const rows = lines.slice(1, trailerIdx);
	const channels = axes.map(() => new Float64Array(rows.length));
	for (let r = 0; r < rows.length; r++) {
		const cols = rows[r].split(",");
		for (let a = 0; a < axes.length; a++) {
			channels[a][r] = parseFloat(cols[a + 1]);
		}
	}
	return { axes, channels, samplingRate, overflows };
}
