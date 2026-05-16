import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, renderText } from "../lib/result";
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
      "Move around the current Graphite stack: checkout a specific branch, jump to trunk, or step up/down/top/bottom. Use this before graphite_change so you are mutating the right PR.",
    promptSnippet:
      "graphite_navigate: checkout / trunk / up / down / top / bottom in the current stack",
    promptGuidelines: [
      "Before any graphite_change, confirm you are on the intended branch via graphite_status or graphite_navigate.",
      "To create a child PR, navigate to its intended parent first. To create a base PR, navigate to trunk.",
    ],
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
      branch: Type.Optional(
        Type.String({ description: "action=checkout: branch to checkout." }),
      ),
      steps: Type.Optional(
        Type.Integer({
          minimum: 1,
          description: "action=up|down: step count.",
        }),
      ),
      to: Type.Optional(
        Type.String({
          description:
            "action=up: target descendant when the current branch has multiple children (--to).",
        }),
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
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { action: p.action, result: f },
      };
    },
  });
}
