import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, shellJoin } from "../lib/argv";
import { ensureSuccess, renderText } from "../lib/result";
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
      "Download a branch and its descendants from the Graphite remote and check it out via `gt get <branch>`. Use to pull a teammate's stack or re-pull a branch that changed remotely. `force` (overwrite local) requires confirmDestructive.",
    promptSnippet:
      "graphite_get: `gt get <branch>` — pull a branch/stack from remote",
    promptGuidelines: [
      "Use graphite_get to pull a branch (and its descendants) from the remote. graphite_sync only handles trunk + already-tracked local branches.",
      "graphite_get with force=true may overwrite local commits; pass confirmDestructive:true.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      branch: Type.String({
        description: "Branch to download from the Graphite remote and check out.",
      }),
      force: Type.Optional(
        Type.Boolean({
          description:
            "Overwrite local branch state with remote (--force). Requires confirmDestructive.",
        }),
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
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { result: f },
      };
    },
  });
}
