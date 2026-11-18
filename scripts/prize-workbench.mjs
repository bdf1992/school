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
