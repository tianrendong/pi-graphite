import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt, type GtRunResult } from "../lib/exec";
import {
  ensureAllSuccess,
  ensureSuccess,
  renderText,
  type FormattedResult,
} from "../lib/result";
import {
  CwdParam,
  StageMode,
  StringEnum,
  Type,
  requireConfirm,
  stageArgs,
  type ToolReturn,
} from "../lib/schema";

/* --------------------------- branch_inspect --------------------------- */

interface InspectSection {
  label: string;
  args: string[];
  /** Display heading; null hides the section in the rendered output. */
  heading: string | null;
}

export function registerBranchInspect(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_branch_inspect",
    label: "Graphite: branch inspect",
    description:
      "Inspect a branch with separately-labeled sections: summary (parent/PR), parent, children, diffstat, body, and (optionally) diff or patch. Read-only.",
    promptSnippet:
      "graphite_branch_inspect: structured `gt info` + parent/children sections, optional diffstat/body/diff",
    parameters: Type.Object({
      cwd: CwdParam,
      branch: Type.Optional(
        Type.String({ description: "Branch to inspect (default current)." }),
      ),
      body: Type.Optional(
        Type.Boolean({ description: "Include the PR body section." }),
      ),
      stat: Type.Optional(
        Type.Boolean({ description: "Include the diffstat section." }),
      ),
      diff: Type.Optional(
        Type.Boolean({ description: "Include the full diff. Takes precedence over `patch`." }),
      ),
      patch: Type.Optional(
        Type.Boolean({ description: "Include per-commit patch. Ignored if `diff` is set." }),
      ),
      withParentChildren: Type.Optional(
        Type.Boolean({
          description:
            "Also run `gt parent` and `gt children` (only meaningful when inspecting the currently checked-out branch).",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const branchArg = p.branch ? [p.branch] : [];

      const sections: InspectSection[] = [
        {
          label: "gt info",
          heading: "## summary",
          args: ["info", ...branchArg],
        },
      ];

      if (p.withParentChildren) {
        sections.push({ label: "gt parent", heading: "## parent", args: ["parent"] });
        sections.push({ label: "gt children", heading: "## children", args: ["children"] });
      }

      if (p.stat && !p.diff && !p.patch) {
        sections.push({
          label: "gt info --stat",
          heading: "## diffstat",
          args: ["info", ...branchArg, "--stat"],
        });
      }

      if (p.body) {
        sections.push({
          label: "gt info --body",
          heading: "## body",
          args: ["info", ...branchArg, "--body"],
        });
      }

      if (p.diff) {
        const args = ["info", ...branchArg, "--diff"];
        if (p.stat) args.push("--stat");
        sections.push({ label: "gt info --diff", heading: "## diff", args });
      } else if (p.patch) {
        const args = ["info", ...branchArg, "--patch"];
        if (p.stat) args.push("--stat");
        sections.push({ label: "gt info --patch", heading: "## patch", args });
      }

      const results = await Promise.all(
        sections.map((s) => runGt(s.args, { cwd: p.cwd, signal })),
      );

      const formatted = await ensureAllSuccess(
        sections.map((s, i) => ({ label: s.label, result: results[i] })),
        p.cwd,
      );

      // Compose section-by-section structured output.
      const blocks: string[] = [];
      formatted.forEach((f, i) => {
        const s = sections[i];
        if (s.heading) blocks.push(s.heading);
        blocks.push(stripChrome(f.result.stdout));
        blocks.push("");
      });
      blocks.push("--- raw ---");
      formatted.forEach((f, i) => {
        blocks.push(renderText(sections[i].label, f));
        blocks.push("");
      });

      const details: Record<string, FormattedResult> = {};
      sections.forEach((s, i) => {
        const key = s.label.replace(/^gt\s+/, "").replace(/[^a-z0-9]/gi, "_");
        details[key] = formatted[i];
      });

      return {
        content: [{ type: "text", text: blocks.join("\n").trim() }],
        details,
      };
    },
  });
}

function stripChrome(s: string): string {
  return s.replace(/\s+$/, "");
}

/* --------------------------- branch_create --------------------------- */

export function registerBranchCreate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_branch_create",
    label: "Graphite: branch create",
    description:
      "Create a new branch stacked on top of the current (or `onto`) branch and commit staged changes. Local mutation.",
    promptSnippet:
      "graphite_branch_create: `gt create` with explicit message + stage mode",
    promptGuidelines: [
      "When using graphite_branch_create, always provide `message` unless the user explicitly asked for AI-generated metadata.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      message: Type.Optional(
        Type.String({ description: "Commit message. Required unless ai=true." }),
      ),
      name: Type.Optional(Type.String({ description: "Branch name (default generated)." })),
      stage: Type.Optional(StageMode),
      onto: Type.Optional(Type.String({ description: "Create on top of this branch instead of HEAD (--onto)." })),
      insert: Type.Optional(
        Type.Boolean({ description: "Insert between current branch and its child (--insert)." }),
      ),
      ai: Type.Optional(
        Type.Boolean({ description: "Use AI to generate branch name + message (--ai). Default false (--no-ai)." }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      if (!p.ai && !p.message) {
        throw new Error("graphite_branch_create requires `message` unless ai=true.");
      }
      const args = ["create"];
      if (p.name) args.push(p.name);
      if (p.message) args.push("--message", p.message);
      args.push(...stageArgs((p.stage ?? "none") as "none" | "all" | "update" | "patch"));
      if (p.onto) args.push("--onto", p.onto);
      if (p.insert) args.push("--insert");
      args.push(p.ai ? "--ai" : "--no-ai");
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

/* --------------------------- branch_update --------------------------- */

export function registerBranchUpdate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_branch_update",
    label: "Graphite: branch update",
    description:
      "Mutate the current (or named) branch: amend, add a new commit, absorb staged hunks, squash, pop, rename, or delete. Auto-restacks descendants where applicable.",
    promptSnippet:
      "graphite_branch_update: amend/new_commit/absorb/squash/pop/rename/delete on a branch",
    promptGuidelines: [
      "Use graphite_branch_update with action=absorb (dryRun:true first) to distribute staged hunks across downstack commits.",
      "graphite_branch_update with action=delete and close:true requires confirmRemote.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum([
        "amend",
        "new_commit",
        "absorb",
        "squash",
        "pop",
        "rename",
        "delete",
      ] as const),
      message: Type.Optional(Type.String()),
      stage: Type.Optional(StageMode),
      into: Type.Optional(
        Type.String({ description: "action=amend: amend into a downstack branch (`gt modify --into`)." }),
      ),
      edit: Type.Optional(Type.Boolean({ description: "Open editor for commit message." })),
      resetAuthor: Type.Optional(Type.Boolean({ description: "action=amend: reset commit author." })),
      newName: Type.Optional(Type.String({ description: "action=rename: new branch name." })),
      branch: Type.Optional(Type.String({ description: "action=delete: branch name to delete." })),
      force: Type.Optional(Type.Boolean({ description: "action=delete or rename: force." })),
      close: Type.Optional(
        Type.Boolean({ description: "action=delete: also close associated PR (requires confirmRemote)." }),
      ),
      downstack: Type.Optional(Type.Boolean({ description: "action=delete: also delete ancestors." })),
      upstack: Type.Optional(Type.Boolean({ description: "action=delete: also delete descendants." })),
      dryRun: Type.Optional(
        Type.Boolean({ description: "action=absorb: dry-run only (default true)." }),
      ),
      patch: Type.Optional(Type.Boolean({ description: "action=absorb: pick hunks (--patch)." })),
      confirmRemote: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];

      switch (p.action) {
        case "amend": {
          args = ["modify"];
          args.push(...stageArgs((p.stage ?? "none") as "none" | "all" | "update" | "patch"));
          if (p.message) args.push("--message", p.message);
          if (p.edit) args.push("--edit");
          if (p.resetAuthor) args.push("--reset-author");
          if (p.into) args.push("--into", p.into);
          break;
        }
        case "new_commit": {
          if (!p.message && !p.edit) {
            throw new Error("action=new_commit requires `message` or edit=true.");
          }
          args = ["modify", "--commit"];
          args.push(...stageArgs((p.stage ?? "none") as "none" | "all" | "update" | "patch"));
          if (p.message) args.push("--message", p.message);
          if (p.edit) args.push("--edit");
          break;
        }
        case "absorb": {
          const dryRun = p.dryRun !== false; // default true
          args = ["absorb"];
          if (dryRun) args.push("--dry-run");
          else args.push("--force");
          const stage = (p.stage ?? "none") as "none" | "all" | "update" | "patch";
          if (stage === "all") args.push("--all");
          if (p.patch) args.push("--patch");
          break;
        }
        case "squash": {
          args = ["squash"];
          if (p.message) args.push("--message", p.message);
          if (p.edit) args.push("--edit");
          break;
        }
        case "pop": {
          args = ["pop"];
          break;
        }
        case "rename": {
          if (!p.newName) throw new Error("action=rename requires `newName`.");
          args = ["rename", p.newName];
          if (p.force) args.push("--force");
          break;
        }
        case "delete": {
          if (p.close) requireConfirm(p.confirmRemote, "delete --close (closes PR on GitHub)");
          args = ["delete"];
          if (p.branch) args.push(p.branch);
          if (p.force) args.push("--force");
          if (p.close) args.push("--close");
          if (p.downstack) args.push("--downstack");
          if (p.upstack) args.push("--upstack");
          break;
        }
      }

      const label = `gt ${args.join(" ")}`;
      const r: GtRunResult = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { action: p.action, result: f },
      };
    },
  });
}

