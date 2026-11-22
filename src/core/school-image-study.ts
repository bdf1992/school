/** Offline, Node-bound checks over AUM's retained RGB8 material. No model or file access. */
import { createHash } from "node:crypto";

export const MAX_IMAGE_STUDY_PACKET_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGE_STUDY_RASTER_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_STUDY_ANSWERS_BYTES = 256 * 1024;
export const IMAGE_STUDY_EVALUATOR = "rgb8-byte-reference-v1" as const;

interface RasterWire {
	width: number;
	height: number;
	layout: "RGB8-row-major";
	data_base64: string;
	sha256: string;
}
type Region = { id: string; label: string } & (
	{ kind: "box"; box: [number, number, number, number] }
	| { kind: "mask"; data_base64: string; sha256: string }
	| { kind: "point"; x: number; y: number }
);
type Task = { id: string } & (
	{ kind: "pixel-bit"; x: number; y: number; channel: number; bit: number }
	| { kind: "region-membership"; region_id: string; x: number; y: number }
	| { kind: "conversion-metrics"; conversion_id: string }
);
export interface ImageStudyPacket {
	schema: "aum.image-study-evaluation/1";
	specimen_id: string;
	raster: RasterWire;
	regions: Region[];
	conversions: { id: string; raster: RasterWire }[];
	tasks: Task[];
}
type ResultValue = Record<string, number | boolean | string>;
interface ParsedPacket {
	wire: ImageStudyPacket;
	raster: Uint8Array;
	masks: Map<string, Uint8Array>;
	conversions: Map<string, Uint8Array>;
	metrics: Map<string, ResultValue>;
}

