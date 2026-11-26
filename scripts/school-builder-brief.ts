import { canonicalJson } from "../src/core/builder/canonical.ts";
import { G0_FIXTURES } from "../src/core/builder/task.ts";
import { builderView } from "../src/core/builder/views.ts";

// The brief a builder receives for the v0 specimen: public law, interface, budgets and the
// teaching cases (H1, H2) with their expected lamps. Sealed and untaught fixtures are absent.
const teaching = G0_FIXTURES.filter((f) => f.name === "H1" || f.name === "H2");
console.log(canonicalJson(builderView({ teaching: [...teaching], sealed: [], budgets: { turns: 8 } })));
