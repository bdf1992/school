// Compression workbench: a move is a declared reversible operation with an inverse and a receipt.
// usage: prize-workbench.mjs apply OPERATION INPUT NEW_DIRECTORY     split INPUT into streams, write a receipt
//        prize-workbench.mjs invert OPERATION DIRECTORY NEW_OUTPUT    rebuild the input from the streams
//        prize-workbench.mjs cost DIRECTORY CODEC_MODE                code each stream with prize-mix2-codec.mjs
// An operation never loses a byte: `apply` refuses to write a receipt unless its own inverse gives back
// the input exactly. Operations are data-driven entries in OPERATIONS; adding one adds a move.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const LIMIT = 100_000_000;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const OPEN = Buffer.from('<text xml:space="preserve">'), CLOSE = Buffer.from("</text>");

const OPERATIONS = {
	// Wikipedia dump pages: everything outside the article bodies goes to `frame`, the bodies to `text`.
	// The frame keeps both tags with nothing between them. Bodies are joined by one zero byte, so the
	// operation refuses an input that contains a zero byte.
	"page-split": {
		describes: "separate article bodies from the page markup around them",
		streams: ["frame", "text"],
		forward(input) {
			if (input.includes(0)) throw new Error("page-split needs an input with no zero byte");
			const frame = [], text = []; let at = 0;
			for (;;) {
				const open = input.indexOf(OPEN, at);
				if (open < 0) { frame.push(input.subarray(at)); break; }
				const body = open + OPEN.length, close = input.indexOf(CLOSE, body);
				frame.push(input.subarray(at, body));
				if (close < 0) { text.push(input.subarray(body), Buffer.from([0])); break; }
				text.push(input.subarray(body, close), Buffer.from([0])); at = close;
			}
			return { frame: Buffer.concat(frame), text: Buffer.concat(text) };
		},
		inverse({ frame, text }) {
			const out = []; let at = 0, body = 0;
			for (;;) {
				const open = frame.indexOf(OPEN, at);
				if (open < 0) { out.push(frame.subarray(at)); break; }
				const end = open + OPEN.length, stop = text.indexOf(0, body);
				if (stop < 0) throw new Error("text stream has fewer bodies than the frame has slots");
				out.push(frame.subarray(at, end), text.subarray(body, stop)); at = end; body = stop + 1;
			}
			if (body !== text.length) throw new Error("text stream has more bodies than the frame has slots");
			return Buffer.concat(out);
		},
	},
	// Frequent words become short codes built from byte values the input never uses, so no escape is
	// needed. The word list is derived from the input itself and travels at the head of the stream,
	// where the codec that follows pays for it. Codes: one byte for the top words, then a lead byte
	// plus one or two bytes from 0x80-0xBF. A word is a maximal run of ASCII letters, matched exactly.
	"word-codes": {
		describes: "replace frequent words with short codes made of unused byte values",
		streams: ["coded"],
		forward(input) {
			const used = new Uint8Array(256); for (let index = 0; index < input.length; index++) used[input[index]] = 1;
			const free = []; for (let value = 0; value < 256; value++) if (!used[value]) free.push(value);
			const high = free.filter(value => value >= 128), low = free.filter(value => value < 128);
			if (high.length < 2 || low.length < 1) throw new Error("word-codes needs unused byte values below and above 128");
			const one = low, three = [high[high.length - 1]], two = high.slice(0, -1);
			const letter = value => (value >= 65 && value <= 90) || (value >= 97 && value <= 122);
			const counts = new Map();
			for (let at = 0; at < input.length;) {
				if (!letter(input[at])) { at++; continue; }
				let end = at + 1; while (end < input.length && letter(input[end])) end++;
				if (end - at >= 2 && end - at <= 32) { const word = input.latin1Slice(at, end); counts.set(word, (counts.get(word) ?? 0) + 1); }
				at = end;
			}
			const ranked = [...counts].filter(([, count]) => count >= 4).sort((a, b) => b[1] * (b[0].length - 1) - a[1] * (a[0].length - 1) || (a[0] < b[0] ? -1 : 1));
			const capacity = [one.length, two.length * 64, three.length * 4096], tiers = [[], [], []];
			for (const [word] of ranked) {
				const tier = tiers.findIndex((list, index) => list.length < capacity[index] && word.length > index + 1);
				if (tier >= 0) tiers[tier].push(word);
				if (tiers.every((list, index) => list.length >= capacity[index])) break;
			}
			const codes = new Map();
			tiers[0].forEach((word, index) => codes.set(word, Buffer.from([one[index]])));
			tiers[1].forEach((word, index) => codes.set(word, Buffer.from([two[index >> 6], 128 + (index & 63)])));
			tiers[2].forEach((word, index) => codes.set(word, Buffer.from([three[0], 128 + (index >> 6), 128 + (index & 63)])));
			const head = Buffer.from(`${[one, two, three].map(set => set.join(",")).join(";")}\n${tiers.map(list => list.join(" ")).join("\n")}\n`, "latin1");
			const out = Buffer.alloc(head.length + input.length); head.copy(out); let used2 = head.length;
			for (let at = 0; at < input.length;) {
				if (!letter(input[at])) { out[used2++] = input[at++]; continue; }
				let end = at + 1; while (end < input.length && letter(input[end])) end++;
				const code = end - at <= 32 ? codes.get(input.latin1Slice(at, end)) : undefined;
				if (code) { code.copy(out, used2); used2 += code.length; } else { input.copy(out, used2, at, end); used2 += end - at; }
				at = end;
			}
			return { coded: out.subarray(0, used2) };
		},
		inverse({ coded }) {
			const lines = []; let at = 0;
			for (let line = 0; line < 4; line++) { const end = coded.indexOf(10, at); if (end < 0) throw new Error("word-codes head is damaged"); lines.push(coded.latin1Slice(at, end)); at = end + 1; }
			const [one, two, three] = lines[0].split(";").map(set => set === "" ? [] : set.split(",").map(Number));
			const tiers = lines.slice(1).map(line => line === "" ? [] : line.split(" ").map(word => Buffer.from(word, "latin1")));
			const kind = new Uint8Array(256), base = new Int32Array(256);
			one.forEach((value, index) => { kind[value] = 1; base[value] = index; });
			two.forEach((value, index) => { kind[value] = 2; base[value] = index << 6; });
			three.forEach(value => { kind[value] = 3; });
			const parts = []; let plain = at;
			const word = (list, index) => { const found = list[index]; if (!found) throw new Error("word-codes stream names a word outside its list"); return found; };
			while (at < coded.length) {
				const value = coded[at], which = kind[value];
				if (which === 0) { at++; continue; }
				if (plain < at) parts.push(coded.subarray(plain, at));
				if (which === 1) { parts.push(word(tiers[0], base[value])); at += 1; }
				else if (which === 2) { parts.push(word(tiers[1], base[value] + (coded[at + 1] - 128))); at += 2; }
				else { parts.push(word(tiers[2], ((coded[at + 1] - 128) << 6) + (coded[at + 2] - 128))); at += 3; }
				plain = at;
			}
			if (plain < coded.length) parts.push(coded.subarray(plain));
			return Buffer.concat(parts);
		},
	},
};

