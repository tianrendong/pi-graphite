import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, shellJoin } from "../lib/argv";
import { ensureSuccess, GRAPHITE_OUTPUT_SCHEMA, renderText, textResult } from "../lib/result";
import {
  CwdParam,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_get — `gt get <branch>`.
 *
 * Download a branch (and its descendants) from the Graphite remote and check
 * it out. Used to pull a teammate's stack, or to re-pull a branch after it
 * changed remotely. Distinct from graphite_sync, which operates on trunk +
 * already-tracked local branches.
 *
 * Because `gt get` can overwrite local commits with the remote version,
 * `force` requires `confirmDestructive:true`.
 */
export function registerGet(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_get",
    label: "Graphite: get",
    description:
      "`gt get <branch>`: download a branch and its descendants from remote and check it out (e.g. a teammate's stack).",
    promptSnippet: "graphite_get: pull a branch/stack from remote",
    outputSchema: GRAPHITE_OUTPUT_SCHEMA,
    parameters: Type.Object({
      cwd: CwdParam,
      branch: Type.String(),
      force: Type.Optional(
        Type.Boolean({ description: "Overwrite local state; needs confirmDestructive." }),
      ),
      confirmDestructive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      if (p.force) {
        requireConfirm(
          p.confirmDestructive,
          "gt get --force (may overwrite local commits with the remote version)",
        );
      }
      const args = ["get", assertSafeRef(p.branch, "branch")];
      if (p.force) args.push("--force");

      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd, { mutating: true });
      return textResult((view) => renderText(label, f, view), { result: f });
    },
  });
}
