import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { ensureSuccess, renderText } from "../lib/result";
import {
  CwdParam,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_sync — the "start of day / after merge" workflow.
 *
 * Wraps `gt sync` only. Pulls trunk, deletes merged branches, restacks
 * remaining branches. This is the canonical way to recover from merged PRs.
 *
 * Prefer this over manual restack when trunk may have moved or when PRs in
 * the stack may have merged.
 */
export function registerSync(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_sync",
    label: "Graphite: sync",
    description:
      "Pull trunk, delete merged branches, and restack remaining branches via `gt sync`. Run at session start and after any PR in the stack merges. Destructive flags (`force`, `deleteAll`) require `confirmDestructive`.",
    promptSnippet:
      "graphite_sync: `gt sync` — start-of-day + after-merge cleanup and restack",
    promptGuidelines: [
      "Run graphite_sync at the start of a session and any time PRs in the stack may have merged.",
      "graphite_sync with force=true or deleteAll=true is destructive; pass confirmDestructive:true.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      restack: Type.Optional(
        Type.Boolean({
          description:
            "Restack after fetching (default true; pass false for --no-restack).",
        }),
      ),
      allTrunks: Type.Optional(
        Type.Boolean({ description: "Sync all configured trunks (--all)." }),
      ),
      deleteAll: Type.Optional(
        Type.Boolean({
          description:
            "Delete all merged/closed branches without prompting (--delete-all). Requires confirmDestructive.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite local branches with remote (--force). Requires confirmDestructive.",
        }),
      ),
      confirmDestructive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      if (p.force || p.deleteAll) {
        requireConfirm(
          p.confirmDestructive,
          "gt sync with --force/--delete-all (may overwrite branches)",
        );
      }
      const args = ["sync"];
      if (p.allTrunks) args.push("--all");
      if (p.deleteAll) args.push("--delete-all");
      if (p.force) args.push("--force");
      if (p.restack === false) args.push("--no-restack");

      const label = `gt ${args.join(" ")}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { result: f },
      };
    },
  });
}
