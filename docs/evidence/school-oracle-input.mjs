import { readFileSync, writeFileSync } from "node:fs";
import { generatedFactorizedCases } from "../../src/core/school-experiment.ts";

const fixture = JSON.parse(readFileSync(new URL("../../examples/school/factorized-step.json", import.meta.url), "utf8"));
const batches = Array.from({ length: 128 }, (_, index) => ({ source: "generated", seed: index + 1, ...generatedFactorizedCases(index + 1) }));
batches.push({ source: "checked-in-manifest", seed: fixture.experiment.seed, teaching: fixture.teaching, evaluation: fixture.evaluation, transfer: fixture.experiment.transfer });
if (!process.argv[2]) throw new Error("Provide a new output JSON filename");
writeFileSync(process.argv[2], JSON.stringify({ batches }) + "\n", { flag: "wx", mode: 0o600 });
