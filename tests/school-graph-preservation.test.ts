import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	AuditVerdicts,
	CoverageEntry,
	GraphChain,
	GraphNode,
	SessionCheckpoint,
	SessionFindings,
} from "../src/core/contracts/graph.ts";
import { getGraph, mergeFindings, type GraphDeps } from "../src/core/graph.ts";
import type { GraphStore } from "../src/core/ports.ts";

// Exercise the production module and its real simplification/read passes.
// Only the storage port is in memory; no filesystem or model calls are needed.
const foldedAt = "2026-11-09T00:00:00.000Z";

function node(id: string): GraphNode {
	return {
		id,
		name: id,
		statement: `Statement of ${id}.`,
		aliases: [],
		createdAt: foldedAt,
		provenance: [{ chatId: "earlier_source", messageId: "earlier_message" }],
	};
}

function proposition(id: string): SessionFindings["propositions"][number] {
	return {
		id,
		name: id,
		statement: `Statement of ${id}.`,
		aliases: [`Original phrasing of ${id}.`],
		messageId: `message_${id}`,
	};
}

function memoryGraph(initialNodes: GraphNode[] = [], initialChains: GraphChain[] = []) {
	let nodes = structuredClone(initialNodes);
	let chains = structuredClone(initialChains);
	let checkpoints: SessionCheckpoint[] = [];
	let coverage: CoverageEntry[] = [];
	const unexpected = (): never => {
		throw new Error("The graph merge called an unrelated storage operation.");
	};
	const graphStore: GraphStore = {
		readNodes: () => structuredClone(nodes),
		appendNode: (value) => { nodes.push(structuredClone(value)); },
		readChains: () => structuredClone(chains),
		appendChain: (value) => { chains.push(structuredClone(value)); },
		readCheckpoints: () => structuredClone(checkpoints),
		appendCheckpoint: (value) => { checkpoints.push(structuredClone(value)); },
		readCoverage: () => structuredClone(coverage),
		appendCoverage: (value) => { coverage.push(structuredClone(value)); },
		rewriteLedgers: (next) => {
			if (next.nodes !== undefined) nodes = structuredClone(next.nodes);
			if (next.chains !== undefined) chains = structuredClone(next.chains);
			if (next.checkpoints !== undefined) checkpoints = structuredClone(next.checkpoints);
			if (next.coverage !== undefined) coverage = structuredClone(next.coverage);
		},
		upsertSource: unexpected,
		readSources: unexpected,
		deleteSources: unexpected,
		appendSourceUsage: unexpected,
		readPositions: unexpected,
		writePositions: unexpected,
	};
	const deps: GraphDeps = {
		graphStore,
		chatStore: new Proxy({} as GraphDeps["chatStore"], { get: unexpected }),
	};
	return { graphStore, deps };
}

