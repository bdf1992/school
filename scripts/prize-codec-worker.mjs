// Fixed, reviewable smoke codec. Never loads a program named by an entrant manifest.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";

const LIMIT = 1_048_576;
try {
  const [operation, codec, input, output, ...extra] = process.argv.slice(2);
  if (extra.length || !["encode", "decode"].includes(operation) || !["raw", "deflate"].includes(codec) || !input || !output) {
    throw new Error("usage: prize-codec-worker.mjs encode|decode raw|deflate INPUT OUTPUT");
  }
  const maximumInput = operation === "encode" ? LIMIT : LIMIT + 65_536;
  if (!statSync(input).isFile() || statSync(input).size > maximumInput) throw new Error("input exceeds smoke limit");
  const bytes = readFileSync(input);
  if (bytes.length > maximumInput) throw new Error("input exceeds smoke limit");
  const result = codec === "raw" ? bytes : operation === "encode"
    ? deflateSync(bytes, { level: 9 })
    : inflateSync(bytes, { maxOutputLength: LIMIT });
  if (operation === "decode" && result.length > LIMIT) throw new Error("decoded output exceeds smoke limit");
  writeFileSync(output, result, { flag: "wx" });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