function invalid(message: string): never { throw new Error(message); }
function object(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${where} must be an object`);
	const row = value as Record<string, unknown>;
	if (Object.keys(row).some((key) => !fields.includes(key))) invalid(`${where} contains an unsupported field`);
	if (fields.some((key) => !Object.hasOwn(row, key))) invalid(`${where} is missing a required field`);
	return row;
}
function integer(value: unknown, minimum: number, maximum: number, where: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		invalid(`${where} must be an integer in [${minimum}, ${maximum}]`);
	}
	return value;
}
function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\0")) {
		invalid(`${where} must be a nonempty string of at most 512 characters without NUL`);
	}
	return value;
}
function unique(id: string, seen: Set<string>, where: string): void {
	if (seen.has(id)) invalid(`${where} IDs must be unique`);
	seen.add(id);
}
function list(value: unknown, minimum: number, maximum: number, where: string): unknown[] {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid(`${where} needs ${minimum}–${maximum} items`);
	return value;
}
function payload(data: unknown, hash: unknown, length: number, where: string): { data_base64: string; sha256: string; bytes: Uint8Array } {
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) invalid(`${where}.sha256 must be 64 lowercase hexadecimal characters`);
	if (typeof data !== "string" || data.length !== Math.ceil(length / 3) * 4
		|| !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
		invalid(`${where}.data_base64 must be canonical base64 of the declared byte length`);
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.byteLength !== length || bytes.toString("base64") !== data) invalid(`${where} payload length or base64 encoding disagrees`);
	if (createHash("sha256").update(bytes).digest("hex") !== hash) invalid(`${where} SHA-256 disagrees with its payload`);
	return { data_base64: data, sha256: hash, bytes };
}
function raster(value: unknown, where: string): { wire: RasterWire; bytes: Uint8Array } {
	const row = object(value, ["width", "height", "layout", "data_base64", "sha256"], where);
	const width = integer(row.width, 1, MAX_IMAGE_STUDY_RASTER_BYTES, `${where}.width`);
	const height = integer(row.height, 1, MAX_IMAGE_STUDY_RASTER_BYTES, `${where}.height`);
	if (row.layout !== "RGB8-row-major") invalid(`${where}.layout must be RGB8-row-major`);
	const length = width * height * 3;
	if (length > MAX_IMAGE_STUDY_RASTER_BYTES) invalid(`${where} exceeds the 4 MiB raster bound`);
	const { data_base64, sha256, bytes } = payload(row.data_base64, row.sha256, length, where);
	return { wire: { width, height, layout: "RGB8-row-major", data_base64, sha256 }, bytes };
}

/** Decode and hash every referenced payload before using any task or candidate values. */
function parsePacket(value: unknown): ParsedPacket {
	let encoded: string | undefined;
	try { encoded = JSON.stringify(value); } catch { invalid("Packet must be bounded JSON"); }
	if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_IMAGE_STUDY_PACKET_BYTES) invalid("Packet exceeds 16 MiB or is not JSON");
	const row = object(value, ["schema", "specimen_id", "raster", "regions", "conversions", "tasks"], "packet");
	if (row.schema !== "aum.image-study-evaluation/1") invalid("Unsupported image-study packet schema");
	const specimen_id = text(row.specimen_id, "specimen_id");
	const base = raster(row.raster, "raster"), { width, height } = base.wire;
	const regionIds = new Set<string>(), masks = new Map<string, Uint8Array>();
	const regions = list(row.regions, 0, 128, "regions").map((raw): Region => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("region must be an object");
		const kind = (raw as Record<string, unknown>).kind;
		const extra = kind === "box" ? ["box"] : kind === "mask" ? ["data_base64", "sha256"] : kind === "point" ? ["x", "y"] : invalid("Unsupported region kind");
		const region = object(raw, ["id", "label", "kind", ...extra], "region");
		const id = text(region.id, "region.id"), label = text(region.label, "region.label");
		unique(id, regionIds, "region");
		if (kind === "box") {
			const coordinates = list(region.box, 4, 4, "box");
			const x0 = integer(coordinates[0], 0, width - 1, "box.x0"), y0 = integer(coordinates[1], 0, height - 1, "box.y0");
			const x1 = integer(coordinates[2], x0 + 1, width, "box.x1"), y1 = integer(coordinates[3], y0 + 1, height, "box.y1");
			return { id, label, kind, box: [x0, y0, x1, y1] };
		}
		if (kind === "mask") {
			const data = payload(region.data_base64, region.sha256, width * height, `mask ${id}`);
			if (data.bytes.some((byte) => byte !== 0 && byte !== 1)) invalid("Mask bytes must be 0 or 1");
			masks.set(id, data.bytes);
			return { id, label, kind, data_base64: data.data_base64, sha256: data.sha256 };
		}
		return { id, label, kind: "point", x: integer(region.x, 0, width - 1, "point.x"), y: integer(region.y, 0, height - 1, "point.y") };
	});
	const conversionIds = new Set<string>(), conversionData = new Map<string, Uint8Array>();
	const conversions = list(row.conversions, 0, 8, "conversions").map((raw) => {
		const conversion = object(raw, ["id", "raster"], "conversion"), id = text(conversion.id, "conversion.id");
		unique(id, conversionIds, "conversion");
		const result = raster(conversion.raster, `conversion ${id}`);
		if (result.wire.width !== width || result.wire.height !== height) invalid("Conversion metrics require the same raster dimensions");
		conversionData.set(id, result.bytes);
		return { id, raster: result.wire };
	});
	const taskIds = new Set<string>();
	const tasks = list(row.tasks, 1, 256, "tasks").map((raw): Task => {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("task must be an object");
		const kind = (raw as Record<string, unknown>).kind;
		const extra = kind === "pixel-bit" ? ["x", "y", "channel", "bit"] : kind === "region-membership" ? ["region_id", "x", "y"] : kind === "conversion-metrics" ? ["conversion_id"] : invalid("Unsupported task kind");
		const task = object(raw, ["id", "kind", ...extra], "task"), id = text(task.id, "task.id");
		unique(id, taskIds, "task");
		if (kind === "conversion-metrics") {
			const conversion_id = text(task.conversion_id, "task.conversion_id");
			if (!conversionIds.has(conversion_id)) invalid("Task names an unknown conversion");
			return { id, kind, conversion_id };
		}
		const x = integer(task.x, 0, width - 1, "task.x"), y = integer(task.y, 0, height - 1, "task.y");
		if (kind === "pixel-bit") return { id, kind, x, y, channel: integer(task.channel, 0, 2, "task.channel"), bit: integer(task.bit, 0, 7, "task.bit") };
		const region_id = text(task.region_id, "task.region_id");
		if (!regionIds.has(region_id)) invalid("Task names an unknown region");
		return { id, kind: "region-membership", region_id, x, y };
	});
	return { wire: { schema: "aum.image-study-evaluation/1", specimen_id, raster: base.wire, regions, conversions, tasks }, raster: base.bytes, masks, conversions: conversionData, metrics: new Map() };
}

function expected(packet: ParsedPacket, task: Task): ResultValue {
	const { width } = packet.wire.raster;
	if (task.kind === "pixel-bit") {
		const byte_offset = 3 * (task.y * width + task.x) + task.channel, byte_value = packet.raster[byte_offset]!;
		return { byte_offset, byte_value, bit_value: Math.floor(byte_value / 2 ** task.bit) % 2,
			word64_index: Math.floor(byte_offset / 8), byte_in_word: byte_offset % 8 };
	}
	if (task.kind === "region-membership") {
		const region = packet.wire.regions.find((item) => item.id === task.region_id)!;
		if (region.kind === "box") {
			const [x0, y0, x1, y1] = region.box;
			return { selected: task.x >= x0 && task.x < x1 && task.y >= y0 && task.y < y1, meaning: "inside_box" };
		}
		if (region.kind === "mask") return { selected: packet.masks.get(region.id)![task.y * width + task.x] === 1, meaning: "inside_mask" };
		return { selected: task.x === region.x && task.y === region.y, meaning: "annotated_point" };
	}
	const retained = packet.metrics.get(task.conversion_id);
	if (retained) return retained;
	let changed_channels = 0, max_abs_error = 0, sum_abs_error = 0;
	const converted = packet.conversions.get(task.conversion_id)!;
	for (let i = 0; i < packet.raster.length; i++) {
		const error = Math.abs(packet.raster[i]! - converted[i]!);
		if (error > 0) changed_channels++;
		max_abs_error = Math.max(max_abs_error, error); sum_abs_error += error;
	}
	const result = { exact: changed_channels === 0, changed_channels, max_abs_error, sum_abs_error };
	packet.metrics.set(task.conversion_id, result);
	return result;
}

function candidateValue(raw: unknown, task: Task, packet: ParsedPacket): ResultValue {
	if (task.kind === "pixel-bit") {
		const row = object(raw, ["byte_offset", "byte_value", "bit_value", "word64_index", "byte_in_word"], "pixel-bit answer");
		return {
			byte_offset: integer(row.byte_offset, 0, packet.raster.length - 1, "byte_offset"),
			byte_value: integer(row.byte_value, 0, 255, "byte_value"), bit_value: integer(row.bit_value, 0, 1, "bit_value"),
			word64_index: integer(row.word64_index, 0, Math.floor((packet.raster.length - 1) / 8), "word64_index"),
			byte_in_word: integer(row.byte_in_word, 0, 7, "byte_in_word"),
		};
	}
	if (task.kind === "region-membership") {
		const row = object(raw, ["selected", "meaning"], "region-membership answer");
		if (typeof row.selected !== "boolean" || !["inside_box", "inside_mask", "annotated_point"].includes(row.meaning as string)) invalid("Membership answer needs a boolean selected and a recognized meaning");
		return { selected: row.selected, meaning: row.meaning as string };
	}
	const row = object(raw, ["exact", "changed_channels", "max_abs_error", "sum_abs_error"], "conversion-metrics answer");
	if (typeof row.exact !== "boolean") invalid("Conversion exact must be boolean");
	return { exact: row.exact, changed_channels: integer(row.changed_channels, 0, packet.raster.length, "changed_channels"),
		max_abs_error: integer(row.max_abs_error, 0, 255, "max_abs_error"), sum_abs_error: integer(row.sum_abs_error, 0, packet.raster.length * 255, "sum_abs_error") };
}

/** This projection has no answer or grade fields; it is not an OS access-control boundary. */
export function imageStudyLearnerView(raw: unknown) {
	const { wire } = parsePacket(raw);
	return { ...wire, schema: "school.image-study-view/1" as const,
		answer_schema: "school.image-study-answers/1" as const, bit_numbering: "LSB0" as const,
		exposure: "SUPPLIED_RASTERS_REGIONS_AND_TASKS" as const };
}

/** Recompute answers from verified raster bytes, independently of AUM's answer producer. */
export function evaluateImageStudy(rawPacket: unknown, rawAnswers: unknown) {
	const packet = parsePacket(rawPacket);
	let encoded: string | undefined;
	try { encoded = JSON.stringify(rawAnswers); } catch { invalid("Answers must be bounded JSON"); }
	if (!encoded || Buffer.byteLength(encoded, "utf8") > MAX_IMAGE_STUDY_ANSWERS_BYTES) invalid("Answers exceed 256 KiB or are not JSON");
	const row = object(rawAnswers, ["schema", "specimen_id", "answers"], "answers");
	if (row.schema !== "school.image-study-answers/1" || row.specimen_id !== packet.wire.specimen_id) invalid("Answer schema or specimen identity disagrees");
	const taskById = new Map(packet.wire.tasks.map((task) => [task.id, task]));
	const values = new Map<string, ResultValue>();
	for (const raw of list(row.answers, 0, 256, "answers.answers")) {
		const answer = object(raw, ["task_id", "value"], "answer"), id = text(answer.task_id, "answer.task_id");
		const task = taskById.get(id);
		if (!task) invalid("Answer names an unknown task");
		if (values.has(id)) invalid("Answer task IDs must be unique");
		values.set(id, candidateValue(answer.value, task, packet));
	}
	if (values.size !== taskById.size) invalid("Missing answers; partial coverage is not a passing assessment");
	const cases = packet.wire.tasks.map((task) => {
		const correctValue = expected(packet, task), actual = values.get(task.id)!;
		return { task_id: task.id, kind: task.kind, expected: correctValue, actual,
			correct: Object.keys(correctValue).every((key) => correctValue[key] === actual[key]) };
	});
	const passed = cases.filter((item) => item.correct).length;
	return { schema: "school.image-study-assessment/1" as const, evaluator: IMAGE_STUDY_EVALUATOR,
		specimen_id: packet.wire.specimen_id, raster_sha256: packet.wire.raster.sha256,
		status: passed === cases.length ? "PASSED" as const : "FAILED" as const,
		counts: { checked: cases.length, passed, failed: cases.length - passed }, cases,
		model_calls: 0, learning: "NOT_ESTABLISHED" as const, annotation_truth: "NOT_CHECKED" as const,
		conversion_scope: "SUPPLIED_SAME_SIZE_RGB8_ARRAYS" as const };
}
