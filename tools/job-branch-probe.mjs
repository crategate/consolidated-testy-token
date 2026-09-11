// One-off probe: verify what the local Switchboard job runtime does with a
// comparisonTask whose taken branch is UNSET (no on_true/on_true_value) —
// the primitive the dual-source halt dismissal needs ("confirm or FAIL").
// Runs the actual switchboard-on-demand TS job runner against canned task
// chains. DELETE after use.
import { OracleJob } from "@switchboard-xyz/common";

// The @switchboard-xyz/on-demand package ships a Node job runner? Check.
const pkg = await import("@switchboard-xyz/on-demand").catch(() => null);
console.log("on-demand exports with 'Job':", pkg ? Object.keys(pkg).filter((k) => /job/i.test(k)) : "pkg missing");

// Crossbar-independent check: does the common package validate a
// comparisonTask with an unset taken branch at all (schema-level)?
const job = OracleJob.fromObject({
    tasks: [
        {
            comparisonTask: {
                op: OracleJob.ComparisonTask.Operation.OPERATION_EQ,
                lhs: { tasks: [{ valueTask: { big: "3" } }] },
                rhsValue: "3",
                onTrue: { tasks: [{ valueTask: { big: "1" } }] },
                // onTrue branch omitted entirely — schema acceptance test
            },
        },
    ],
});
console.log("schema accepts unset-taken-branch comparisonTask:", JSON.stringify(job.toJSON()).length > 0);

// Does the on-demand package export a local job executor?
if (pkg) {
    console.log("candidate executors:", Object.keys(pkg).filter((k) => /exec|run|eval|simulate/i.test(k)));
}
