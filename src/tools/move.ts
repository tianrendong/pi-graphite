import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, GRAPHITE_OUTPUT_SCHEMA, renderText, textResult, type OutputView } from "../lib/result";
import { buildTargetedStatus } from "./status";
import {
  CwdParam,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_move — `gt move --source <branch> --onto <parent>`.
 *
 * Reparent an existing, already-tracked branch onto a new parent and restack
 * the moved branch plus all of its descendants. This is the safe stack-surgery
 * primitive that was previously missing: track_branch --force only rewrites
 * tracking metadata, it does NOT rebase commits, so it leaves the stack in an
 * inconsistent shape. graphite_move performs a real rebase.
 *
 * Wrapper guarantees:
 *   1. Dry-run plan first (apply defaults to false; no mutation).
 *   2. Both `branch` and `parent` are explicit and required.
 *   3. Ambiguous / nonsensical moves are rejected up front (empty refs,
 *      flag-injection, branch == parent). gt rejects cycles itself.
 *   4. On apply, gt rebases the moved branch and all descendants.
 *   5. Conflicts surface as a failure with a conflictHalted hint, routing the
 *      agent to graphite_recover continue/abort.
 *   6. apply:true requires confirmDestructive:true.
 *   7. Dry-run/apply output shows targeted branch + parent status, with
 *      bounded topology snippets so cross-stack verification does not dump
 *      every tracked branch.
 */
export function registerMove(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_move",
    label: "Graphite: move (reparent)",
    description:
      "`gt move`: reparent a tracked branch onto a new parent, rebasing it and its descendants. Dry-run by default; apply:true requires confirmDestructive:true.",
    promptSnippet: "graphite_move: reparent a branch onto a new parent",
    promptGuidelines: [
      "Reparent with graphite_move, not graphite_setup track_branch force (which rewrites metadata without rebasing).",
    ],
    outputSchema: GRAPHITE_OUTPUT_SCHEMA,
    parameters: Type.Object({
      cwd: CwdParam,
      branch: Type.String(),
      parent: Type.String({ description: "New parent." }),
      apply: Type.Optional(Type.Boolean()),
      confirmDestructive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const branch = assertSafeRef(p.branch, "branch");
      const parent = assertSafeRef(p.parent, "parent");
      if (branch === parent) {
        throw new Error(
          `graphite_move: branch and parent are the same (${JSON.stringify(branch)}). ` +
            `A branch cannot be its own parent.`,
        );
      }

      const apply = p.apply === true;

      // --- dry-run: show targeted preflight + planned operation, no mutation.
      if (!apply) {
        const targeted = await buildTargetedStatus(
          p.cwd,
          [branch, parent],
          signal,
          { includeTopology: true },
        );
        const planned = `gt ${shellJoin([
          "move",
          flagEq("--source", branch),
          flagEq("--onto", parent),
        ])}`;
        const plan = (view: OutputView) => [
          `[graphite_move] dry-run (no changes made)`,
          ``,
          `Planned: reparent ${branch} onto ${parent}.`,
          `This will rebase ${branch} and ALL of its descendants onto ${parent}.`,
          `Command that would run: ${planned}`,
          ``,
          `Exact final topology is only known after apply; this dry-run shows targeted preflight context.`,
          `To apply: call graphite_move again with apply:true and confirmDestructive:true.`,
          `If it halts on a conflict, resolve files then graphite_recover action="continue".`,
          ``,
          `--- targeted preflight status ---`,
          targeted.render(view),
        ].join("\n");
        return textResult(plan, { apply: false, branch, parent, targeted: targeted.details });
      }

      // --- apply: real rebase. Destructive, so require confirmation.
      requireConfirm(
        p.confirmDestructive,
        `gt move --source ${branch} --onto ${parent} (rebases the branch and its descendants)`,
      );

      const args = [
        "move",
        flagEq("--source", branch),
        flagEq("--onto", parent),
      ];
      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd, { mutating: true });

      // Show targeted post-apply status without dumping every tracked branch.
      const targeted = await buildTargetedStatus(
        p.cwd,
        [branch, parent],
        signal,
        { includeTopology: true },
      );

      return textResult(
        (view) =>
          [renderText(label, f, view), ``, `--- targeted status after move ---`, targeted.render(view)].join("\n"),
        { apply: true, branch, parent, result: f, targeted: targeted.details },
      );
    },
  });
}