function operation(name) { const found = OPERATIONS[name]; if (!found) throw new Error(`unknown operation: ${name}; known: ${Object.keys(OPERATIONS).join(", ")}`); return found; }
function readBounded(file) { if (!statSync(file).isFile() || statSync(file).size > LIMIT) throw new Error("input exceeds workbench limit"); return readFileSync(file); }
function readStreams(op, directory) { return Object.fromEntries(op.streams.map(name => [name, readBounded(path.join(directory, `${name}.bin`))])); }

try {
	const [command, ...args] = process.argv.slice(2);
	if (command === "apply" && args.length === 3) {
		const [name, inputFile, directory] = args, op = operation(name), input = readBounded(inputFile);
		if (existsSync(directory)) throw new Error("output directory must not already exist");
		const streams = op.forward(input);
		if (!op.inverse(streams).equals(input)) throw new Error("operation did not reverse exactly; nothing written");
		mkdirSync(directory, { recursive: true });
		for (const stream of op.streams) writeFileSync(path.join(directory, `${stream}.bin`), streams[stream], { flag: "wx" });
		const receipt = {
			format: "school.prize-move/1", operation: name, describes: op.describes,
			input: { bytes: input.length, sha256: digest(input) },
			streams: op.streams.map(stream => ({ name: stream, bytes: streams[stream].length, sha256: digest(streams[stream]) })),
			stream_bytes_total: op.streams.reduce((sum, stream) => sum + streams[stream].length, 0),
			inverse_checked: "exact", side_data_bytes: 0, program: { path: "scripts/prize-workbench.mjs", sha256: digest(readFileSync(import.meta.filename)) },
		};
		writeFileSync(path.join(directory, "receipt.json"), json(receipt), { flag: "wx" });
		process.stdout.write(json(receipt));
	} else if (command === "invert" && args.length === 3) {
		const [name, directory, output] = args, op = operation(name);
		writeFileSync(output, op.inverse(readStreams(op, directory)), { flag: "wx" });
	} else if (command === "cost" && args.length === 2) {
		const [directory, mode] = args, receipt = JSON.parse(readFileSync(path.join(directory, "receipt.json"), "utf8")), codec = path.join(import.meta.dirname, "prize-mix2-codec.mjs");
		const rows = receipt.streams.map(stream => {
			const source = path.join(directory, `${stream.name}.bin`), archive = path.join(directory, `${stream.name}.${mode}.archive`);
			if (!existsSync(archive)) { const done = spawnSync(process.execPath, [codec, "encode", mode, source, archive], { encoding: "utf8", timeout: 3_600_000 }); if (done.status !== 0) throw new Error(`${stream.name}: ${done.stderr}`); }
			const coded = statSync(archive).size;
			return { name: stream.name, bytes: stream.bytes, archive_bytes: coded, bits_per_byte: Math.round(coded * 8000 / Math.max(1, stream.bytes)) / 1000 };
		});
		process.stdout.write(json({ format: "school.prize-move-cost/1", operation: receipt.operation, codec_mode: mode, streams: rows, archive_bytes_total: rows.reduce((sum, row) => sum + row.archive_bytes, 0) }));
	} else throw new Error("usage: prize-workbench.mjs apply OPERATION INPUT NEW_DIRECTORY | invert OPERATION DIRECTORY NEW_OUTPUT | cost DIRECTORY CODEC_MODE");
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1;
}
