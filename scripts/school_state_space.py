"""Owner-side SPACE adapter. Learner proposals are data, never Python code."""
import hashlib
import json
from pathlib import Path
import sys
from contextlib import closing

from school_space_check import (
    algebra_table, check_artifact, lookup, normalized_address,
)


CONTEXTS = ("/contexts/root", "/contexts/commuting")


def expression(op, *args):
    return {"op": op, "args": list(args)}


X, Y = {"input": "x"}, {"input": "y"}
BASELINE = expression("add", expression("multiply", X, X),
                      expression("scale", {"literal": 2}, expression("multiply", X, Y)),
                      expression("multiply", Y, Y))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def fingerprint(root):
    return {name: digest((root / name).read_bytes()) for name in
            ("algebra.py", "checker.py", "runtime.py", "schema.sql", "state_database.py")}


def member(db, snapshot, address):
    if not normalized_address(address):
        raise ValueError("Expected a normalized logical address")
    row = db.db.execute(
        "SELECT record FROM school_members WHERE snapshot = ? AND address = ?",
        (snapshot, address),
    ).fetchone()
    if row is None:
        raise ValueError(f"No member at {address} in snapshot {snapshot}")
    return {"snapshot": snapshot, "address": address, "record": json.loads(row[0])}


def arguments(db, space, context, x, y, put=None):
    put = put or db.put
    return [{"name": name, "state_ref": put("state", {
        "space_ref": space, "context_ref": context, "coordinates": value,
    })} for name, value in (("x", x), ("y", y))]


def expected(table, x, y):
    # Compute the expected value directly from the source table, independently
    # of Foundation's expression interpreter and algebra implementation.
    from fractions import Fraction
    summed = [Fraction(a) + Fraction(b) for a, b in zip(x, y)]
    return [str(sum(table[i][j][k] * summed[i] * summed[j]
                    for i in range(4) for j in range(4))) for k in range(4)]


def initialize(db, filename, profile, language):
    source = filename.read_bytes()
    from state_database import loads
    artifact = loads(source.decode("utf-8"))
    check_artifact(artifact)
    snapshot = artifact["integrity"]["digest"]
    existing = db.db.execute("SELECT source, manifest FROM school_world").fetchone()
    if existing:
        manifest = json.loads(existing[1])
        if source != existing[0] or profile != manifest["foundation"]:
            raise ValueError("Workspace already pins a different SPACE source or Foundation runtime")
        return manifest
    records = artifact["records"]
    algebras, contexts, tables = {}, {}, {}

    def put(kind, payload):
        identity = digest(encode([snapshot, kind, payload]).encode("utf-8"))
        return db.put(kind, payload, "school-seed:" + identity)

    with db.db:
        for address in CONTEXTS:
            algebra = lookup("algebra", address, records)
            body = records[algebra]["body"]
            table = algebra_table(algebra, records)
            tables[address] = table
            algebras[algebra] = put("algebra", {
                "name": body["name"], "basis": body["basis"],
                "products": [[[str(v) for v in cell] for cell in row] for row in table],
            })
            context = {"algebra_ref": algebras[algebra]}
            if contexts:
                context["parent_ref"] = contexts[CONTEXTS[0]]
            contexts[address] = put("context", context)
        space = put("space", {"name": "Exact rational operation coordinates", "axes": [
            {"name": name, "domain": {"kind": "continuous"}} for name in ("1", "i", "j", "k")
        ]})
        contract = put("contract", {"name": "square_of_sum", "language": language,
                          "inputs": [{"name": name, "space_ref": space} for name in ("x", "y")],
                          "output_space_ref": space, "parameters": []})
        baseline = put("operation", {"name": "square_of_sum", "contract_ref": contract, "body": BASELINE})
        cases = []
        inputs = (
            ("basis", [0, 1, 0, 0], [0, 0, 1, 0]),
            ("retention", [1, 0, 0, 0], [0, 1, 0, 0]),
            ("zero-divisors", [1, 0, 0, 1], [1, 0, 0, -1]),
            ("fresh-rationals", ["1/2", -2, 0, 1], [0, "2/3", 1, -1]),
            ("zero", [0, 0, 0, 0], [0, 0, 0, 0]),
        )
        for address, context in contexts.items():
            for name, x, y in inputs:
                cases.append({"name": f"{address}/{name}", "context_ref": context,
                              "arguments": arguments(db, space, context, x, y, put),
                              "expected": {"status": "computed", "value": expected(tables[address], x, y)}})
        suite = put("suite", {"name": "Square of sum fixed cases", "contract_ref": contract, "cases": cases})
        slot = put("slot", {"name": "square_of_sum", "contract_ref": contract, "suite_ref": suite})
        binding = put("binding", {"slot_ref": slot, "operation_ref": baseline})
        manifest = {"snapshot": snapshot, "sourceSha256": digest(source), "entry": artifact["entry"],
                    "foundation": profile, "contexts": contexts, "algebras": algebras, "space": space,
                    "contract": contract, "slot": slot, "initialBinding": binding}
        # Foundation commits each content-addressed record. Publish the School
        # index atomically after the idempotent seed writes have finished.
        db.db.execute("BEGIN IMMEDIATE")
        previous = db.db.execute("SELECT source, manifest FROM school_world").fetchone()
        if previous:
            if previous[0] != source or json.loads(previous[1]) != manifest:
                raise ValueError("A different SPACE world was initialized concurrently")
            return manifest
        db.db.execute("INSERT INTO school_world VALUES (1, ?, ?)", (source, encode(manifest)))
        db.db.executemany("INSERT INTO school_members VALUES (?, ?, ?)",
                          ((snapshot, address, encode(record)) for address, record in records.items()))
    return manifest