/* --------------------------- branch_tracking --------------------------- */

export function registerBranchTracking(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_branch_tracking",
    label: "Graphite: branch tracking",
    description:
      "Track / untrack a branch with Graphite, or freeze / unfreeze to prevent local modifications.",
    promptSnippet:
      "graphite_branch_tracking: track/untrack/freeze/unfreeze a branch",
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["track", "untrack", "freeze", "unfreeze"] as const),
      branch: Type.Optional(Type.String()),
      parent: Type.Optional(
        Type.String({ description: "action=track: explicit parent branch." }),
      ),
      force: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "track":
          args = ["track"];
          if (p.branch) args.push(p.branch);
          if (p.parent) args.push("--parent", p.parent);
          if (p.force) args.push("--force");
          break;
        case "untrack":
          args = ["untrack"];
          if (p.branch) args.push(p.branch);
          if (p.force) args.push("--force");
          break;
        case "freeze":
          args = ["freeze"];
          if (p.branch) args.push(p.branch);
          break;
        case "unfreeze":
          args = ["unfreeze"];
          if (p.branch) args.push(p.branch);
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

/* --------------------------- branch_navigate --------------------------- */

export function registerBranchNavigate(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_branch_navigate",
    label: "Graphite: navigate",
    description:
      "Navigate the current stack: checkout a branch, move up/down N levels, or jump to top/bottom.",
    promptSnippet:
      "graphite_branch_navigate: checkout/up/down/top/bottom across the stack",
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["checkout", "up", "down", "top", "bottom"] as const),
      branch: Type.Optional(Type.String({ description: "action=checkout: branch to checkout." })),
      steps: Type.Optional(Type.Integer({ minimum: 1, description: "action=up|down step count." })),
      to: Type.Optional(
        Type.String({ description: "action=up: target descendant when multiple children exist (--to)." }),
      ),
      showAllTrunks: Type.Optional(Type.Boolean({ description: "action=checkout: --all." })),
      showUntracked: Type.Optional(Type.Boolean({ description: "action=checkout: --show-untracked." })),
      stackOnly: Type.Optional(Type.Boolean({ description: "action=checkout: only stack branches (--stack)." })),
      checkoutTrunk: Type.Optional(Type.Boolean({ description: "action=checkout: jump to trunk (--trunk)." })),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "checkout":
          args = ["checkout"];
          if (p.branch) args.push(p.branch);
          if (p.showAllTrunks) args.push("--all");
          if (p.showUntracked) args.push("--show-untracked");
          if (p.stackOnly) args.push("--stack");
          if (p.checkoutTrunk) args.push("--trunk");
          if (!p.branch && !p.checkoutTrunk) {
            throw new Error(
              "action=checkout requires `branch` or `checkoutTrunk:true` (interactive selector disabled).",
            );
          }
          break;
        case "up":
          args = ["up"];
          if (p.steps != null) args.push("--steps", String(p.steps));
          if (p.to) args.push("--to", p.to);
          break;
        case "down":
          args = ["down"];
          if (p.steps != null) args.push("--steps", String(p.steps));
          break;
        case "top":
          args = ["top"];
          break;
        case "bottom":
          args = ["bottom"];
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
