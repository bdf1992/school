"""Resumable episodes over the existing SPACE and Foundation records."""
from fractions import Fraction
import json


TASKS = {
    "square-of-sum": "Return the square of the sum of the two vectors using the selected algebra.",
    "ordered-difference": "Return the difference between multiplying x by y and multiplying y by x, in that order, using the selected algebra.",
}
CONTEXTS = ("/contexts/root", "/contexts/commuting")
PROBE = {"context": CONTEXTS[0], "x": [0, 2, 0, 0], "y": [0, 0, 1, 0]}
REOPEN = {"context": CONTEXTS[0], "x": [1, -1, 2, 0], "y": ["1/3", 1, -1, 1]}
CASES = (
    ("basis-order", [0, 0, 1, 0], [0, 0, 0, 1]),
    ("scalar-retention", [2, 0, 0, 0], [0, 1, 0, 0]),
    ("zero-divisors", [1, 0, 0, 1], [1, 0, 0, -1]),
    ("mixed-rationals", ["1/3", -1, 2, 0], [0, "2/5", -1, 2]),
    ("zero", [0, 0, 0, 0], [0, 0, 0, 0]),
)


def encode(data):
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def exact_product(table, left, right):
    return [sum(Fraction(left[i]) * Fraction(right[j]) * Fraction(table[i][j][k])
                for i in range(4) for j in range(4)) for k in range(4)]


def oracle(task, table, x, y):
    if task == "square-of-sum":
        added = [Fraction(a) + Fraction(b) for a, b in zip(x, y)]
        return exact_product(table, added, added)
    return [a - b for a, b in zip(exact_product(table, x, y), exact_product(table, y, x))]


def validate_learner_body(body, depth=0):
    if depth > 32 or not isinstance(body, dict):
        raise ValueError("Unknown expression form or expression too deep")
    if set(body) in ({"input"}, {"literal"}):
        return
    if (set(body) != {"op", "args"} or body["op"] not in ("add", "subtract", "scale", "negate", "multiply")
            or not isinstance(body["args"], list)):
        raise ValueError("Unknown expression form in learner body")
    for item in body["args"]:
        validate_learner_body(item, depth + 1)


def store(db, kind, value):
    from state_database import cid
    return db.put(kind, value, "school-learning:" + cid([kind, value]))


def initialize_task(db, world, task):
    if task not in TASKS:
        raise ValueError("Unknown learning task")
    from school_state_space import BASELINE, expression, X, Y, arguments
    from school_space_check import algebra_table, lookup
    source = json.loads(db.db.execute("SELECT source FROM school_world WHERE singleton = 1").fetchone()[0])["records"]
    product = expression("multiply", X, Y)
    body = BASELINE if task == "square-of-sum" else expression("subtract", product, product)
    baseline = store(db, "operation", {"name": task, "contract_ref": world["contract"], "body": body})
    cases = []
    for address in CONTEXTS:
        context = world["contexts"][address]
        table = algebra_table(lookup("algebra", address, source), source)
        for label, x, y in CASES:
            cases.append({"name": address + "/" + label, "context_ref": context,
                          "arguments": arguments(db, world["space"], context, x, y, lambda k, p: store(db, k, p)),
                          "expected": {"status": "computed", "value": [str(v) for v in oracle(task, table, x, y)]}})
    suite = store(db, "suite", {"name": task + " evaluation v1", "contract_ref": world["contract"], "cases": cases})
    slot = store(db, "slot", {"name": task, "contract_ref": world["contract"], "suite_ref": suite})
    store(db, "binding", {"slot_ref": slot, "operation_ref": baseline})
    return slot


def invoke(db, rt, world, slot, binding, item):
    from school_state_space import arguments
    from state_database import cid
    context = world["contexts"][item["context"]]
    args = arguments(db, world["space"], context, item["x"], item["y"], lambda k, p: store(db, k, p))
    payload = rt.invocation_payload(slot, args, context)
    if payload["binding_ref"] != binding:
        raise ValueError("Slot changed before invocation")
    ref = db.put("invocation", payload, "invocation:" + cid(payload))
    return rt.run(ref, retain=True)


