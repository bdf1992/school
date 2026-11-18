// Fixed baseline worker for studies above the smoke limit: compressors already inside Node.
// usage: prize-baseline-worker.mjs encode|decode deflate|brotli|zstd INPUT OUTPUT
// deflate is level 9, brotli is quality 11 with a 16 MiB window, zstd is level 19.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync, constants, deflateSync, inflateSync, zstdCompressSync, zstdDecompressSync } from "node:zlib";

const LIMIT = 100_000_000;
try {
	const [operation, codec, input, output, ...extra] = process.argv.slice(2);
	if (extra.length || !["encode", "decode"].includes(operation) || !["deflate", "brotli", "zstd"].includes(codec) || !input || !output) {
		throw new Error("usage: prize-baseline-worker.mjs encode|decode deflate|brotli|zstd INPUT OUTPUT");
	}
	const maximumInput = operation === "encode" ? LIMIT : LIMIT * 2;
	if (!statSync(input).isFile() || statSync(input).size > maximumInput) throw new Error("input exceeds study limit");
	const bytes = readFileSync(input);
	if (bytes.length > maximumInput) throw new Error("input exceeds study limit");
	const encoders = {
		deflate: () => deflateSync(bytes, { level: 9 }),
		brotli: () => brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }),
		zstd: () => zstdCompressSync(bytes, { params: { [constants.ZSTD_c_compressionLevel]: 19 } }),
	};
	const decoders = {
		deflate: () => inflateSync(bytes, { maxOutputLength: LIMIT }),
		brotli: () => brotliDecompressSync(bytes, { maxOutputLength: LIMIT }),
		zstd: () => zstdDecompressSync(bytes, { maxOutputLength: LIMIT }),
	};
	writeFileSync(output, (operation === "encode" ? encoders : decoders)[codec](), { flag: "wx" });
	process.stdout.write(`${JSON.stringify({ peak_rss_kb: process.resourceUsage().maxRSS })}\n`);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
