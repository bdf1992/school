/**
 * School drives Worldspine seats through the native seat boundary: `ws_pg join` as School's child process, one JSON
 * object per line on standard input and output. No new transport and no new envelope: a School proposal becomes a
 * `join` `act`, the adapter keeps the `act_id` it sent so a retry resends that same id, and every line the host and
 * the seats print is kept as evidence.
 *
 *   npm run school:worldspine-seat -- --pg <ws_pg.exe> --playground <Worldspine/engine/playground> --out <run.jsonl>
 *                                     [--plant double-delivery]
 *
 * The scenario is the DS1 boundary set on a fresh copy of the shared room: a normal act, an identical retry, a
 * conflicting retry, an observer's refused act, a move the room admits but the walker cannot make, and both seats'
 * views after. `--plant double-delivery` mints a fresh act id on retry instead of resending the kept one; a correct
 * acceptance check must reject that run.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

type Line = Record<string, unknown> & { event?: string };
const WAIT_MS = 12_000;

/** One native process, its standard input driven and every line it prints kept (JSON lines parsed). */
export class NativeProcess {
	readonly lines: Line[] = [];
	readonly errors: string[] = [];
	exitCode: number | null = null;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly listeners = new Set<() => void>();

	constructor(readonly argv: string[]) {
		const [program, ...args] = argv;
		if (!program) throw new Error("no program to run");
		this.child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		createInterface({ input: this.child.stdout }).on("line", (text) => {
			try {
				this.lines.push(JSON.parse(text));
			} catch {
				this.lines.push({ event: "unreadable", text });
			}
			this.notify();
		});
		createInterface({ input: this.child.stderr }).on("line", (text) => {
			this.errors.push(text);
			this.notify();
		});
		this.child.on("exit", (code) => {
			this.exitCode = code;
			this.notify();
		});
		this.child.on("error", (error) => {
			this.errors.push(`spawn failed: ${error.message}`);
			this.exitCode = -1;
			this.notify();
		});
	}

	private notify() {
		for (const listener of [...this.listeners]) listener();
	}

	send(text: string) {
		if (this.exitCode === null && this.child.stdin.writable) this.child.stdin.write(`${text}\n`);
	}

	cmd(call: Record<string, unknown>) {
		this.send(JSON.stringify(call));
	}

	/** Resolves true once `pred` holds, false when the time runs out or the process has ended without it holding. */
	wait(pred: () => boolean, timeoutMs = WAIT_MS): Promise<boolean> {
		if (pred()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const finish = (value: boolean) => {
				clearTimeout(timer);
				this.listeners.delete(check);
				resolve(value);
			};
			const check = () => {
				if (pred()) finish(true);
				else if (this.exitCode !== null) finish(pred());
			};
			const timer = setTimeout(() => finish(pred()), timeoutMs);
			this.listeners.add(check);
		});
	}

	events(name: string): Line[] {
		return this.lines.filter((line) => line.event === name);
	}

	messages(kind: string): Record<string, unknown>[] {
		return this.lines
			.filter((line) => line.event === "message" && line.kind === kind)
			.map((line) => line.body as Record<string, unknown>);
	}

	async stop() {
		if (this.exitCode === null) {
			this.child.stdin.end();
			const ended = await this.wait(() => this.exitCode !== null, 5_000);
			if (!ended) this.child.kill();
		}
		await this.wait(() => this.exitCode !== null, 5_000);
	}
}

/**
 * The act ids School has sent, by proposal. A retry of a proposal resends the id it was first sent with, so the
 * host can answer it with the original receipt. The `double-delivery` plant is the defect the acceptance check
 * exists to catch: it mints a fresh id on every retry.
 */
export class ProposalIds {
	private readonly kept = new Map<string, string>();

	constructor(private readonly plant: "" | "double-delivery" = "", private readonly mint: () => string = () => randomUUID()) {}

	first(proposal: string): string {
		const id = this.mint();
		this.kept.set(proposal, id);
		return id;
	}

	retry(proposal: string): string {
		const id = this.kept.get(proposal);
		if (id === undefined) throw new Error(`no act id kept for proposal ${proposal}`);
		if (this.plant === "double-delivery") return this.mint();
		return id;
	}
}

/** A `ws_pg host` with manual turns and School's seats joined to it through `ws_pg join`. */
export class SeatRoom {
	readonly host: NativeProcess;
	readonly seats = new Map<string, NativeProcess>();
	private readonly subscribed = new Set<string>();
	private pings = 0;
	port = 0;

	constructor(private readonly pg: string, experiment: string) {
		this.host = new NativeProcess([pg, "host", "--experiment", experiment, "--port", "0", "--limit", "60", "--turns", "manual"]);
	}

