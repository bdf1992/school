"""Check retained parity reports with Python only; no School imports.

Usage: python school-parity-check.py GOOD_ARTIFACT GOOD_REPORT BAD_ARTIFACT
       BAD_REPORT NEW_SUMMARY
"""
import hashlib
import json
import sys
from pathlib import Path


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def evaluate(machine, bits):
    states = {state["id"]: state for state in machine["states"]}
    current = machine["initial"]
    for digit in bits:
        current = states[current]["transitions"][digit]
    return states[current]["output"], current


def oracle(bits):
    # The artifact never participates in this expectation.
    return "ODD" if int(bits or "0", 2).bit_count() % 2 else "EVEN"


def main():
    if len(sys.argv) != 6:
        raise SystemExit(__doc__)
    extra = ["", "0", "1", "00", "01", "10", "11", "000", "101", "111",
             "0" * 9, "1" + "0" * 8, "1" * 9, "10" * 8, "1" * 31, "1" * 32]
    expected_inputs = [("byte", format(value, "08b")) for value in range(256)]
    expected_inputs += [("additional", bits) for bits in extra]
    summaries = []
    checks = 0
    failures = []

    def check(condition, reason):
        nonlocal checks
        checks += 1
        if not condition:
            failures.append(reason)

    for control, artifact_path, report_path in [
        ("correct", sys.argv[1], sys.argv[2]),
        ("mutated", sys.argv[3], sys.argv[4]),
    ]:
        raw = Path(artifact_path).read_bytes()
        artifact = json.loads(raw)
        report = json.loads(Path(report_path).read_text(encoding="utf-8"))
        check(report["artifact"]["sha256"] == sha256(raw), f"{control}: raw identity")
        check(report["machine"] == artifact, f"{control}: reported artifact")
        definition = {"version": artifact["version"], "kind": artifact["kind"],
                      "alphabet": artifact["alphabet"], "initial": artifact["initial"],
                      "states": [{"id": state["id"], "output": state["output"],
                                  "transitions": {"0": state["transitions"]["0"], "1": state["transitions"]["1"]}}
                                 for state in artifact["states"]]}
        normalized = json.dumps(definition, separators=(",", ":"), ensure_ascii=False)
        check(report["artifact"]["normalizedSha256"] == sha256(normalized.encode()), f"{control}: normalized identity")
        check(report["artifact"]["bytes"] == len(raw) and report["artifact"]["bytesComplete"] is True, f"{control}: complete byte identity")
        check(report["version"] == 1 and report["kind"] == "school-parity-evaluation", f"{control}: report contract")
        check(report["evaluator"] == "parity-count-v1" and report["coverage"] == "SUFFICIENT", f"{control}: evaluator and coverage")
        check(report["validation"] == {"encoding": "VALID", "json": "VALID", "structure": "VALID"}, f"{control}: structural admission")
        check(report["additionalInputs"] == extra, f"{control}: declared supplement")
        result = report["evaluation"]
        check(result["evaluator"] == "parity-count-v1" and result["coverage"] == "SUFFICIENT", f"{control}: evaluation contract")
        rows = result["cases"]
        check([(row["group"], row["input"]) for row in rows] == expected_inputs, f"{control}: complete input domain")
        passed = {"byte": 0, "additional": 0}
        first_wrong = None
        for row in rows:
            actual, terminal = evaluate(artifact, row["input"])
            expected = oracle(row["input"])
            correct = actual == expected
            check(row["expected"] == expected, f"{control}: oracle {row['input']!r}")
            check((row["actual"], row["terminalState"]) == (actual, terminal), f"{control}: machine {row['input']!r}")
            check(row["correct"] == correct, f"{control}: grade {row['input']!r}")
            passed[row["group"]] += int(correct)
            if not correct and first_wrong is None:
                first_wrong = row
        check(result["counterexample"] == first_wrong, f"{control}: retained counterexample")
        check(result["bytes"] == {"checked": 256, "passed": passed["byte"], "failed": 256 - passed["byte"]}, f"{control}: byte totals")
        check(result["additional"] == {"checked": len(extra), "passed": passed["additional"], "failed": len(extra) - passed["additional"]}, f"{control}: supplement totals")
        check(report["status"] == result["status"] == ("PASSED" if first_wrong is None else "FAILED"), f"{control}: status")
        check(result["scope"] == "ALL_256_BYTES_AND_DECLARED_STRINGS" and result["equivalenceForAllStrings"] == "NOT_ESTABLISHED", f"{control}: evidence scope")
        check(report["modelGeneration"] == "NOT_ESTABLISHED", f"{control}: no model-generation claim")
        check(passed["byte"] == (256 if control == "correct" else 128), f"{control}: expected control signature")
        if control == "mutated":
            check(first_wrong is not None and first_wrong["input"] == "00000001", "mutated: expected concrete witness")
        summaries.append({"control": control, "artifactSha256": sha256(raw), "bytes": result["bytes"], "additional": result["additional"], "counterexample": first_wrong})

    summary = {"status": "PASSED" if not failures else "FAILED", "assertions": checks,
               "failures": failures, "reports": summaries,
               "method": "Independent Python transition interpreter and integer bit_count oracle over the complete declared domain; no School imports.",
               "modelInference": "NOT_PERFORMED", "allStringEquivalence": "NOT_ESTABLISHED"}
    with Path(sys.argv[5]).open("x", encoding="utf-8") as output:
        json.dump(summary, output, indent=2)
        output.write("\n")
    print(json.dumps(summary, indent=2))
    raise SystemExit(bool(failures))


if __name__ == "__main__":
    main()
