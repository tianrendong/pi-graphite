import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { ensureAllSuccess, renderText } from "../lib/result";
import { CwdParam, Type, type ToolReturn } from "../lib/schema";

/**
 * graphite_status — single read-only entry point.
 *
 * Always returns:
 *   gt log --stack    -> current stack tree
 *   gt info           -> current branch summary (parent, PR url, restack hint)
 *
 * Run this before touching the stack.
 */
export function registerStatus(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_status",
    label: "Graphite: status",
    description:
      "Read-only Graphite snapshot. Runs `gt log --stack` and `gt info` so you can see the current stack, the current branch's parent + PR, and any restack/conflict hints. Use this before any other graphite_* tool.",
    promptSnippet:
      "graphite_status: inspect current stack + current branch before mutating",
    promptGuidelines: [
      "Run graphite_status at the start of any Graphite workflow, and again whenever you are unsure where you are in the stack.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const [log, info] = await Promise.all([
        runGt(["log", "--stack"], { cwd: p.cwd, signal }),
        runGt(["info"], { cwd: p.cwd, signal }),
      ]);
      const [fl, fi] = await ensureAllSuccess(
        [
          { label: "gt log --stack", result: log },
          { label: "gt info", result: info },
        ],
        p.cwd,
      );
      return {
        content: [
          {
            type: "text",
            text: [
              renderText("gt log --stack", fl),
              renderText("gt info", fi),
            ].join("\n\n"),
          },
        ],
        details: { log: fl, info: fi },
      };
    },
  });
}