	async open(seatNames: string[]): Promise<boolean> {
		await this.host.wait(() => this.host.events("listening").length > 0);
		const listening = this.host.events("listening")[0];
		if (!listening) return false;
		this.port = Number(listening.port);
		for (const seat of seatNames) {
			this.seats.set(seat, new NativeProcess([this.pg, "join", "--port", String(this.port), "--seat", seat, "--principal", `${seat}@local`, "--limit", "60"]));
		}
		const welcomed = await Promise.all([...this.seats.values()].map((s) => s.wait(() => s.messages("welcome").length > 0)));
		return welcomed.every(Boolean);
	}

	seat(name: string): NativeProcess {
		const seat = this.seats.get(name);
		if (!seat) throw new Error(`seat ${name} is not joined`);
		return seat;
	}

	answers(): Line[] {
		return this.host.lines.filter((line) => line.event === "admitted" || line.event === "refused");
	}

	private sentTo(seat: string): Line[] {
		return this.host.events("sent").filter((line) => line.seat === seat);
	}

	/** Every subscribed seat holds what the host last sent it: same frontier, same digest. */
	async settle(): Promise<boolean> {
		const token = `p${++this.pings}`;
		this.host.send(`ping ${token}`);
		if (!(await this.host.wait(() => this.host.events("pong").some((e) => e.token === token)))) return false;
		for (const name of [...this.subscribed].sort()) {
			const want = this.sentTo(name).at(-1);
			if (!want) return false;
			const seat = this.seat(name);
			const latest = () => seat.events("applied").at(-1);
			if (!(await seat.wait(() => latest()?.frontier === want.frontier))) return false;
			if (latest()?.digest !== want.digest) return false;
		}
		return true;
	}

	async subscribe(): Promise<boolean> {
		const before = new Map([...this.seats.keys()].map((s) => [s, this.sentTo(s).length]));
		for (const [name, seat] of this.seats) {
			seat.cmd({ cmd: "subscribe" });
			this.subscribed.add(name);
		}
		for (const name of this.seats.keys()) {
			if (!(await this.host.wait(() => this.sentTo(name).length > (before.get(name) ?? 0)))) return false;
		}
		return this.settle();
	}

	/** The seat proposes one act; resolves once the host has answered it (or the wait ran out) and the seats are settled. */
	async act(seat: string, operation: string, params: Record<string, unknown>, actId: string, answerWaitMs = WAIT_MS): Promise<boolean> {
		const before = this.answers().length;
		this.seat(seat).cmd({ cmd: "act", operation, params, act_id: actId });
		const answered = await this.host.wait(() => this.answers().length > before, answerWaitMs);
		return (await this.settle()) && answered;
	}

	async turn(): Promise<boolean> {
		this.host.send("turn");
		if (!(await this.settle())) return false;
		for (const [name, seat] of this.seats) {
			const mine = this.host.events("admitted").filter((e) => e.seat === name).length;
			if (!(await seat.wait(() => seat.messages("receipt").length >= mine, 2_000))) return false;
		}
		return true;
	}

	/** What the seat holds, as `join` prints it on `observe`. */
	async hold(seat: string): Promise<Line> {
		const client = this.seat(seat);
		const count = client.events("observation").length;
		client.cmd({ cmd: "observe" });
		await client.wait(() => client.events("observation").length > count);
		const last = client.events("observation").at(-1);
		if (!last) throw new Error(`seat ${seat} printed no observation`);
		return last;
	}

	async close() {
		for (const seat of this.seats.values()) seat.cmd({ cmd: "quit" });
		this.host.send("quit");
		await Promise.all([...this.seats.values(), this.host].map((p) => p.stop()));
	}
}

/** A copy of the shared room with its own replication budget, so the run never touches Worldspine's checkout. */
export function roomCopy(playground: string, work: string, budget: number): string {
	cpSync(join(playground, "cells"), join(work, "cells"), { recursive: true });
	cpSync(join(playground, "experiments", "shared-room"), join(work, "experiments", "shared-room"), { recursive: true });
	const replication = join(work, "experiments", "shared-room", "replication.json");
	const declared = JSON.parse(readFileSync(replication, "utf8"));
	declared.budget_bytes = budget;
	writeFileSync(replication, JSON.stringify(declared));
	return join(work, "experiments", "shared-room", "experiment.json");
}

type Particle = { address: string; axes: Record<string, unknown> };

function movedAxes(view: Line) {
	const particles = ((view.observation as { particles: Particle[] }).particles);
	return particles
		.filter((p) => "moved" in p.axes || "reason" in p.axes)
		.map((p) => {
			const out: Record<string, unknown> = { address: p.address };
			for (const key of ["heading", "moved", "reason"]) if (key in p.axes) out[key] = p.axes[key];
			return out;
		});
}

