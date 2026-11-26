import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SplitRefusal, SplitRegistry, checkDisjoint } from "../src/core/builder/splits.ts";
import { G0_FIXTURES, canonicalCaseEncoding, identityOf, parseCase } from "../src/core/builder/task.ts";

const c1 = { receiver: "A", signals: [220], conditionOps: [{ turn: 0, op: "shade" }, { turn: 0, op: "shade" }] };
const c1Strings = { receiver: "A", signals: [220], condition_ops: ["shade", "shade"] };
const m1 = { receiver: "A", signals: [220, null], conditionOps: [] };
const m1Word = { receiver: "A", signals: [220, "missing"] };

describe("builder identity and splits", () => {
	it("identity: encodings share one identity", () => {
		assert.equal(identityOf(c1), identityOf(c1Strings));
		assert.equal(identityOf(m1), identityOf(m1Word));
		assert.equal(identityOf(c1), identityOf(G0_FIXTURES[2].case));
		assert.notEqual(identityOf(c1), identityOf(m1));
	});
	it("identity: canonical encoding is exact and receiver matters", () => {
		assert.equal(
			canonicalCaseEncoding(parseCase(m1Word)),
			'{"conditions":[0,0],"law_version":"builder-v0","receiver":"A","signals":[220,null]}',
		);
		assert.notEqual(identityOf({ ...m1, receiver: "B" }), identityOf(m1));
	});
	it("identity: cases the resident cannot tell apart share one identity and cannot cross splits", () => {
		const bare = { receiver: "A", signals: [220], conditionOps: [] };
		for (const ops of [["shade", "unshade"], ["unshade"]]) {
			const twin = { ...bare, conditionOps: ops };
			assert.equal(identityOf(twin), identityOf(bare));
			const reg = new SplitRegistry();
			reg.add("sealed", bare);
			assert.throws(() => reg.add("training", twin));
		}
		const four = { receiver: "A", signals: [220], conditionOps: ["shade", "shade", "shade", "shade"] };
		const three = { ...four, conditionOps: ["shade", "shade", "shade"] };
		assert.equal(identityOf(four), identityOf(three));
		assert.notEqual(identityOf(bare), identityOf(c1));
	});
	it("parseCase refuses bad encodings", () => {
		assert.throws(() => parseCase({ receiver: "C", signals: [1] }));
		assert.throws(() => parseCase({ receiver: "A", signals: [256] }));
		assert.throws(() => parseCase({ receiver: "A", signals: [1], conditionOps: ["dim"] }));
		assert.throws(() => parseCase({ receiver: "A", signals: [1], conditionOps: [{ turn: 3, op: "shade" }] }));
	});
	it("registry refuses a re-encoded copy in another split, allows the same split", () => {
		const reg = new SplitRegistry();
		reg.add("sealed", m1);
		assert.throws(() => reg.add("training", m1Word), SplitRefusal);
		assert.equal(reg.add("sealed", m1Word), identityOf(m1));
		reg.add("training", c1);
		assert.throws(() => reg.add("teaching", c1Strings), SplitRefusal);
		assert.equal(reg.splitOf(c1Strings), "training");
	});
	it("checkDisjoint reports collisions by identity", () => {
		assert.deepEqual(checkDisjoint({ training: [c1], sealed: [m1] }), { disjoint: true, collisions: [] });
		const r = checkDisjoint({ training: [c1], sealed: [m1, c1Strings] });
		assert.equal(r.disjoint, false);
		assert.deepEqual(r.collisions, [{ identity: identityOf(c1), splits: ["sealed", "training"] }]);
	});
});