def episode_view(db, world, task, binding, probe):
    from school_state_space import member
    from school_space_check import algebra_table, lookup
    from state_database import cid
    source = json.loads(db.db.execute("SELECT source FROM school_world WHERE singleton = 1").fetchone()[0])["records"]
    table = algebra_table(lookup("algebra", PROBE["context"], source), source)
    target = [str(value) for value in oracle(task, table, PROBE["x"], PROBE["y"])]
    entry = "/school/tasks/" + task
    records = {entry: {"purpose": TASKS[task], "operation": entry + "/operation",
                       "protocol": entry + "/protocol", "probe": entry + "/probe"},
               entry + "/operation": db.payload(db.payload(binding)["operation_ref"]),
               entry + "/protocol": {"continue": "Use the retained baseline observation and propose one replacement expression body.",
                                      "source": {"snapshot": world["snapshot"], "address": "/protocol/enter"},
                                      "language": "Expressions are JSON objects with input, literal, or op and args. Operators include add, subtract, scale, negate and multiply."},
               entry + "/probe": {"input": PROBE, "observed": probe["value"], "target": target}}
    snapshot = cid({"entry": entry, "records": records})
    addresses = ["/space", "/protocol/enter", "/contexts/root", "/contexts/commuting",
                 "/algebras/hamilton", "/algebras/bicomplex"]
    return {"snapshot": snapshot, "entry": entry, "records": records,
            "sourceRecords": [member(db, world["snapshot"], address) for address in addresses]}


