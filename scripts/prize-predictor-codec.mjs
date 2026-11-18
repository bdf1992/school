// Fixed study codec: one integer arithmetic coder, two adaptive byte predictors.
// usage: prize-predictor-codec.mjs encode|decode 0|1 INPUT OUTPUT
// Order 0 keeps one frequency table. Order 1 keeps one table per previous byte.
// The coder, framing (an end symbol, no header), initial counts and update rule
// are the same for both orders. Coder after Witten, Neal and Cleary,
// "Arithmetic coding for data compression", CACM 30(6), 1987; written here, no code reused.
import { readFileSync, statSync, writeFileSync } from "node:fs";

const LIMIT = 1_048_576, SYMBOLS = 257, END = 256, INCREMENT = 24, MAX_TOTAL = 65_536;
const TOP = 2 ** 32, HALF = 2 ** 31, QUARTER = 2 ** 30, THREE_QUARTERS = 3 * QUARTER;

class Table {
	constructor() { this.counts = new Uint32Array(SYMBOLS).fill(1); this.total = SYMBOLS; }
	update(symbol) {
		this.counts[symbol] += INCREMENT; this.total += INCREMENT;
		if (this.total <= MAX_TOTAL) return;
		let total = 0;
		for (let index = 0; index < SYMBOLS; index++) { const halved = (this.counts[index] + 1) >>> 1; this.counts[index] = halved; total += halved; }
		this.total = total;
	}
}
class Predictor {
	constructor(order) { this.order = order; this.tables = new Array(order === 0 ? 1 : 256); this.previous = 0; }
	table() { const key = this.order === 0 ? 0 : this.previous; return this.tables[key] ??= new Table(); }
	seen(symbol) { this.previous = symbol === END ? 0 : symbol; }
}

function encode(bytes, order) {
	const out = []; let current = 0, filled = 0, low = 0, high = TOP - 1, pending = 0;
	const bit = value => { current = (current << 1) | value; if (++filled === 8) { out.push(current); current = 0; filled = 0; } };
	const emit = value => { bit(value); for (; pending > 0; pending--) bit(value ^ 1); };
	const predictor = new Predictor(order);
	for (let position = 0; position <= bytes.length; position++) {
		const symbol = position === bytes.length ? END : bytes[position], table = predictor.table();
		let below = 0; for (let index = 0; index < symbol; index++) below += table.counts[index];
		const range = high - low + 1;
		high = low + Math.floor(range * (below + table.counts[symbol]) / table.total) - 1;
		low = low + Math.floor(range * below / table.total);
		for (;;) {
			if (high < HALF) emit(0);
			else if (low >= HALF) { emit(1); low -= HALF; high -= HALF; }
			else if (low >= QUARTER && high < THREE_QUARTERS) { pending++; low -= QUARTER; high -= QUARTER; }
			else break;
			low *= 2; high = high * 2 + 1;
		}
		table.update(symbol); predictor.seen(symbol);
	}
	pending++; emit(low < QUARTER ? 0 : 1);
	while (filled !== 0) bit(0);
	return Buffer.from(out);
}

function decode(archive, order) {
	let at = 0;
	// Bits past the end of the archive read as zero, matching the encoder's zero padding.
	const bit = () => { const index = at >>> 3, value = index < archive.length ? (archive[index] >>> (7 - (at & 7))) & 1 : 0; at++; return value; };
	let low = 0, high = TOP - 1, code = 0;
	for (let index = 0; index < 32; index++) code = code * 2 + bit();
	const out = Buffer.alloc(LIMIT); let length = 0;
	const predictor = new Predictor(order);
	for (;;) {
		const table = predictor.table(), range = high - low + 1;
		const target = Math.floor(((code - low + 1) * table.total - 1) / range);
		let symbol = 0, below = 0;
		while (below + table.counts[symbol] <= target) { below += table.counts[symbol]; symbol++; if (symbol >= SYMBOLS) throw new Error("archive is not a valid stream"); }
		high = low + Math.floor(range * (below + table.counts[symbol]) / table.total) - 1;
		low = low + Math.floor(range * below / table.total);
		for (;;) {
			if (high < HALF) { /* shift only */ }
			else if (low >= HALF) { low -= HALF; high -= HALF; code -= HALF; }
			else if (low >= QUARTER && high < THREE_QUARTERS) { low -= QUARTER; high -= QUARTER; code -= QUARTER; }
			else break;
			low *= 2; high = high * 2 + 1; code = code * 2 + bit();
		}
		if (symbol === END) break;
		if (length === LIMIT) throw new Error("decoded output exceeds study limit");
		// A stream that runs far past its archive without an end symbol is damaged.
		if (at > archive.length * 8 + 64) throw new Error("archive ended before its end symbol");
		out[length++] = symbol;
		table.update(symbol); predictor.seen(symbol);
	}
	return out.subarray(0, length);
}

try {
	const [operation, orderText, input, output, ...extra] = process.argv.slice(2);
	if (extra.length || !["encode", "decode"].includes(operation) || !["0", "1"].includes(orderText) || !input || !output) {
		throw new Error("usage: prize-predictor-codec.mjs encode|decode 0|1 INPUT OUTPUT");
	}
	const maximumInput = operation === "encode" ? LIMIT : LIMIT * 2;
	if (!statSync(input).isFile() || statSync(input).size > maximumInput) throw new Error("input exceeds study limit");
	const bytes = readFileSync(input);
	if (bytes.length > maximumInput) throw new Error("input exceeds study limit");
	const result = operation === "encode" ? encode(bytes, Number(orderText)) : decode(bytes, Number(orderText));
	writeFileSync(output, result, { flag: "wx" });
	process.stdout.write(`${JSON.stringify({ peak_rss_kb: process.resourceUsage().maxRSS })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
