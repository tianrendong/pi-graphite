import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import {
  ensureAllSuccess,
  ensureSuccess,
  renderText,
} from "../lib/result";
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
 *   7. On a successful apply, the resulting stack is shown (gt log --stack +
 *      gt info) so the new shape is visible without a second call.
 */
export function registerMove(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_move",
    label: "Graphite: move (reparent)",
    description:
      "Reparent an already-tracked branch onto a new parent and rebase it plus all descendants via `gt move --source <branch> --onto <parent>`. Defaults to a dry-run plan; pass apply:true with confirmDestructive:true to actually rebase. Unlike track_branch --force, this rewrites commits, not just tracking metadata.",
    promptSnippet:
      "graphite_move: reparent a tracked branch onto a new parent (`gt move --source --onto`)",
    promptGuidelines: [
      "Use graphite_move to reparent an existing tracked branch onto a different parent. It rebases the moved branch and all its descendants. Do NOT use graphite_setup track_branch --force for this — that only rewrites tracking metadata and leaves commits unrebased.",
      "Always call graphite_move with apply:false (default) first to review the dry-run plan, then call again with apply:true and confirmDestructive:true to actually rebase.",
      "Pass explicit branch and explicit parent. The wrapper never picks them interactively.",
      "If the move halts on a conflict, follow the hint and use graphite_recover action=continue (or abort).",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      branch: Type.String({
        description: "The already-tracked branch to reparent (gt move --source).",
      }),
      parent: Type.String({
        description: "The new parent branch to move `branch` onto (gt move --onto).",
      }),
      apply: Type.Optional(
        Type.Boolean({
          description:
            "false => dry-run plan only, no mutation (default). true => actually rebase (requires confirmDestructive).",
        }),
      ),
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

      // --- dry-run: show current stack + the planned operation, no mutation.
      if (!apply) {
        const log = await runGt(["log", "--stack"], { cwd: p.cwd, signal });
        const [fl] = await ensureAllSuccess(
          [{ label: "gt log --stack", result: log, requireStdout: true }],
          p.cwd,
        );
        const planned = `gt ${shellJoin([
          "move",
          flagEq("--source", branch),
          flagEq("--onto", parent),
        ])}`;
        const plan = [
          `[graphite_move] dry-run (no changes made)`,
          ``,
          `Planned: reparent ${branch} onto ${parent}.`,
          `This will rebase ${branch} and ALL of its descendants onto ${parent}.`,
          `Command that would run: ${planned}`,
          ``,
          `To apply: call graphite_move again with apply:true and confirmDestructive:true.`,
          `If it halts on a conflict, resolve files then graphite_recover action="continue".`,
          ``,
          `--- current stack ---`,
          renderText("gt log --stack", fl),
        ].join("\n");
        return {
          content: [{ type: "text", text: plan }],
          details: { apply: false, branch, parent, log: fl },
        };
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

      // Requirement 7: show the resulting stack after a successful move.
      const [log, info] = await Promise.all([
        runGt(["log", "--stack"], { cwd: p.cwd, signal }),
        runGt(["info"], { cwd: p.cwd, signal }),
      ]);
      const [fl, fi] = await ensureAllSuccess(
        [
          { label: "gt log --stack", result: log, requireStdout: true },
          { label: "gt info", result: info, requireStdout: true },
        ],
        p.cwd,
      );

      return {
        content: [
          {
            type: "text",
            text: [
              renderText(label, f),
              ``,
              `--- stack after move ---`,
              renderText("gt log --stack", fl),
              renderText("gt info", fi),
            ].join("\n"),
          },
        ],
        details: { apply: true, branch, parent, result: f, log: fl, info: fi },
      };
    },
  });
}
