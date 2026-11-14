import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shellJoin } from "../lib/argv";
import { runGt } from "../lib/exec";
import { ensureSuccess, GRAPHITE_OUTPUT_SCHEMA, renderText, textResult } from "../lib/result";
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
      "`gt sync`: pull trunk, delete merged branches, restack. Run at session start and after PRs merge.",
    promptSnippet: "graphite_sync: pull trunk, clean merged branches, restack",
    outputSchema: GRAPHITE_OUTPUT_SCHEMA,
    parameters: Type.Object({
      cwd: CwdParam,
      restack: Type.Optional(Type.Boolean({ description: "Default true." })),
      allTrunks: Type.Optional(Type.Boolean()),
      deleteAll: Type.Optional(
        Type.Boolean({ description: "Delete merged/closed branches; needs confirmDestructive." }),
      ),
      force: Type.Optional(
        Type.Boolean({ description: "Overwrite local branches with remote; needs confirmDestructive." }),
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

      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd, { mutating: true });
      return textResult((view) => renderText(label, f, view), { result: f });
    },
  });
}
