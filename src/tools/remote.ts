import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { ensureSuccess, renderText } from "../lib/result";
import {
  CwdParam,
  StringEnum,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

export function registerRemoteSync(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_remote_sync",
    label: "Graphite: remote sync",
    description:
      "Sync local branches with remote: `gt sync` (pull trunk + restack + cleanup) or `gt get` (fetch a branch / PR locally).",
    promptSnippet:
      "graphite_remote_sync: `gt sync` for cleanup+restack, or `gt get` to import a branch/PR",
    promptGuidelines: [
      "Run graphite_remote_sync action=sync at the start of a session to update trunk and restack open stacks.",
      "graphite_remote_sync action=sync with force=true or deleteAll=true is destructive; pass confirmDestructive:true.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["sync", "get"] as const),

      // sync
      allTrunks: Type.Optional(Type.Boolean({ description: "sync: --all" })),
      deleteAll: Type.Optional(
        Type.Boolean({
          description:
            "sync|get: delete all merged/closed branches without prompting (--delete-all). Requires confirmDestructive.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description:
            "sync|get: overwrite local branches with remote (--force). Requires confirmDestructive.",
        }),
      ),
      restack: Type.Optional(
        Type.Boolean({
          description: "sync|get: restack after fetching (default true; pass false for --no-restack).",
        }),
      ),

      // get
      target: Type.Optional(
        Type.String({ description: "get: branch name or PR number to fetch." }),
      ),
      downstack: Type.Optional(
        Type.Boolean({ description: "get: --downstack (don't sync upstack)." }),
      ),
      remoteUpstack: Type.Optional(
        Type.Boolean({ description: "get: --remote-upstack (include remote-only upstack)." }),
      ),
      checkout: Type.Optional(
        Type.Boolean({ description: "get: check out target after sync (default true; false => --no-checkout)." }),
      ),
      unfrozen: Type.Optional(
        Type.Boolean({ description: "get: --unfrozen (new branches editable)." }),
      ),

      confirmDestructive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const args: string[] = [p.action];

      if (p.action === "sync") {
        if (p.force || p.deleteAll) {
          requireConfirm(
            p.confirmDestructive,
            "gt sync with --force/--delete-all (may overwrite branches)",
          );
        }
        if (p.allTrunks) args.push("--all");
        if (p.deleteAll) args.push("--delete-all");
        if (p.force) args.push("--force");
        if (p.restack === false) args.push("--no-restack");
      } else {
        if (!p.target) throw new Error("action=get requires `target` (branch name or PR number).");
        args.push(p.target);
        if (p.downstack) args.push("--downstack");
        if (p.remoteUpstack) args.push("--remote-upstack");
        if (p.force) {
          requireConfirm(p.confirmDestructive, "gt get --force (overwrites local branches)");
          args.push("--force");
        }
        if (p.deleteAll) {
          requireConfirm(p.confirmDestructive, "gt get --delete-all");
          args.push("--delete-all");
        }
        if (p.checkout === false) args.push("--no-checkout");
        if (p.restack === false) args.push("--no-restack");
        if (p.unfrozen) args.push("--unfrozen");
      }

      const label = `gt ${args.join(" ")}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { action: p.action, result: f },
      };
    },
  });
}
