import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureAllSuccess, ensureSuccess, GRAPHITE_OUTPUT_SCHEMA, renderText, textResult, type OutputView } from "../lib/result";
import {
  CwdParam,
  StringEnum,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_change — the only blessed branch-mutation path.
 *
 *   action=create        gt create -am "<message>"   (new branch on top of current)
 *   action=amend         gt modify -am "<message>"   (amend current branch's commit)
 *   action=amend_into    gt modify --into <branch> -am "<message>"
 *   action=absorb        gt absorb (dry-run by default)
 *   action=fold          gt fold [--keep] (plan by default; confirmed apply)
 *
 * Create/modify/absorb include tracked modifications via --all. Fold combines
 * committed branch histories without staging changes. No editor, patch/hunk
 * picker, or AI metadata.
 */
export function registerChange(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_change",
    label: "Graphite: change",
    description:
      "Mutate stack branches. create: new branch on top of current. amend: amend current commit. amend_into: amend a downstack branch. absorb: route hunks into downstack commits. fold: merge current branch into its non-trunk parent and restack. All but fold stage tracked changes (--all). absorb and fold are dry-runs unless apply:true; fold apply also requires confirmDestructive:true.",
    promptSnippet: "graphite_change: create | amend | amend_into | absorb | fold",
    promptGuidelines: [
      "Use graphite_change / graphite_submit instead of running `gt create`, `gt modify`, or `gt submit` in bash.",
    ],
    outputSchema: GRAPHITE_OUTPUT_SCHEMA,
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum([
        "create",
        "amend",
        "amend_into",
        "absorb",
        "fold",
      ] as const),
      message: Type.Optional(
        Type.String({ description: "Required for create/amend/amend_into." }),
      ),
      name: Type.Optional(Type.String({ description: "create: branch name." })),
      insert: Type.Optional(
        Type.Boolean({ description: "create: insert between current branch and its child." }),
      ),
      includeUntracked: Type.Optional(
        Type.Boolean({ description: "Also stage untracked files." }),
      ),
      into: Type.Optional(Type.String({ description: "amend_into: target branch." })),
      apply: Type.Optional(Type.Boolean({ description: "absorb/fold: execute." })),
      keep: Type.Optional(
        Type.Boolean({ description: "fold: keep current branch name; delete the parent instead." }),
      ),
      confirmDestructive: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "fold":
          return foldCurrentBranch(p.cwd, p, signal);
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
      const f = await ensureSuccess(label, r, p.cwd, { mutating: true });
      return textResult((view) => renderText(label, f, view), { action: p.action, result: f });
    },
  });
}

async function foldCurrentBranch(
  cwd: string,
  options: { apply?: boolean; keep?: boolean; confirmDestructive?: boolean },
  signal?: AbortSignal,
): Promise<ToolReturn> {
  const apply = options.apply === true;
  const keep = options.keep === true;
  if (apply) {
    requireConfirm(
      options.confirmDestructive,
      "gt fold (combines branch histories, deletes a branch, and restacks descendants)",
    );
  }

  // gt parent validates the current branch. Reject folding a base branch into
  // trunk too, including in the plan, since gt cannot fold into trunk.
  const [parentResult, trunkResult] = await Promise.all([
    runGt(["parent"], { cwd, signal }),
    runGt(["trunk"], { cwd, signal }),
  ]);
  await ensureAllSuccess([
    { label: "gt parent", result: parentResult, requireStdout: true },
    { label: "gt trunk", result: trunkResult, requireStdout: true },
  ], cwd);
  const parent = parentResult.stdout.trim().split("\n").pop()!.trim();
  const trunk = trunkResult.stdout.trim().split("\n").pop()!.trim();
  if (parent === trunk) {
    throw new Error(`graphite_change action=fold cannot fold into trunk (${trunk}). Check out a branch with a non-trunk parent.`);
  }

  const args = ["fold"];
  if (keep) args.push("--keep");

  // gt fold has no --dry-run flag. Build a read-only plan instead of invoking
  // fold at all until apply:true and confirmDestructive:true are supplied.
  if (!apply) {
    const log = await runGt(["log", "--stack"], { cwd, signal });
    const preflight = await ensureSuccess("gt log --stack", log, cwd, { requireStdout: true });
    const plan = (view: OutputView) => [
      "[graphite_change fold] dry-run (no changes made)",
      "",
      `Fold the current branch into its parent (${parent}) and restack descendants of the combined branch.`,
      keep
        ? `Keep the current branch name; delete parent branch ${parent}.`
        : `Keep parent branch ${parent}; delete the current branch.`,
      `Other branches stacked on ${parent} may also be rebased, even if omitted from the current-stack view below.`,
      "Existing commits are retained; working-tree changes are not staged.",
      `Command that would run: gt ${shellJoin(["--cwd", cwd, "--no-interactive", ...args])}`,
      `To apply: call graphite_change action=fold with keep:${keep}, apply:true, and confirmDestructive:true.`,
      "If it halts on a conflict, resolve files then graphite_recover action=continue (or abort).",
      "",
      "--- preflight stack ---",
      renderText("gt log --stack", preflight, view),
    ].join("\n");
    return textResult(plan, { action: "fold", apply: false, keep, parent, preflight });
  }

  const label = `gt ${shellJoin(args)}`;
  const result = await runGt(args, { cwd, signal });
  const formatted = await ensureSuccess(label, result, cwd, { mutating: true });
  return textResult((view) => renderText(label, formatted, view), { action: "fold", apply: true, keep, parent, result: formatted });
}
