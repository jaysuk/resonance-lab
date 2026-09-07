/**
 * TMC driver chip identification by reading the IOIN register's VERSION byte over M569.2 - the
 * method duet-tmc-tuner uses (`src/model/machine.ts`), kept equivalent here rather than reinvented.
 * The object model carries no chip-type field at all, so this is the only reliable way to tell a
 * TMC5160/2240 (which support a waveform correction) from a TMC2208/2209 (which do not) on the
 * STM32 port, where the chip isn't implied by the board name either.
 *
 * M569.2 is two different commands, disambiguated by which parameter is present: with R it is the
 * long-standing register read/write (works on every firmware) - what this module uses; with S it is
 * the 3.7 sine-table waveform correction (see ../analysis/motorTuning.ts). Do not conflate them.
 */

/** IOIN register addresses that carry the chip VERSION byte: UART parts (22xx) at 0x06, SPI parts (5160/2240) at 0x04. */
export const IOIN_ADDRESSES = { uart: 0x06, spi: 0x04 } as const;

export type DriverFamily = "tmc22xx" | "tmc5160" | "tmc2240";

export interface DriverChip {
	chip: string;
	family: DriverFamily;
}

/**
 * Parse the 32-bit value from an M569.2 register-read reply. RRF's phrasing varies, so this is
 * deliberately tolerant: prefer a value after "value"/"=" (the VALUE, not the register address that
 * appears earlier in the same reply), else the last "0x..." token, else the last plain integer.
 * @returns An unsigned 32-bit number, or null when nothing parses.
 */
export function parseRegisterValue(reply: string | null | undefined): number | null {
	const text = reply ?? "";
	const tagged = /(?:value|=)\s*(0x[0-9a-fA-F]{1,8}|\d+)/i.exec(text);
	if (tagged) {
		const tok = tagged[1];
		return (/^0x/i.test(tok) ? parseInt(tok, 16) : parseInt(tok, 10)) >>> 0;
	}
	const hexes = text.match(/0x[0-9a-fA-F]{1,8}/g);
	if (hexes && hexes.length > 0) {
		return parseInt(hexes[hexes.length - 1], 16) >>> 0;
	}
	const ints = text.match(/\d+/g);
	if (ints && ints.length > 0) {
		return Number(ints[ints.length - 1]) >>> 0;
	}
	return null;
}

/**
 * Identify a chip from its IOIN VERSION byte (bits 31:24). UART parts expose IOIN at 0x06
 * (0x20 = TMC2208, 0x21 = TMC2209/2226), SPI parts at 0x04 (0x30 = TMC5160/2160, 0x40 = TMC2240).
 * Pass whichever reads you have; returns the matched chip + family, or null if neither looks valid -
 * never guess.
 */
export function chipFromIoin(read: { uart?: number | null; spi?: number | null }): DriverChip | null {
	const vUart = read.uart != null ? (read.uart >>> 24) & 0xFF : -1;
	const vSpi = read.spi != null ? (read.spi >>> 24) & 0xFF : -1;
	if (vUart === 0x20) { return { chip: "TMC2208", family: "tmc22xx" }; }
	if (vUart === 0x21) { return { chip: "TMC2209", family: "tmc22xx" }; }
	if (vSpi === 0x30) { return { chip: "TMC5160", family: "tmc5160" }; }
	if (vSpi === 0x40) { return { chip: "TMC2240", family: "tmc2240" }; }
	return null;
}

/** Whether a driver family's chip has a programmable sine table that can carry a waveform correction. */
export function supportsWaveformCorrection(family: DriverFamily | null): boolean {
	return family === "tmc5160" || family === "tmc2240";
}
