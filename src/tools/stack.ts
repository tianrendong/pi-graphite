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

/* ------------------------------ stack_view ------------------------------ */

export function registerStackView(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_stack_view",
    label: "Graphite: stack view",
    description:
      "Show the Graphite stack as `gt log` (short/long/full). Read-only.",
    promptSnippet:
      "graphite_stack_view: read-only `gt log` of branches + dependencies",
    parameters: Type.Object({
      cwd: CwdParam,
      mode: Type.Optional(
        StringEnum(["short", "long", "full"] as const, {
          description: "short = `gt log short`, long = `gt log long`, full = `gt log`.",
        }),
      ),
      scope: Type.Optional(
        StringEnum(["all_trunks", "current_stack", "default"] as const, {
          description:
            "all_trunks adds --all (only supported on mode=full/default). current_stack adds --stack. default does neither.",
        }),
      ),
      showUntracked: Type.Optional(Type.Boolean()),
      reverse: Type.Optional(Type.Boolean()),
      steps: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      // Empirically, current gt rejects `--all` on `gt log short` / `gt log long`
      // ("Unknown argument: all"). Block that combination at the tool layer
      // instead of exposing it to the model.
      if (p.scope === "all_trunks" && (p.mode === "short" || p.mode === "long")) {
        throw new Error(
          "graphite_stack_view: scope='all_trunks' is not supported with mode='short'/'long' " +
            "(current `gt` rejects `--all` on those forms). Omit `mode` (or use mode='full') to use --all.",
        );
      }

      const sub =
        p.mode === "short"
          ? ["log", "short"]
          : p.mode === "long"
            ? ["log", "long"]
            : ["log"];
      const args = [...sub];
      if (p.scope === "all_trunks") args.push("--all");
      if (p.scope === "current_stack") args.push("--stack");
      if (p.showUntracked) args.push("--show-untracked");
      if (p.reverse) args.push("--reverse");
      if (p.steps != null) args.push("--steps", String(p.steps));

      const label = `gt ${args.join(" ")}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { result: f },
      };
    },
  });
}

/* ----------------------------- stack_restack ----------------------------- */

export function registerStackRestack(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_stack_restack",
    label: "Graphite: restack",
    description:
      "Restack the current stack (or a chosen branch / scope) so each branch contains its parent's history. Local mutation only.",
    promptSnippet:
      "graphite_stack_restack: rebase stack so each branch contains parent history",
    promptGuidelines: [
      "Use graphite_stack_restack after editing a downstack branch to bring descendants up to date.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      scope: Type.Optional(
        StringEnum(["current_stack", "downstack", "upstack", "only"] as const, {
          description:
            "Default current_stack (no scope flag). downstack=--downstack, upstack=--upstack, only=--only.",
        }),
      ),
      branch: Type.Optional(
        Type.String({ description: "Branch to restack from (default: current branch)." }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const args = ["restack"];
      if (p.branch) args.push("--branch", p.branch);
      if (p.scope === "downstack") args.push("--downstack");
      else if (p.scope === "upstack") args.push("--upstack");
      else if (p.scope === "only") args.push("--only");

      const label = `gt ${args.join(" ")}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { result: f },
      };
    },
  });
}

/* --------------------------- stack_reorganize --------------------------- */

export function registerStackReorganize(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_stack_reorganize",
    label: "Graphite: stack reorganize",
    description:
      "Reorganize the stack: move a branch onto a new parent, fold a branch into its parent, or split by file pathspec. `gt reorder` is intentionally not exposed (editor-only).",
    promptSnippet:
      "graphite_stack_reorganize: move / fold / split-by-file branches",
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["move_branch", "fold", "split_by_file"] as const),
      onto: Type.Optional(Type.String({ description: "Target parent branch (action=move_branch)." })),
      source: Type.Optional(
        Type.String({ description: "Source branch to move (default current, action=move_branch)." }),
      ),
      onlyMove: Type.Optional(
        Type.Boolean({ description: "action=move_branch: leave descendants behind (--only)." }),
      ),
      foldKeep: Type.Optional(
        Type.Boolean({ description: "action=fold: keep current branch name (--keep)." }),
      ),
      foldStack: Type.Optional(
        Type.Boolean({ description: "action=fold: fold the entire stack into one branch (--stack)." }),
      ),
      foldClose: Type.Optional(
        Type.Boolean({ description: "action=fold: close associated PRs on GitHub (--close). Requires confirmRemote." }),
      ),
      filePatterns: Type.Optional(
        Type.Array(Type.String(), {
          description: "action=split_by_file: one or more pathspecs (-f). Repeat-flag style.",
        }),
      ),
      confirmRemote: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      if (p.action === "move_branch") {
        if (!p.onto) throw new Error("action=move_branch requires `onto`.");
        args = ["move", "--onto", p.onto];
        if (p.source) args.push("--source", p.source);
        if (p.onlyMove) args.push("--only");
      } else if (p.action === "fold") {
        if (p.foldClose) requireConfirm(p.confirmRemote, "fold --close");
        args = ["fold"];
        if (p.foldKeep) args.push("--keep");
        if (p.foldStack) args.push("--stack");
        if (p.foldClose) args.push("--close");
      } else {
        if (!p.filePatterns || p.filePatterns.length === 0) {
          throw new Error(
            "action=split_by_file requires `filePatterns` (one or more pathspecs).",
          );
        }
        args = ["split", "--by-file"];
        for (const pat of p.filePatterns) args.push("-f", pat);
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
