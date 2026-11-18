// Fixed study codec, cycle 4: the cycle 2 context mixer with four additions, each switchable,
// seven context lengths (1-6 and 8), counters that stop slowing after 16 observations, and a
// doubled mixer learning rate. Those three settings were chosen on the first 10 MB of enwik8.
// usage: prize-mix2-codec.mjs encode|decode MODE INPUT OUTPUT
// MODE is all | nosse | noword | nosparse | nomixsel, optionally followed by -large.
//   word:    contexts from the current run of letters and the run before it (no word list)
//   sparse:  contexts that skip a byte: bytes 2 and 3 back, and bytes 1 and 3 back
//   mixsel:  a second weight set chosen by the previous byte, averaged with the first
//   sse:     two adaptive tables that correct the mixed probability before coding
// Integer arithmetic throughout. Methods after Mahoney's PAQ and lpaq1 (word and sparse
// contexts, weight-set selection, adaptive probability maps); written here, no code reused.
// Archive: LEB128 length, coded bits, 4 flush bytes, CRC-32 of the original.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { crc32 } from "node:zlib";

let LIMIT = 1_048_576, TABLE_BITS = 22, MATCH_BITS = 20;
const ORDERS = [1, 2, 3, 4, 5, 6, 8], MATCH_MIN = 5, MATCH_CAP = 31, COUNT_CAP = 16, START = 2 ** 31;
const SQUASH = [1, 2, 3, 6, 10, 16, 27, 45, 73, 120, 194, 310, 488, 747, 1101, 1546, 2047, 2549, 2994, 3348, 3607, 3785, 3901, 3975, 4024, 4050, 4068, 4079, 4085, 4089, 4092, 4093, 4094];
function squash(value) {
	if (value > 2047) return 4095;
	if (value < -2047) return 0;
	const weight = value & 127, index = (value >> 7) + 16;
	return (SQUASH[index] * (128 - weight) + SQUASH[index + 1] * weight + 64) >> 7;
}
const STRETCH = new Int16Array(4096);
{ let next = 0; for (let value = -2047; value <= 2047; value++) { const p = squash(value); for (let index = next; index <= p; index++) STRETCH[index] = value; next = p + 1; } for (let index = next; index < 4096; index++) STRETCH[index] = 2047; }
const STEP = new Int32Array(COUNT_CAP + 1); for (let n = 0; n <= COUNT_CAP; n++) STEP[n] = Math.floor(131_072 / (2 * n + 3));
const clamp = value => value > 2047 ? 2047 : value < -2047 ? -2047 : value;

function learn(table, index, bit) {
	const entry = table[index], count = entry & 1023; let p = entry >>> 10;
	p += Math.floor(((bit ? 4_194_303 : 0) - p) * STEP[count] / 65_536);
	table[index] = p * 1024 + (count < COUNT_CAP ? count + 1 : count);
}
// An adaptive probability map: 33 points along the log-odds axis per context, 16-bit values.
function correction(contexts) {
	const table = new Uint16Array(contexts * 33);
	for (let index = 0; index < table.length; index++) table[index] = squash((index % 33 - 16) * 128) * 16;
	return table;
}