const SET = (value: number) => ({ property: "high", value }); // the shared room declares writes of high/low

export type Step = { step: string; ok: boolean } & Record<string, unknown>;

/** The DS1 boundary cases, proposed by School through `join`. Returns the steps in the shape `accept.py` reads. */
export async function runBoundaryCases(room: SeatRoom, ids: ProposalIds): Promise<Step[]> {
	const steps: Step[] = [];
	const step = (name: string, ok: boolean, facts: Record<string, unknown> = {}) => {
		steps.push({ step: name, ok, ...facts });
	};
	const since = (n: number) => room.answers().slice(n);
	step("up", (await room.open(["designer", "builder", "observer"])) && (await room.subscribe()));
	const designer = room.seat("designer");
	const views = { designer: await room.hold("designer"), observer: await room.hold("observer") };
	step("views", true, Object.fromEntries(Object.entries(views).map(([seat, v]) => [seat, Object.keys(v).sort()])));

	let n = room.answers().length;
	const normalId = ids.first("set-high");
	const normalOk = (await room.act("designer", "pg.set", SET(3), normalId)) && (await room.turn());
	step("normal", normalOk, { sent: normalId, host: since(n), receipts: designer.messages("receipt").slice(-1) });

	n = room.answers().length;
	const retryId = ids.retry("set-high");
	await room.act("designer", "pg.set", SET(3), retryId, 1_000);
	step("identical-retry", true, { sent: retryId, host: since(n), receipts: designer.messages("receipt").length });

	n = room.answers().length;
	await room.act("designer", "pg.set", SET(7), retryId, 1_000);
	step("conflicting-retry", true, { sent: retryId, host: since(n), refused: designer.messages("refused").slice(-1) });

	n = room.answers().length;
	const observerId = ids.first("observer-set");
	await room.act("observer", "pg.set", SET(9), observerId, 1_000);
	step("observer-refused", true, { sent: observerId, host: since(n), refused: room.seat("observer").messages("refused").slice(-1) });
	await room.turn();

	for (let d = 0; d < 4; d++) {
		n = room.answers().length;
		await room.act("designer", "pg.move", { property: "heading", direction: d }, ids.first(`move-${d}`));
		await room.turn();
		step(`move-${d}`, true, { host: since(n), axes: movedAxes(await room.hold("designer")) });
	}

	const particles = ((await room.hold("designer")).observation as { particles: Particle[] }).particles;
	const wall = particles.find((p) => p.axes.wall)?.axes;
	if (!wall) throw new Error("the designer's view shows no wall to move onto");
	const target = `${wall.x},${wall.y}`;
	n = room.answers().length;
	await room.act("designer", "pg.move-mark", { property: "request", target }, ids.first("mark-wall"));
	await room.turn();
	step("admitted-unsuccessful", true, { target, host: since(n), axes: movedAxes(await room.hold("designer")) });
	step("after", true, { designer: await room.hold("designer"), observer: await room.hold("observer") });
	return steps;
}

function evidence(room: SeatRoom, steps: Step[]): string {
	const processes: [string, NativeProcess][] = [["host", room.host], ...room.seats];
	const records = processes.map(([who, p]) => ({ who, argv: p.argv.slice(1), exit: p.exitCode, stderr: p.errors, lines: p.lines }));
	return [...records, { steps }].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function option(argv: string[], name: string): string | undefined {
	const at = argv.indexOf(name);
	return at >= 0 ? argv[at + 1] : undefined;
}

export async function main(argv: string[]): Promise<number> {
	const pg = option(argv, "--pg");
	const playground = option(argv, "--playground");
	const out = option(argv, "--out");
	const plant = option(argv, "--plant") ?? "";
	if (!pg || !playground || !out || (plant !== "" && plant !== "double-delivery")) {
		console.error("usage: school-worldspine-seat --pg <ws_pg> --playground <dir> --out <run.jsonl> [--plant double-delivery]");
		return 2;
	}
	const work = mkdtempSync(join(tmpdir(), "school-seat-"));
	const room = new SeatRoom(pg, roomCopy(playground, work, 200_000));
	let steps: Step[] = [];
	try {
		steps = await runBoundaryCases(room, new ProposalIds(plant));
	} finally {
		await room.close();
		writeFileSync(out, evidence(room, steps));
		rmSync(work, { recursive: true, force: true });
	}
	for (const s of steps) console.log(s.step, "->", s.ok);
	return steps.every((s) => s.ok) ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.stack : error);
			process.exit(1);
		},
	);
}
