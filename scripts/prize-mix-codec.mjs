// Fixed study codec, cycle 2: bitwise context mixing with an optional repeated-string model.
// usage: prize-mix-codec.mjs encode|decode mix|mix+match INPUT OUTPUT
// Each bit is predicted by counters for the last 0, 1, 2, 3, 4 and 6 bytes; a small
// integer network weighs them. "mix+match" adds one more input: the bit that followed
// the most recent earlier occurrence of the last five bytes. Everything is integer
// arithmetic, so encoder and decoder agree on any machine.
// Method after Mahoney, "Adaptive weighing of context models for lossless data
// compression" (2005) and the public lpaq1 design; written here, no code reused.
// Archive: LEB128 length, coded bits, 4 flush bytes, CRC-32 of the original.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

const LIMIT = 1_048_576, TABLE_BITS = 22, ORDERS = [1, 2, 3, 4, 6], INPUTS = ORDERS.length + 2;
const MATCH_MIN = 5, MATCH_BITS = 20, MATCH_CAP = 31, COUNT_CAP = 255, START = 2 ** 31;
const SQUASH = [1, 2, 3, 6, 10, 16, 27, 45, 73, 120, 194, 310, 488, 747, 1101, 1546, 2047, 2549, 2994, 3348, 3607, 3785, 3901, 3975, 4024, 4050, 4068, 4079, 4085, 4089, 4092, 4093, 4094];
// squash maps a log-odds value in -2047..2047 to a 12-bit probability; STRETCH is its inverse.
function squash(value) {
	if (value > 2047) return 4095;
	if (value < -2047) return 0;
	const weight = value & 127, index = (value >> 7) + 16;
	return (SQUASH[index] * (128 - weight) + SQUASH[index + 1] * weight + 64) >> 7;
}
const STRETCH = new Int16Array(4096);
{ let next = 0; for (let value = -2047; value <= 2047; value++) { const p = squash(value); for (let index = next; index <= p; index++) STRETCH[index] = value; next = p + 1; } for (let index = next; index < 4096; index++) STRETCH[index] = 2047; }
// Step size for a counter seen n times: 2 / (2n + 3), as a 16-bit fraction.
const STEP = new Int32Array(COUNT_CAP + 1); for (let n = 0; n <= COUNT_CAP; n++) STEP[n] = Math.floor(131_072 / (2 * n + 3));

// A counter holds a 22-bit probability and a 10-bit count in one 32-bit entry.
function learn(table, index, bit) {
	const entry = table[index], count = entry & 1023; let p = entry >>> 10;
	p += Math.floor(((bit ? 4_194_303 : 0) - p) * STEP[count] / 65_536);
	table[index] = p * 1024 + (count < COUNT_CAP ? count + 1 : count);
}

class Model {
	constructor(useMatch) {
		this.useMatch = useMatch; this.history = new Uint8Array(LIMIT); this.length = 0;
		this.partial = 1; this.bits = 0; this.probability = 2048;
		this.order0 = new Uint32Array(256).fill(START);
		this.tables = ORDERS.map(() => new Uint32Array(1 << TABLE_BITS).fill(START));
		this.hashes = new Int32Array(ORDERS.length); this.slots = new Int32Array(ORDERS.length);
		for (let index = 0; index < ORDERS.length; index++) this.hashes[index] = this.hash(ORDERS[index]);
		this.inputs = new Int32Array(INPUTS); this.weights = new Int32Array(256 * INPUTS).fill(16_384); this.weightBase = 0;
		this.matchTable = new Int32Array(1 << MATCH_BITS); this.matchAt = 0; this.matchLength = 0;
		this.matchCounters = new Uint32Array((MATCH_CAP + 1) * 2).fill(START); this.matchSlot = -1;
		this.predict();
	}
	hash(order) {
		let value = 0x811c9dc5 ^ order;
		for (let back = 1; back <= order; back++) value = Math.imul(value ^ ((this.length - back >= 0 ? this.history[this.length - back] : 0) + 1), 16_777_619);
		return value;
	}
	predict() {
		const partial = this.partial, inputs = this.inputs, weights = this.weights; this.weightBase = partial * INPUTS;
		inputs[0] = STRETCH[this.order0[partial] >>> 20];
		for (let index = 0; index < ORDERS.length; index++) {
			const slot = Math.imul((this.hashes[index] + Math.imul(partial, 0x7f4a7c15)) | 0, 0x9e3779b1) >>> (32 - TABLE_BITS);
			this.slots[index] = slot; inputs[index + 1] = STRETCH[this.tables[index][slot] >>> 20];
		}
		this.matchSlot = -1; inputs[INPUTS - 1] = 0;
		if (this.useMatch && this.matchLength > 0) {
			const expected = this.history[this.matchAt] | 256;
			if ((expected >> (8 - this.bits)) === partial) {
				this.matchSlot = (Math.min(this.matchLength, MATCH_CAP) << 1) | ((expected >> (7 - this.bits)) & 1);
				inputs[INPUTS - 1] = STRETCH[this.matchCounters[this.matchSlot] >>> 20];
			} else this.matchLength = 0;
		}
		let sum = 0; for (let index = 0; index < INPUTS; index++) sum += inputs[index] * weights[this.weightBase + index];
		const p = squash(Math.floor(sum / 65_536));
		this.probability = p < 1 ? 1 : p > 4095 ? 4095 : p;
	}
	update(bit) {
		const error = ((bit << 12) - this.probability) * 7, inputs = this.inputs, weights = this.weights;
		for (let index = 0; index < INPUTS; index++) weights[this.weightBase + index] += (inputs[index] * error + 0x8000) >> 16;
		learn(this.order0, this.partial, bit);
		for (let index = 0; index < ORDERS.length; index++) learn(this.tables[index], this.slots[index], bit);
		if (this.matchSlot >= 0) learn(this.matchCounters, this.matchSlot, bit);
		this.partial = this.partial * 2 + bit;
		if (++this.bits === 8) this.byte(this.partial & 255);
		this.predict();
	}
	byte(value) {
		this.history[this.length++] = value; this.partial = 1; this.bits = 0;
		for (let index = 0; index < ORDERS.length; index++) this.hashes[index] = this.hash(ORDERS[index]);
		if (!this.useMatch) return;
		if (this.matchLength > 0 && this.history[this.matchAt] === value) { this.matchLength++; this.matchAt++; } else this.matchLength = 0;
		if (this.length < MATCH_MIN) return;
		const slot = Math.imul(this.hash(MATCH_MIN), 0x9e3779b1) >>> (32 - MATCH_BITS);
		if (this.matchLength === 0) {
			const candidate = this.matchTable[slot];
			if (candidate > 0) {
				let same = 0;
				while (same < 32 && candidate - 1 - same >= 0 && this.history[candidate - 1 - same] === this.history[this.length - 1 - same]) same++;
				if (same > 0) { this.matchLength = same; this.matchAt = candidate; }
			}
		}
		this.matchTable[slot] = this.length;
	}
}