describe("School graph: preserve joint inference during identity resolution", () => {
	it("rejects the whole chain when one joint premise is unresolved, retaining source material and coverage", () => {
		const { graphStore, deps } = memoryGraph();
		const propositions = [proposition("p1"), proposition("p2")];
		const coverage = [{ chatId: "session", fp: "source_fingerprint", tokens: 12, foldedAt }];
		const stats = mergeFindings("session", {
			propositions,
			chains: [{ premises: ["p1", "missing"], conclusion: "p2" }],
		}, { links: [] }, deps, { foldedAt, coverage });

		assert.deepEqual(stats, { nodes: 2, chains: 0 });
		assert.deepEqual(graphStore.readChains(), []);
		assert.deepEqual(graphStore.readNodes().map(({ name, statement, aliases, provenance }) => ({
			name, statement, aliases, provenance,
		})), propositions.map((p) => ({
			name: p.name, statement: p.statement, aliases: p.aliases,
			provenance: [{ chatId: "session", messageId: p.messageId }],
		})));
		assert.deepEqual(graphStore.readCoverage(), coverage);
		assert.deepEqual(graphStore.readCheckpoints(), []);
	});

	it("rejects a whole chain when identity links make a premise equal to its conclusion", () => {
		const existing = node("n_conclusion");
		const { graphStore, deps } = memoryGraph([existing]);
		const findings: SessionFindings = {
			propositions: [proposition("p1"), proposition("p2"), proposition("p3")],
			chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
		};
		const stats = mergeFindings("session", findings, {
			links: [
				{ id: "p1", linkTo: existing.id },
				{ id: "p3", linkTo: existing.id },
			],
		}, deps, { foldedAt });

		assert.deepEqual(stats, { nodes: 1, chains: 0 });
		assert.deepEqual(graphStore.readChains(), [], "[C, A] => C must never become A => C");
		assert.deepEqual(graphStore.readNodes()[0], existing, "the original node line is unchanged");
		const linked = getGraph(graphStore).nodes.find((n) => n.id === existing.id)!;
		assert.equal(linked.statement, existing.statement);
		assert.ok(linked.aliases.includes(findings.propositions[0]!.statement));
		assert.ok(linked.aliases.includes(findings.propositions[2]!.statement));
		assert.deepEqual(linked.provenance, [
			...existing.provenance,
			{ chatId: "session", messageId: "message_p1" },
			{ chatId: "session", messageId: "message_p3" },
		]);
		assert.deepEqual(graphStore.readCheckpoints(), [{ chatId: "session", foldedAt }]);
	});

	it("rejects a tautology spanning an existing digest id and a local conclusion", () => {
		const { graphStore, deps } = memoryGraph([node("n_conclusion")]);
		mergeFindings("session", {
			propositions: [proposition("p1"), proposition("p2")],
			chains: [{ premises: ["n_conclusion", "p1"], conclusion: "p2" }],
		}, { links: [{ id: "p2", linkTo: "n_conclusion" }] }, deps, { foldedAt });
		assert.deepEqual(graphStore.readChains(), []);
	});

	for (const [label, chain] of [
		["an unknown conclusion", { premises: ["p1"], conclusion: "missing" }],
		["only unknown premises", { premises: ["missing"], conclusion: "p2" }],
		["an empty premise list", { premises: [], conclusion: "p2" }],
		["a single-premise self-loop", { premises: ["p2"], conclusion: "p2" }],
	] as const) {
		it(`continues to omit ${label}`, () => {
			const { graphStore, deps } = memoryGraph();
			mergeFindings("session", {
				propositions: [proposition("p1"), proposition("p2")],
				chains: [{ premises: [...chain.premises], conclusion: chain.conclusion }],
			}, { links: [] }, deps, { foldedAt });
			assert.deepEqual(graphStore.readChains(), []);
		});
	}

	it("retains every valid joint premise and deduplicates equivalent phrasings and reordered assertions", () => {
		const { graphStore, deps } = memoryGraph([node("n_a")]);
		const stats = mergeFindings("session", {
			propositions: ["p1", "alias1", "p2", "p3"].map(proposition),
			chains: [
				{ premises: ["p1", "alias1", "p2", "p2"], conclusion: "p3" },
				{ premises: ["p2", "n_a"], conclusion: "p3" },
			],
		}, { links: [{ id: "p1", linkTo: "n_a" }, { id: "alias1", linkTo: "n_a" }] }, deps, { foldedAt });
		const idOf = (name: string) => graphStore.readNodes().find((n) => n.name === name)!.id;
		const chains = graphStore.readChains();

		assert.deepEqual(stats, { nodes: 2, chains: 1 });
		assert.equal(chains.length, 1);
		assert.deepEqual(chains[0]!.premises, ["n_a", idOf("p2")]);
		assert.equal(chains[0]!.conclusion, idOf("p3"));
		assert.deepEqual(chains[0]!.provenance, [{ chatId: "session", messageId: "" }]);
	});

	it("reuses the argument id across sources and keeps both sources' provenance", () => {
		const earlier: GraphChain = {
			id: "arg_existing", premises: ["n_a", "n_b"], conclusion: "n_c",
			createdAt: foldedAt, provenance: [{ chatId: "earlier_source", messageId: "" }],
		};
		const { graphStore, deps } = memoryGraph(["n_a", "n_b", "n_c"].map(node), [earlier]);
		const findings: SessionFindings = {
			propositions: [],
			chains: [{ premises: ["n_b", "n_a", "n_b"], conclusion: "n_c" }],
		};
		assert.deepEqual(mergeFindings("session", findings, { links: [] }, deps, { foldedAt }), { nodes: 0, chains: 1 });
		assert.deepEqual(mergeFindings("session", findings, { links: [] }, deps, { foldedAt }), { nodes: 0, chains: 0 });
		assert.equal(graphStore.readChains().length, 2);
		assert.deepEqual(getGraph(graphStore).chains, [{
			...earlier,
			provenance: [...earlier.provenance, { chatId: "session", messageId: "" }],
		}]);
	});

	it("keeps an independent valid argument when another argument has an unresolved premise", () => {
		const { graphStore, deps } = memoryGraph();
		const stats = mergeFindings("session", {
			propositions: ["p1", "p2", "p3"].map(proposition),
			chains: [
				{ premises: ["p1", "missing"], conclusion: "p2" },
				{ premises: ["p1"], conclusion: "p3" },
			],
		}, { links: [] }, deps, { foldedAt });
		const idOf = (name: string) => graphStore.readNodes().find((n) => n.name === name)!.id;
		assert.deepEqual(stats, { nodes: 3, chains: 1 });
		assert.deepEqual(graphStore.readChains().map(({ premises, conclusion }) => ({ premises, conclusion })), [
			{ premises: [idOf("p1")], conclusion: idOf("p3") },
		]);
	});

	it("preserves implication truth across all 27 identity maps and all 8 Boolean valuations", () => {
		const ids = ["n_a", "n_b", "n_c"];
		const counterexamples: object[] = [];
		for (const a of ids) for (const b of ids) for (const c of ids) {
			const { graphStore, deps } = memoryGraph(ids.map(node));
			const verdicts: AuditVerdicts = {
				links: [{ id: "p1", linkTo: a }, { id: "p2", linkTo: b }, { id: "p3", linkTo: c }],
			};
			mergeFindings("session", {
				propositions: ["p1", "p2", "p3"].map(proposition),
				chains: [{ premises: ["p1", "p2"], conclusion: "p3" }],
			}, verdicts, deps, { foldedAt });
			for (let mask = 0; mask < 8; mask++) {
				const values = new Map(ids.map((id, i) => [id, Boolean(mask & (1 << i))]));
				const original = !(values.get(a) && values.get(b)) || values.get(c);
				// An omitted tautology contributes no constraint. A retained
				// argument must impose exactly its original implication.
				const merged = graphStore.readChains().every((chain) =>
					!chain.premises.every((p) => values.get(p)) || values.get(chain.conclusion),
				);
				if (original !== merged) counterexamples.push({ a, b, c, mask, original, merged });
			}
		}
		assert.deepEqual(counterexamples, [], "identity resolution must not invent a stronger implication");
	});
});