def dispatch_learning(db, rt, world, request):
    action, episode = request["action"], request["episode"]
    db.db.executescript("""
        CREATE TABLE IF NOT EXISTS school_learning_episode (
            id TEXT PRIMARY KEY, prepared TEXT NOT NULL, submission TEXT, assessed TEXT
        );
        CREATE TABLE IF NOT EXISTS school_learning_attempt (
            episode TEXT NOT NULL, id TEXT NOT NULL, request TEXT NOT NULL, terminal TEXT,
            PRIMARY KEY (episode, id)
        );
        CREATE TABLE IF NOT EXISTS school_learning_rejection (
            episode TEXT NOT NULL, submission TEXT NOT NULL, reason TEXT NOT NULL,
            PRIMARY KEY (episode, submission)
        );
    """)
    row = db.db.execute("SELECT * FROM school_learning_episode WHERE id = ?", (episode,)).fetchone()
    if action == "learn-prepare":
        identity = request["identity"]
        if row:
            prior = json.loads(row["prepared"])
            if prior["identity"] != identity:
                raise ValueError("Conflicting episode identity")
            return prior
        slot = initialize_task(db, world, identity["task"])
        binding = rt.head(slot)
        probe = invoke(db, rt, world, slot, binding, PROBE)
        prepared = {"identity": identity, "slot": slot, "binding": binding,
                    "suite": db.payload(slot)["suite_ref"], "runtime": world["foundation"], "probe": probe,
                    "view": episode_view(db, world, identity["task"], binding, probe)}
        with db.db:
            db.db.execute("INSERT OR IGNORE INTO school_learning_episode (id, prepared) VALUES (?, ?)", (episode, encode(prepared)))
        return dispatch_learning(db, rt, world, request)
    if row is None:
        raise ValueError("Prepare the learning episode first")
    prepared = json.loads(row["prepared"])
    if action == "learn-view":
        return prepared["view"]
    if action == "learn-resolve":
        view = prepared["view"]
        snapshot, address = request["snapshot"], request["address"]
        if snapshot == view["snapshot"] and address in view["records"]:
            return {"snapshot": snapshot, "address": address, "record": view["records"][address]}
        for record in view["sourceRecords"]:
            if record["snapshot"] == snapshot and record["address"] == address:
                return record
        raise ValueError("Address is outside the admitted learner view")
    if action == "learn-status":
        attempts = db.db.execute("SELECT id, request, terminal FROM school_learning_attempt WHERE episode = ? ORDER BY rowid", (episode,))
        rejections = db.db.execute("SELECT submission, reason FROM school_learning_rejection WHERE episode = ? ORDER BY rowid", (episode,))
        return {"prepared": prepared, "assessment": json.loads(row["assessed"]) if row["assessed"] else None,
                "attempts": [{"id": a[0], "request": json.loads(a[1]), "terminal": json.loads(a[2]) if a[2] else None}
                             for a in attempts],
                "rejections": [{"submission": json.loads(r[0]), "reason": r[1]} for r in rejections]}
    if action == "learn-claim":
        with db.db:
            inserted = db.db.execute("""
                INSERT OR IGNORE INTO school_learning_attempt (episode, id, request)
                SELECT ?, ?, ? FROM school_learning_episode WHERE id = ? AND submission IS NULL
            """, (episode, request["attempt"], encode(request["modelRequest"]), episode))
            if inserted.rowcount != 1:
                raise ValueError("Attempt identity already claimed or episode submission already started")
        return {"claimed": True}
    if action == "learn-terminal":
        with db.db:
            update = db.db.execute("UPDATE school_learning_attempt SET terminal = ? WHERE episode = ? AND id = ? AND terminal IS NULL",
                                   (encode(request["terminal"]), episode, request["attempt"]))
            if update.rowcount != 1:
                raise ValueError("No unresolved attempt with that identity")
        return {"recorded": True}
    if action == "learn-submit":
        body = request["body"]
        source = request.get("attempt")
        if source:
            attempt = db.db.execute("SELECT terminal FROM school_learning_attempt WHERE episode = ? AND id = ?", (episode, source)).fetchone()
            if not attempt or not attempt[0]:
                raise ValueError("Attempt has no retained terminal reply")
            terminal = json.loads(attempt[0])
            if "body" not in terminal or terminal["body"] != body:
                raise ValueError("Proposal differs from the retained model candidate")
        submission = encode({"body": body, "attempt": source})
        if row["submission"] and row["submission"] != submission:
            raise ValueError("Conflicting episode submission")
        if row["assessed"]:
            return json.loads(row["assessed"])
        # Validate before claiming so an invalid candidate is recorded by the caller
        # without making the prepared episode unusable.
        task = prepared["identity"]["task"]
        try:
            validate_learner_body(body)
            rt.inspect_expression(body, world["contract"])
        except (TypeError, ValueError) as error:
            with db.db:
                db.db.execute("INSERT OR IGNORE INTO school_learning_rejection VALUES (?, ?, ?)",
                              (episode, submission, str(error)))
            raise
        with db.db:
            db.db.execute("UPDATE school_learning_episode SET submission = ? WHERE id = ? AND submission IS NULL",
                          (submission, episode))
        current = db.db.execute("SELECT submission, assessed FROM school_learning_episode WHERE id = ?", (episode,)).fetchone()
        if current[0] != submission:
            raise ValueError("Conflicting episode submission")
        if current[1]:
            return json.loads(current[1])
        candidate = store(db, "operation", {"name": task, "contract_ref": world["contract"], "body": body})
        proposal = store(db, "proposal", {"binding_ref": prepared["binding"], "candidate_ref": candidate,
                         "reason": "School learning episode " + episode, "proposed_by": prepared["identity"]["learner"]})
        assessment = rt.assess(proposal)
        result = {"assessment": assessment, "expectedBinding": prepared["binding"], "slot": prepared["slot"]}
        with db.db:
            db.db.execute("UPDATE school_learning_episode SET assessed = ? WHERE id = ?", (encode(result), episode))
        return result
    if action == "learn-adopt":
        if not row["assessed"]:
            raise ValueError("Assess the episode before adoption")
        result = json.loads(row["assessed"])
        if request["assessment"] != result["assessment"]["assessment_ref"]:
            raise ValueError("Select the exact retained assessment")
        head = rt.head(prepared["slot"])
        current = db.payload(head, ("binding",))
        if current.get("assessment_ref") == request["assessment"] and current.get("previous_ref") == prepared["binding"]:
            return {"binding": head}
        return {"binding": rt.adopt(request["assessment"], prepared["binding"])}
    if action == "learn-use":
        slot = prepared["slot"]
        binding = rt.head(slot)
        context = request.get("context", REOPEN["context"])
        return {"slot": slot, "binding": binding, "invocation": invoke(db, rt, world, slot, binding, {**REOPEN, "context": context})}
    raise ValueError("Unknown learning action")
