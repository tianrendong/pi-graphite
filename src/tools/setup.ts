import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, GRAPHITE_OUTPUT_SCHEMA, renderText, textResult } from "../lib/result";
import {
  CwdParam,
  StringEnum,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_setup — initialize a repo or adopt an existing git branch into
 * Graphite tracking.
 *
 * This is a precondition tool, not a daily workflow tool. Use it only when
 * graphite_status / graphite_change reports that Graphite is not initialized
 * or the current branch is not tracked.
 */
export function registerSetup(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_setup",
    label: "Graphite: setup",
    description:
      "Initialize Graphite (init_repo) or track an existing branch onto an explicit parent (track_branch). Use only when a tool reports notInitialized or branchNotTracked.",
    promptSnippet: "graphite_setup: init_repo | track_branch",
    promptGuidelines: [
      "For graphite_setup track_branch, never guess the parent; ask the user if unclear.",
    ],
    outputSchema: GRAPHITE_OUTPUT_SCHEMA,
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["init_repo", "track_branch"] as const),
      trunk: Type.Optional(Type.String({ description: "init_repo: trunk branch." })),
      reset: Type.Optional(
        Type.Boolean({ description: "init_repo: untrack all branches; needs confirmDestructive." }),
      ),
      branch: Type.Optional(Type.String({ description: "track_branch: branch to track." })),
      parent: Type.Optional(Type.String({ description: "track_branch: its parent." })),
      confirmParent: Type.Optional(
        Type.Boolean({ description: "track_branch: must be true." }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "track_branch: overwrite existing tracking; needs confirmDestructive.",
        }),
      ),
      confirmDestructive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];

      if (p.action === "init_repo") {
        if (!p.trunk) {
          throw new Error("graphite_setup action=init_repo requires `trunk`.");
        }
        if (p.reset) {
          requireConfirm(
            p.confirmDestructive,
            "gt init --reset (untracks existing Graphite branches)",
          );
        }
        args = ["init", flagEq("--trunk", assertSafeRef(p.trunk, "trunk"))];
        if (p.reset) args.push("--reset");
      } else {
        if (!p.branch) {
          throw new Error("graphite_setup action=track_branch requires `branch`.");
        }
        if (!p.parent) {
          throw new Error("graphite_setup action=track_branch requires `parent`.");
        }
        if (p.confirmParent !== true) {
          throw new Error(
            "graphite_setup action=track_branch requires confirmParent:true. Confirm the intended Graphite parent with the user if unclear.",
          );
        }
        if (p.force) {
          requireConfirm(
            p.confirmDestructive,
            "gt track --force (overwrites existing tracking metadata)",
          );
        }
        args = [
          "track",
          assertSafeRef(p.branch, "branch"),
          flagEq("--parent", assertSafeRef(p.parent, "parent")),
        ];
        if (p.force) args.push("--force");
      }

      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd, { mutating: true });
      return textResult((view) => renderText(label, f, view), { action: p.action, result: f });
    },
  });
}
