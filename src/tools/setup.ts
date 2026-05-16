import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, renderText } from "../lib/result";
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
      "Initialize Graphite in a repo or track an existing Git branch with an explicit Graphite parent. Use only when a repo/branch is not Graphite-ready. Tracking requires an explicit branch, explicit parent, and confirmParent:true.",
    promptSnippet:
      "graphite_setup: init_repo | track_branch for Graphite preconditions",
    promptGuidelines: [
      "Use graphite_setup only when graphite_status or another tool reports notInitialized or branchNotTracked.",
      "For track_branch, never infer the parent silently. Ask the user if the intended parent is unclear, then pass confirmParent:true.",
      "Do not use graphite_setup for untrack/freeze/unfreeze; those are outside the core workflow.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["init_repo", "track_branch"] as const),
      trunk: Type.Optional(
        Type.String({
          description: "action=init_repo: trunk branch name (for example main or master).",
        }),
      ),
      reset: Type.Optional(
        Type.Boolean({
          description:
            "action=init_repo: pass --reset and untrack existing Graphite branches. Requires confirmDestructive:true.",
        }),
      ),
      branch: Type.Optional(
        Type.String({ description: "action=track_branch: existing Git branch to track." }),
      ),
      parent: Type.Optional(
        Type.String({
          description:
            "action=track_branch: explicit Graphite parent branch. Required; do not guess if unclear.",
        }),
      ),
      confirmParent: Type.Optional(
        Type.Boolean({
          description:
            "action=track_branch: required true to confirm the supplied parent is intentional.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "action=track_branch: pass --force to overwrite existing tracking metadata. Requires confirmDestructive:true.",
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
      const f = await ensureSuccess(label, r, p.cwd);
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { action: p.action, result: f },
      };
    },
  });
}
