import hashlib
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from fractions import Fraction
from pathlib import Path

source_path, summary_path = map(Path, sys.argv[1:3])
data = json.loads(source_path.read_text())
counts = Counter()
failures = []


def answer(parameters):
    a, b, x, target, rate = [Fraction(parameters[key]) for key in ("a", "b", "x", "target", "rate")]
    if parameters["operation"] == "product":
        return a * b
    if parameters["operation"] != "step":
        raise ValueError("Unknown operation")
    # With one factor fixed, this loss is quadratic in the other. Its symmetric
    # finite difference is therefore its exact derivative for every nonzero h.
    # This path uses no TypeScript arithmetic or analytic gradient formula.
    h = Fraction(1, 97)

    def loss(first, second):
        return (first * second * x - target) ** 2 / 2

    grad_a = (loss(a + h, b) - loss(a - h, b)) / (2 * h)
    grad_b = (loss(a, b + h) - loss(a, b - h)) / (2 * h)
    return (a - rate * grad_a) * (b - rate * grad_b)


for batch in data["batches"]:
    seen = set()
    for group in ("teaching", "evaluation", "transfer"):
        for case in batch[group]:
            parameters = json.loads(case["observations"][0]["content"])
            expected = answer(parameters)
            counts["checked_cases"] += 1
            counts[parameters["operation"] + "_cases"] += 1
            counts[batch["source"] + "_cases"] += 1
            if str(expected) != case["expected"]:
                failures.append({"source": batch["source"], "seed": batch["seed"], "case": case["id"], "authored": case["expected"], "independent": str(expected)})
            else:
                counts["matching_keys"] += 1
            mutated = Fraction(case["expected"]) + 1
            if mutated != expected:
                counts["mutated_wrong_keys_rejected"] += 1
            else:
                failures.append({"case": case["id"], "error": "A mutated wrong key was accepted"})
            factors = sorted([Fraction(parameters["a"]), Fraction(parameters["b"])])
            identity = (parameters["operation"], *factors)
            if parameters["operation"] == "step":
                identity += tuple(Fraction(parameters[key]) for key in ("x", "target", "rate"))
            if identity in seen:
                failures.append({"seed": batch["seed"], "case": case["id"], "error": "Duplicate normalized input within batch"})
            seen.add(identity)

known = []
for a, b, expected in [("2", "3", "9/25"), ("6", "1", "-351/25")]:
    parameters = {"operation": "step", "a": a, "b": b, "x": "1", "target": "0", "rate": "1/10"}
    result = str(answer(parameters))
    known.append({"a": a, "b": b, "current_coefficient": str(Fraction(a) * Fraction(b)), "next_coefficient": result, "expected": expected, "passed": result == expected})
    if result != expected:
        failures.append({"known_counterexample": parameters, "result": result})

repo = Path(__file__).resolve().parents[2]
summary = {
    "version": 1,
    "evidence": "INDEPENDENT_OFFLINE_ORACLE_CHECK",
    "checked_at": datetime.now(timezone.utc).isoformat(),
    "status": "PASSED" if not failures else "FAILED",
    "generator_seeds": {"first": 1, "last": 128, "count": 128},
    "checked_in_fixture": "examples/school/factorized-step.json",
    "batches": len(data["batches"]),
    "counts": dict(counts),
    "method": "Python fractions.Fraction; exact symmetric finite differences of the loss separately in a and b, then simultaneous parameter updates. The loss is quadratic in each factor separately, so the finite difference has no approximation error.",
    "known_equal_product_counterexample": known,
    "failures": failures,
    "commands": [
        "node --import tsx docs/evidence/school-oracle-input.mjs /tmp/school-workbench-independent-cases.json",
        "python3 docs/evidence/school-oracle-check.py /tmp/school-workbench-independent-cases.json /tmp/school-workbench-independent-summary.json"
    ],
    "working_directory": "repository root",
    "input_sha256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
    "source_sha256": {str(relative): hashlib.sha256((repo / relative).read_bytes()).hexdigest() for relative in [Path("src/core/school-experiment.ts"), Path("examples/school/factorized-step.json")]},
    "checker_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    "limitations": [
        "Finite bounded seed/sample check, not an exhaustive proof over all rational parameters.",
        "The arithmetic checker is independent of TypeScript, but the checked generated inputs were emitted by the production TypeScript generator.",
        "The seed19 checked-in fixture is checked separately and overlaps the generated seed19 inventory.",
        "This verifies authored task keys and normalized input separation only; it measures no model capability, training, persistence, server artifact identity or pretraining novelty."
    ]
}
summary_path.write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({"status": summary["status"], "counts": summary["counts"], "known_counterexample": known, "summary": str(summary_path)}, indent=2))
if failures:
    raise SystemExit(1)
