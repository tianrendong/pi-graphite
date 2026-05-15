import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { ensureSuccess, renderText } from "../lib/result";
import { CwdParam, StringEnum, Type, type ToolReturn } from "../lib/schema";

export function registerRecovery(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_recovery",
    label: "Graphite: recovery",
    description:
      "Recover from conflicts or mistakes: continue a halted command, abort it, or undo the most recent Graphite mutation in this worktree.",
    promptSnippet:
      "graphite_recovery: continue / abort / undo Graphite commands",
    promptGuidelines: [
      "After resolving a rebase conflict, run graphite_recovery action=continue to resume the original gt command.",
      "graphite_recovery action=undo only undoes commands run from the current worktree.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["continue", "abort", "undo"] as const),
      stageAll: Type.Optional(
        Type.Boolean({ description: "action=continue: stage all changes first (--all)." }),
      ),
      force: Type.Optional(
        Type.Boolean({ description: "action=abort|undo: skip confirmation prompt (--force)." }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "continue":
          args = ["continue"];
          if (p.stageAll) args.push("--all");
          break;
        case "abort":
          args = ["abort"];
          if (p.force) args.push("--force");
          break;
        case "undo":
          args = ["undo"];
          if (p.force) args.push("--force");
          break;
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