class Model {
	constructor(flags) {
		this.flags = flags; this.history = new Uint8Array(LIMIT); this.length = 0;
		this.partial = 1; this.bits = 0; this.probability = 2048;
		this.contexts = ORDERS.length + (flags.word ? 2 : 0) + (flags.sparse ? 2 : 0); this.inputCount = this.contexts + 2;
		this.order0 = new Uint32Array(256).fill(START);
		this.tables = Array.from({ length: this.contexts }, () => new Uint32Array(1 << TABLE_BITS).fill(START));
		this.hashes = new Int32Array(this.contexts); this.slots = new Int32Array(this.contexts);
		this.word = 0; this.previousWord = 0;
		this.inputs = new Int32Array(this.inputCount); this.weights = new Int32Array(512 * this.inputCount).fill(16_384);
		this.baseA = 0; this.baseB = 0; this.mixedA = 2048; this.mixedB = 2048;
		this.fix0 = correction(256); this.fix1 = correction(65_536); this.fixAt0 = 0; this.fixAt1 = 0;
		this.matchTable = new Int32Array(1 << MATCH_BITS); this.matchAt = 0; this.matchLength = 0;
		this.matchCounters = new Uint32Array((MATCH_CAP + 1) * 2).fill(START); this.matchSlot = -1;
		this.rehash(); this.predict();
	}
	at(back) { return this.length - back >= 0 ? this.history[this.length - back] : 0; }
	hash(order) {
		let value = 0x811c9dc5 ^ order;
		for (let back = 1; back <= order; back++) value = Math.imul(value ^ (this.at(back) + 1), 16_777_619);
		return value;
	}
	rehash() {
		let index = 0;
		for (const order of ORDERS) this.hashes[index++] = this.hash(order);
		if (this.flags.word) {
			this.hashes[index++] = Math.imul(this.word ^ 0x3c6ef372, 0x85ebca6b);
			this.hashes[index++] = Math.imul((this.word ^ Math.imul(this.previousWord, 0x2545f491)) + 0x165667b1, 0x85ebca6b);
		}
		if (this.flags.sparse) {
			this.hashes[index++] = Math.imul(0x51000000 ^ ((this.at(2) << 8) | this.at(3)), 0x85ebca6b);
			this.hashes[index++] = Math.imul(0x73000000 ^ ((this.at(1) << 8) | this.at(3)), 0x85ebca6b);
		}
	}
	predict() {
		const partial = this.partial, inputs = this.inputs, weights = this.weights, count = this.inputCount;
		inputs[0] = STRETCH[this.order0[partial] >>> 20];
		for (let index = 0; index < this.contexts; index++) {
			const slot = Math.imul((this.hashes[index] + Math.imul(partial, 0x7f4a7c15)) | 0, 0x9e3779b1) >>> (32 - TABLE_BITS);
			this.slots[index] = slot; inputs[index + 1] = STRETCH[this.tables[index][slot] >>> 20];
		}
		this.matchSlot = -1; inputs[count - 1] = 0;
		if (this.matchLength > 0) {
			const expected = this.history[this.matchAt] | 256;
			if ((expected >> (8 - this.bits)) === partial) {
				this.matchSlot = (Math.min(this.matchLength, MATCH_CAP) << 1) | ((expected >> (7 - this.bits)) & 1);
				inputs[count - 1] = STRETCH[this.matchCounters[this.matchSlot] >>> 20];
			} else this.matchLength = 0;
		}
		this.baseA = partial * count; this.baseB = (256 + this.at(1)) * count;
		let sumA = 0, sumB = 0;
		for (let index = 0; index < count; index++) { sumA += inputs[index] * weights[this.baseA + index]; sumB += inputs[index] * weights[this.baseB + index]; }
		const logitA = clamp(Math.floor(sumA / 65_536)), logitB = clamp(Math.floor(sumB / 65_536));
		this.mixedA = squash(logitA); this.mixedB = squash(logitB);
		let p = this.flags.mixsel ? squash((logitA + logitB) >> 1) : this.mixedA;
		if (this.flags.sse) {
			const position = STRETCH[p] + 2048, low = position >> 7, weight = position & 127;
			this.fixAt0 = partial * 33 + low; this.fixAt1 = ((this.at(1) << 8) | partial) * 33 + low;
			const p0 = (this.fix0[this.fixAt0] * (128 - weight) + this.fix0[this.fixAt0 + 1] * weight) >> 11;
			const p1 = (this.fix1[this.fixAt1] * (128 - weight) + this.fix1[this.fixAt1 + 1] * weight) >> 11;
			p = (2 * p + p0 + p1 + 2) >> 2;
		}
		this.probability = p < 1 ? 1 : p > 4095 ? 4095 : p;
	}
	update(bit) {
		const inputs = this.inputs, weights = this.weights, count = this.inputCount;
		const errorA = ((bit << 12) - this.mixedA) * 14, errorB = ((bit << 12) - this.mixedB) * 14;
		for (let index = 0; index < count; index++) {
			weights[this.baseA + index] += (inputs[index] * errorA + 0x8000) >> 16;
			if (this.flags.mixsel) weights[this.baseB + index] += (inputs[index] * errorB + 0x8000) >> 16;
		}
		learn(this.order0, this.partial, bit);
		for (let index = 0; index < this.contexts; index++) learn(this.tables[index], this.slots[index], bit);
		if (this.matchSlot >= 0) learn(this.matchCounters, this.matchSlot, bit);
		if (this.flags.sse) {
			const target = bit ? 65_535 : 0;
			for (const [table, index] of [[this.fix0, this.fixAt0], [this.fix0, this.fixAt0 + 1], [this.fix1, this.fixAt1], [this.fix1, this.fixAt1 + 1]]) table[index] += (target - table[index]) >> 7;
		}
		this.partial = this.partial * 2 + bit;
		if (++this.bits === 8) this.byte(this.partial & 255);
		this.predict();
	}
	byte(value) {
		this.history[this.length++] = value; this.partial = 1; this.bits = 0;
		const lower = value >= 65 && value <= 90 ? value + 32 : value;
		if ((lower >= 97 && lower <= 122) || value >= 128) this.word = Math.imul(this.word + lower + 1, 0x2f0b4a27);
		else if (this.word !== 0) { this.previousWord = this.word; this.word = 0; }
		this.rehash();
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

function encode(bytes, flags) {
	let out = Buffer.alloc(Math.max(1024, bytes.length >> 1)), used = 0, low = 0, high = 0xffffffff;
	const put = value => { if (used === out.length) out = Buffer.concat([out, Buffer.alloc(out.length)]); out[used++] = value; };
	for (let rest = bytes.length; ; rest = Math.floor(rest / 128)) { if (rest < 128) { put(rest); break; } put((rest % 128) | 128); }
	const model = new Model(flags);
	for (let position = 0; position < bytes.length; position++) for (let shift = 7; shift >= 0; shift--) {
		const bit = (bytes[position] >> shift) & 1, middle = low + Math.floor((high - low) / 4096) * model.probability;
		if (bit) high = middle; else low = middle + 1;
		model.update(bit);
		while (((low ^ high) & 0xff000000) === 0) { put(high >>> 24); low = (low << 8) >>> 0; high = ((high << 8) | 255) >>> 0; }
	}
	const check = crc32(bytes);
	for (const word of [low, check]) { put(word >>> 24); put((word >>> 16) & 255); put((word >>> 8) & 255); put(word & 255); }
	return out.subarray(0, used);
}

function decode(archive, flags) {
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
	const model = new Model(flags);
	for (let position = 0; position < length; position++) for (let count = 0; count < 8; count++) {
		const middle = low + Math.floor((high - low) / 4096) * model.probability, bit = code <= middle ? 1 : 0;
		if (bit) high = middle; else low = middle + 1;
		model.update(bit);
		while (((low ^ high) & 0xff000000) === 0) { low = (low << 8) >>> 0; high = ((high << 8) | 255) >>> 0; code = ((code << 8) | next()) >>> 0; }
	}
	const out = Buffer.from(model.history.buffer, 0, length);
	if (at !== end) throw new Error("archive has bytes its data does not use");
	if (crc32(out) !== archive.readUInt32BE(end)) throw new Error("restored bytes fail the archive checksum");
	return out;
}

try {
	const [operation, mode, input, output, ...extra] = process.argv.slice(2);
	const name = (mode ?? "").replace(/-large$/, "");
	if (extra.length || !["encode", "decode"].includes(operation) || !["all", "nosse", "noword", "nosparse", "nomixsel"].includes(name) || !input || !output) {
		throw new Error("usage: prize-mix2-codec.mjs encode|decode all|nosse|noword|nosparse|nomixsel[-large] INPUT OUTPUT");
	}
	if (mode.endsWith("-large")) { LIMIT = 100_000_000; TABLE_BITS = 26; MATCH_BITS = 24; }
	const flags = { sse: name !== "nosse", word: name !== "noword", sparse: name !== "nosparse", mixsel: name !== "nomixsel" };
	const maximumInput = operation === "encode" ? LIMIT : LIMIT * 2;
	if (!statSync(input).isFile() || statSync(input).size > maximumInput) throw new Error("input exceeds study limit");
	const bytes = readFileSync(input);
	if (bytes.length > maximumInput) throw new Error("input exceeds study limit");
	writeFileSync(output, operation === "encode" ? encode(bytes, flags) : decode(bytes, flags), { flag: "wx" });
	process.stdout.write(`${JSON.stringify({ peak_rss_kb: process.resourceUsage().maxRSS })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
