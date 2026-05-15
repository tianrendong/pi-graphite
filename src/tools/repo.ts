import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { ensureAllSuccess, ensureSuccess, renderText } from "../lib/result";
import { CwdParam, StringEnum, Type, type ToolReturn } from "../lib/schema";

const params = Type.Object({
  cwd: CwdParam,
  action: StringEnum(["status", "init", "set_trunk", "show_config"] as const),
  trunk: Type.Optional(
    Type.String({
      description:
        "Trunk branch name. Required for action=set_trunk. Optional for action=init (otherwise gt prompts).",
    }),
  ),
  addAdditionalTrunk: Type.Optional(
    Type.Boolean({
      description:
        "If true with action=set_trunk, add an additional trunk via `gt trunk --add` instead of replacing.",
    }),
  ),
  reset: Type.Optional(
    Type.Boolean({
      description: "If true with action=init, untrack all branches (gt init --reset).",
    }),
  ),
});

export function registerRepo(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_repo",
    label: "Graphite: repo",
    description:
      "Repo-level Graphite operations: status snapshot (log + trunk), init, set/add trunk, and show config.",
    promptSnippet:
      "graphite_repo: inspect repo state, initialize Graphite, configure trunk(s)",
    parameters: params,
    async execute(_id, p, signal): Promise<ToolReturn> {
      const cwd = p.cwd;

      if (p.action === "status") {
        const [trunk, log] = await Promise.all([
          runGt(["trunk"], { cwd, signal }),
          runGt(["log", "short"], { cwd, signal }),
        ]);
        const [ft, fl] = await ensureAllSuccess(
          [
            { label: "gt trunk", result: trunk },
            { label: "gt log short", result: log },
          ],
          cwd,
        );
        return {
          content: [
            {
              type: "text",
              text: [renderText("gt trunk", ft), renderText("gt log short", fl)].join("\n\n"),
            },
          ],
          details: { trunk: ft, log: fl },
        };
      }

      if (p.action === "init") {
        const args = ["init"];
        if (p.trunk) args.push("--trunk", p.trunk);
        if (p.reset) args.push("--reset");
        const r = await runGt(args, { cwd, signal });
        const f = await ensureSuccess(`gt ${args.join(" ")}`, r, cwd);
        return {
          content: [{ type: "text", text: renderText(`gt ${args.join(" ")}`, f) }],
          details: { result: f },
        };
      }

      if (p.action === "set_trunk") {
        if (!p.trunk) throw new Error("action=set_trunk requires `trunk`.");
        if (!p.addAdditionalTrunk) {
          const args = ["init", "--trunk", p.trunk];
          const r = await runGt(args, { cwd, signal });
          const f = await ensureSuccess(`gt ${args.join(" ")}`, r, cwd);
          return {
            content: [
              { type: "text", text: renderText(`gt ${args.join(" ")}`, f) },
            ],
            details: { result: f },
          };
        }
        // `gt trunk --add` is interactive (prompts for the new trunk name).
        // With --no-interactive this will fail; surface that failure rather
        // than silently misleading the caller.
        const r = await runGt(["trunk", "--add"], { cwd, signal });
        const f = await ensureSuccess("gt trunk --add", r, cwd);
        return {
          content: [{ type: "text", text: renderText("gt trunk --add", f) }],
          details: { result: f },
        };
      }

      // show_config
      const [trunk, trunkAll] = await Promise.all([
        runGt(["trunk"], { cwd, signal }),
        runGt(["trunk", "--all"], { cwd, signal }),
      ]);
      const [ft, fta] = await ensureAllSuccess(
        [
          { label: "gt trunk", result: trunk },
          { label: "gt trunk --all", result: trunkAll },
        ],
        cwd,
      );
      return {
        content: [
          {
            type: "text",
            text: [renderText("gt trunk", ft), renderText("gt trunk --all", fta)].join("\n\n"),
          },
        ],
        details: { trunk: ft, trunkAll: fta },
      };
    },
  });
}