def dispatch(db, rt, world, request):
    action = request["action"]
    slot = world["slot"]
    if action == "resolve":
        return member(db, request["snapshot"], request["address"])
    if action == "history":
        return db.get(request["ref"])
    if action == "inspect":
        binding = rt.head(slot)
        operation = db.payload(db.payload(binding)["operation_ref"])
        return {"snapshot": world["snapshot"], "slot": slot, "binding": binding,
                "operation": operation, "contract": db.payload(world["contract"])}
    if action == "invoke":
        from state_database import cid
        context = world["contexts"][request["context"]]
        args = arguments(db, world["space"], context, request["x"], request["y"])
        invocation = rt.invocation_payload(slot, args, context)
        if invocation["binding_ref"] != request["binding"]:
            raise ValueError("Slot changed since inspection; inspect the current binding and retry")
        ref = db.put("invocation", invocation, "invocation:" + cid(invocation))
        return rt.run(ref, retain=True)
    if action == "propose":
        if db.payload(request["binding"], ("binding",))["slot_ref"] != slot:
            raise ValueError("Proposal is for a different slot")
        candidate = db.put("operation", {"name": "square_of_sum", "contract_ref": world["contract"],
                                         "body": request["body"]})
        proposal = db.put("proposal", {"binding_ref": request["binding"], "candidate_ref": candidate,
                                       "reason": "School square_of_sum episode " + request["episode"],
                                       "proposed_by": request["actor"]})
        return rt.assess(proposal)
    if action == "adopt":
        assessment = db.payload(request["assessment"], ("assessment",))
        proposal = db.payload(assessment["proposal_ref"], ("proposal",))
        if db.payload(proposal["binding_ref"], ("binding",))["slot_ref"] != slot:
            raise ValueError("Assessment is for a different slot")
        return {"binding": rt.adopt(request["assessment"], request["binding"])}
    raise ValueError("Unknown action")


def main():
    root, database, source = map(Path, sys.argv[1:])
    sys.path.insert(0, str(root))
    from state_database import Database, loads
    from runtime import Runtime, LANGUAGE

    data = sys.stdin.buffer.read(300_001)
    if len(data) > 300_000:
        raise ValueError("School adapter request exceeds 300000 bytes")
    request = loads(data.decode("utf-8"))
    if not isinstance(request, dict):
        raise ValueError("Expected a School action object")
    profile = fingerprint(root)
    if request.get("action") != "init" and not database.is_file():
        raise ValueError("Initialize the SPACE workspace first")
    with closing(Database(database)) as db:
        db.db.executescript("""
            CREATE TABLE IF NOT EXISTS school_world (
                singleton INTEGER PRIMARY KEY CHECK (singleton = 1), source BLOB NOT NULL, manifest TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS school_members (
                snapshot TEXT NOT NULL, address TEXT NOT NULL, record TEXT NOT NULL,
                PRIMARY KEY (snapshot, address)
            );
        """)
        if request["action"] == "init":
            result = initialize(db, source, profile, LANGUAGE)
        else:
            row = db.db.execute("SELECT manifest FROM school_world").fetchone()
            if row is None:
                raise ValueError("Initialize the SPACE workspace first")
            world = json.loads(row[0])
            if world["foundation"] != profile:
                raise ValueError("Foundation runtime differs from the pinned runtime")
            if request["action"].startswith("learn-"):
                from school_space_learning import dispatch_learning
                result = dispatch_learning(db, Runtime(db), world, request)
            else:
                result = dispatch(db, Runtime(db), world, request)
        print(encode(result))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        sys.exit(str(error))
