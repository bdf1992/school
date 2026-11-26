/**
 * Split registry — the one role that keeps splits (training, teaching,
 * sealed assessment, ...) disjoint BY CASE IDENTITY, so a renamed or
 * re-encoded copy cannot cross from one split to another.
 */
import { caseIdentity, parseCase } from "./task.ts";

export class SplitRefusal extends Error {
	constructor(
		readonly identity: string,
		readonly existingSplit: string,
		readonly requestedSplit: string,
	) {
		super(`case ${identity} already lives in split '${existingSplit}', refused for '${requestedSplit}'`);
	}
}

export class SplitRegistry {
	private readonly owner = new Map<string, string>();

	/** Registers a case (any accepted encoding); returns its identity. Idempotent within one split. */
	add(split: string, raw: unknown): string {
		if (split === "") throw new Error("split name required");
		const id = caseIdentity(parseCase(raw));
		const existing = this.owner.get(id);
		if (existing !== undefined && existing !== split) throw new SplitRefusal(id, existing, split);
		this.owner.set(id, split);
		return id;
	}

	splitOf(raw: unknown): string | undefined {
		return this.owner.get(caseIdentity(parseCase(raw)));
	}

	identities(split: string): string[] {
		return [...this.owner].filter(([, s]) => s === split).map(([id]) => id).sort();
	}
}

export interface SplitCollision {
	identity: string;
	splits: string[];
}

/** Checks a set of splits (name -> cases) is disjoint by identity. */
export function checkDisjoint(splits: Record<string, unknown[]>): { disjoint: boolean; collisions: SplitCollision[] } {
	const seen = new Map<string, Set<string>>();
	for (const [name, cases] of Object.entries(splits)) {
		for (const c of cases) {
			const id = caseIdentity(parseCase(c));
			if (!seen.has(id)) seen.set(id, new Set());
			seen.get(id)!.add(name);
		}
	}
	const collisions = [...seen]
		.filter(([, s]) => s.size > 1)
		.map(([identity, s]) => ({ identity, splits: [...s].sort() }))
		.sort((a, b) => (a.identity < b.identity ? -1 : 1));
	return { disjoint: collisions.length === 0, collisions };
}
