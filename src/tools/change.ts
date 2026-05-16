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
 * graphite_change — the only blessed branch-mutation path.
 *
 *   action=create        gt create -am "<message>"   (new branch on top of current)
 *   action=amend         gt modify -am "<message>"   (amend current branch's commit)
 *   action=amend_into    gt modify --into <branch> -am "<message>"
 *   action=absorb        gt absorb (dry-run by default)
 *
 * Always stages all changes (matches the golden-path `-am`). No editor, no
 * patch/hunk picker, no AI metadata.
 */
export function registerChange(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_change",
    label: "Graphite: change",
    description:
      "Create or amend a branch commit in the Graphite stack. action=create stacks a new branch on top of the current one. action=amend updates the current branch's commit. action=amend_into pushes staged hunks into a downstack branch. action=absorb auto-routes staged hunks to the correct commits (dry-run by default).",
    promptSnippet:
      "graphite_change: create | amend | amend_into | absorb — the only branch mutation tool",
    promptGuidelines: [
      "Use graphite_change action=create to start a new PR branch on top of the current branch. Always provide `message`.",
      "Use graphite_change action=amend to update the current PR's commit. Always provide `message`.",
      "Run graphite_status first to confirm you are on the intended branch.",
      "graphite_change always stages all changes (matches `gt create -am` / `gt modify -am`). Stage selectively with `git add -p` outside this tool if you need a partial commit, then call graphite_change.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum([
        "create",
        "amend",
        "amend_into",
        "absorb",
      ] as const),
      message: Type.Optional(
        Type.String({
          description:
            "Commit message. Required for create/amend/amend_into.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description: "action=create: branch name (default generated from message).",
        }),
      ),
      insert: Type.Optional(
        Type.Boolean({
          description:
            "action=create: insert between current branch and its child, rebasing children (--insert).",
        }),
      ),
      includeUntracked: Type.Optional(
        Type.Boolean({
          description:
            "action=create|amend|amend_into: include untracked files (--update). Default false; staged + tracked-modified are always included via --all.",
        }),
      ),
      into: Type.Optional(
        Type.String({
          description: "action=amend_into: target downstack branch to amend into.",
        }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description:
            "action=absorb: false (default) => --dry-run; true => --force (apply).",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "create": {
          if (!p.message) {
            throw new Error("graphite_change action=create requires `message`.");
          }
          args = ["create"];
          if (p.name) args.push(assertSafeRef(p.name, "name"));
          args.push(flagEq("--message", p.message));
          // `-am` semantics: always stage tracked modifications.
          args.push("--all");
          if (p.includeUntracked) args.push("--update");
          if (p.insert) args.push("--insert");
          args.push("--no-ai");
          break;
        }
        case "amend": {
          if (!p.message) {
            throw new Error("graphite_change action=amend requires `message`.");
          }
          args = ["modify", "--all"];
          if (p.includeUntracked) args.push("--update");
          args.push(flagEq("--message", p.message));
          break;
        }
        case "amend_into": {
          if (!p.into) {
            throw new Error("graphite_change action=amend_into requires `into`.");
          }
          if (!p.message) {
            throw new Error(
              "graphite_change action=amend_into requires `message`.",
            );
          }
          args = ["modify", "--all"];
          if (p.includeUntracked) args.push("--update");
          args.push(flagEq("--into", assertSafeRef(p.into, "into")));
          args.push(flagEq("--message", p.message));
          break;
        }
        case "absorb": {
          const apply = p.apply === true;
          args = ["absorb"];
          if (!apply) args.push("--dry-run");
          else args.push("--force");
          // Match `-am` style: include tracked modifications for absorb too.
          args.push("--all");
          break;
        }
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