function encode(bytes, useMatch) {
	const out = []; let low = 0, high = 0xffffffff;
	for (let rest = bytes.length; ; rest = Math.floor(rest / 128)) { if (rest < 128) { out.push(rest); break; } out.push((rest % 128) | 128); }
	const model = new Model(useMatch);
	for (let position = 0; position < bytes.length; position++) for (let shift = 7; shift >= 0; shift--) {
		const bit = (bytes[position] >> shift) & 1, middle = low + Math.floor((high - low) / 4096) * model.probability;
		if (bit) high = middle; else low = middle + 1;
		model.update(bit);
		while (((low ^ high) & 0xff000000) === 0) { out.push(high >>> 24); low = (low << 8) >>> 0; high = ((high << 8) | 255) >>> 0; }
	}
	out.push(low >>> 24, (low >>> 16) & 255, (low >>> 8) & 255, low & 255);
	const check = crc32(bytes);
	out.push(check >>> 24, (check >>> 16) & 255, (check >>> 8) & 255, check & 255);
	return Buffer.from(out);
}

function decode(archive, useMatch) {
	let at = 0, length = 0;
	for (let scale = 1; ; scale *= 128) {
		if (at >= archive.length || at >= 4) throw new Error("archive header is damaged");
		const part = archive[at++]; length += (part & 127) * scale;
		if (part < 128) break;
	}
	if (length > LIMIT) throw new Error("decoded output exceeds study limit");
	const end = archive.length - 4;
	if (end - at < 4) throw new Error("archive is too short");
	const next = () => { if (at >= end) throw new Error("archive ended before its data"); return archive[at++]; };
	let low = 0, high = 0xffffffff, code = 0;
	for (let index = 0; index < 4; index++) code = (code * 256 + next()) >>> 0;
	const out = Buffer.alloc(length), model = new Model(useMatch);
	for (let position = 0; position < length; position++) {
		for (let count = 0; count < 8; count++) {
			const middle = low + Math.floor((high - low) / 4096) * model.probability, bit = code <= middle ? 1 : 0;
			if (bit) high = middle; else low = middle + 1;
			model.update(bit);
			while (((low ^ high) & 0xff000000) === 0) { low = (low << 8) >>> 0; high = ((high << 8) | 255) >>> 0; code = ((code << 8) | next()) >>> 0; }
		}
		out[position] = model.history[position];
	}
	if (at !== end) throw new Error("archive has bytes its data does not use");
	if (crc32(out) !== archive.readUInt32BE(end)) throw new Error("restored bytes fail the archive checksum");
	return out;
}

try {
	const [operation, mode, input, output, ...extra] = process.argv.slice(2);
	if (extra.length || !["encode", "decode"].includes(operation) || !["mix", "mix+match"].includes(mode) || !input || !output) {
		throw new Error("usage: prize-mix-codec.mjs encode|decode mix|mix+match INPUT OUTPUT");
	}
	const maximumInput = operation === "encode" ? LIMIT : LIMIT * 2;
	if (!statSync(input).isFile() || statSync(input).size > maximumInput) throw new Error("input exceeds study limit");
	const bytes = readFileSync(input);
	if (bytes.length > maximumInput) throw new Error("input exceeds study limit");
	const result = operation === "encode" ? encode(bytes, mode === "mix+match") : decode(bytes, mode === "mix+match");
	writeFileSync(output, result, { flag: "wx" });
	process.stdout.write(`${JSON.stringify({ peak_rss_kb: process.resourceUsage().maxRSS })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
