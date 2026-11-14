import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, GRAPHITE_OUTPUT_SCHEMA, renderText, textResult } from "../lib/result";
import {
  CwdParam,
  StringEnum,
  Type,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_navigate — move around the current stack.
 *
 * Stacked PRs encode "which branch you are on = which PR you will modify",
 * so navigation is a core part of the workflow. Use this before
 * graphite_change to make sure you are on the right branch:
 *   - to update an existing PR, checkout that PR's branch
 *   - to add a child PR, navigate to its intended parent first
 *   - to add a base PR, navigate to trunk
 */
export function registerNavigate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_navigate",
    label: "Graphite: navigate",
    description:
      "Check out a branch, or move to trunk / up / down / top / bottom of the current stack.",
    promptSnippet: "graphite_navigate: move within the stack",
    promptGuidelines: [
      "To stack a new PR, graphite_navigate to its intended parent (or trunk) before graphite_change create.",
    ],
    outputSchema: GRAPHITE_OUTPUT_SCHEMA,
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum([
        "checkout",
        "trunk",
        "up",
        "down",
        "top",
        "bottom",
      ] as const),
      branch: Type.Optional(Type.String({ description: "checkout target." })),
      steps: Type.Optional(Type.Integer({ minimum: 1, description: "up/down count." })),
      to: Type.Optional(
        Type.String({ description: "up: child to take when there are several." }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "checkout":
          if (!p.branch) {
            throw new Error(
              "action=checkout requires `branch` (interactive selector disabled). Use action=trunk to jump to trunk.",
            );
          }
          args = ["checkout", assertSafeRef(p.branch, "branch")];
          break;
        case "trunk":
          args = ["checkout", "--trunk"];
          break;
        case "up":
          args = ["up"];
          if (p.steps != null) args.push(flagEq("--steps", p.steps));
          if (p.to) args.push(flagEq("--to", assertSafeRef(p.to, "to")));
          break;
        case "down":
          args = ["down"];
          if (p.steps != null) args.push(flagEq("--steps", p.steps));
          break;
        case "top":
          args = ["top"];
          break;
        case "bottom":
          args = ["bottom"];
          break;
      }
      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);
      return textResult((view) => renderText(label, f, view), { action: p.action, result: f });
    },
  });
}
