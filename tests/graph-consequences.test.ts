import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeFindings, simplifyChains, type GraphDeps } from "../src/core/graph.ts";
import type { GraphChain, GraphNode, SessionFindings } from "../src/core/contracts.ts";

function chain(id: string, premises: string[], conclusion: string, order: number): GraphChain {
	return { id, premises, conclusion, createdAt: `2026-01-${String(order).padStart(2, "0")}`,
		provenance: [{ chatId: "source", messageId: "" }] };
}

// Independent fixed-point oracle: deliberately does not share the production
// work queue, counters, indexing or pruning logic.
function closure(rules: GraphChain[], assumptions: string[]): string[] {
	const known = new Set(assumptions);
	for (;;) {
		const next = rules.filter((rule) => rule.premises.every((p) => known.has(p)))
			.map((rule) => rule.conclusion).filter((c) => !known.has(c));
		if (!next.length) return [...known].sort();
		for (const conclusion of next) known.add(conclusion);
	}
}

describe("graph simplification preserves joint consequences", () => {
	it("keeps a route whose single premise cannot establish a joint ancestor", () => {
		const rules = [
			chain("ab-x", ["a", "b"], "x", 1),
			chain("x-y", ["x"], "y", 2),
			chain("a-y", ["a"], "y", 3),
		];
		const kept = simplifyChains(rules);
		assert.deepEqual(kept, rules);
		assert.deepEqual(closure(kept, ["a"]), ["a", "y"]);
	});

	it("does not combine incomplete premises from alternative derivations", () => {
		const rules = [
			chain("a-x", ["a"], "x", 1),
			chain("bc-x", ["b", "c"], "x", 2),
			chain("x-y", ["x"], "y", 3),
			chain("b-y", ["b"], "y", 4),
		];
		assert.deepEqual(simplifyChains(rules), rules);
	});

	it("still removes a route when all joint and transitive premises suffice", () => {
		const rules = [
			chain("w-a", ["w"], "a", 1),
			chain("ab-x", ["a", "b"], "x", 2),
			chain("xc-y", ["x", "c"], "y", 3),
			chain("wbc-y", ["w", "b", "c"], "y", 4),
		];
		const kept = simplifyChains(rules);
		assert.deepEqual(kept.map((c) => c.id), ["w-a", "ab-x", "xc-y"]);
		assert.deepEqual(closure(kept, ["w", "b", "c"]), closure(rules, ["w", "b", "c"]));
	});

	it("preserves every initial-state closure for all 512 three-node rule sets, including cycles", () => {
		const nodes = ["a", "b", "c"];
		const candidates: GraphChain[] = [];
		for (const conclusion of nodes) {
			const other = nodes.filter((n) => n !== conclusion);
			for (let mask = 1; mask < 4; mask++) {
				const premises = other.filter((_, i) => mask & (1 << i));
				candidates.push(chain(`rule-${candidates.length}`, premises, conclusion, candidates.length + 1));
			}
		}
		assert.equal(candidates.length, 9);
		for (let graphMask = 0; graphMask < 1 << candidates.length; graphMask++) {
			const rules = candidates.filter((_, i) => graphMask & (1 << i));
			const kept = simplifyChains(rules);
			for (let stateMask = 0; stateMask < 8; stateMask++) {
				const assumptions = nodes.filter((_, i) => stateMask & (1 << i));
				assert.deepEqual(closure(kept, assumptions), closure(rules, assumptions),
					`consequences differ for rule mask ${graphMask}, assumption mask ${stateMask}`);
			}
		}
	});
});

function memoryGraph() {
	let nodes: GraphNode[] = [{ id: "n_c", name: "C", statement: "C", aliases: [],
		createdAt: "2026-01-01", provenance: [] }];
	let chains: GraphChain[] = [];
	const deps = { graphStore: {
		readNodes: () => nodes,
		readChains: () => chains,
		appendNode: (node: GraphNode) => { nodes.push(node); },
		appendChain: (value: GraphChain) => { chains.push(value); },
		rewriteLedgers: (next: { chains?: GraphChain[] }) => { if (next.chains) chains = next.chains; },
		appendCheckpoint: () => undefined,
	}, chatStore: {} } as unknown as GraphDeps;
	return { deps, chains: () => chains };
}

describe("graph merge never strengthens an incomplete or tautological argument", () => {
	const propositions = ["a", "b", "c"].map((id) => ({ id, name: id, statement: id, aliases: [] }));
	it("drops the whole chain when identity links make a premise its conclusion", () => {
		const store = memoryGraph();
		const findings: SessionFindings = { propositions, chains: [{ premises: ["a", "b"], conclusion: "c" }] };
		const stats = mergeFindings("source", findings,
			{ links: [{ id: "b", linkTo: "n_c" }, { id: "c", linkTo: "n_c" }] },
			store.deps, { foldedAt: "2026-01-02" });
		assert.equal(stats.chains, 0);
		assert.deepEqual(store.chains(), []);
	});

	it("drops the whole chain when any premise cannot resolve", () => {
		const store = memoryGraph();
		mergeFindings("source", { propositions, chains: [{ premises: ["a", "missing"], conclusion: "c" }] },
			{ links: [] }, store.deps, { foldedAt: "2026-01-02" });
		assert.deepEqual(store.chains(), []);
	});
});
