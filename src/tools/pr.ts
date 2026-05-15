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

/* ------------------------------ pr_submit ------------------------------ */

function shellQuote(s: string): string {
  if (s === "") return "''";
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

export function registerPrSubmit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_pr_submit",
    label: "Graphite: PR submit",
    description:
      "Submit branches as pull requests via `gt submit`. Defaults to a dry-run plan; set apply:true (with confirmRemote:true) to actually push and create/update PRs.",
    promptSnippet:
      "graphite_pr_submit: plan or apply `gt submit` for a branch or stack",
    promptGuidelines: [
      "Always call graphite_pr_submit with apply:false (default) first to see the dry-run plan, then call again with apply:true and confirmRemote:true to actually submit.",
      "`gt submit` cannot set PR title/body inline. If you pass `title`/`body` to graphite_pr_submit, the tool will return a `gh pr edit` command for you to run via bash to apply the metadata.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      apply: Type.Optional(
        Type.Boolean({
          description: "false => --dry-run (default). true => actually push (requires confirmRemote).",
        }),
      ),
      stack: Type.Optional(
        Type.Boolean({
          description:
            "true => --stack (include descendants). false => --no-stack. Omitted => default (gt prompts based on config).",
        }),
      ),
      branch: Type.Optional(Type.String({ description: "Run from this branch (--branch)." })),
      updateOnly: Type.Optional(Type.Boolean({ description: "--update-only" })),
      draft: Type.Optional(Type.Boolean({ description: "--draft for new PRs" })),
      publish: Type.Optional(Type.Boolean({ description: "--publish all PRs" })),
      mergeWhenReady: Type.Optional(Type.Boolean({ description: "--merge-when-ready" })),
      rerequestReview: Type.Optional(Type.Boolean()),
      reviewers: Type.Optional(Type.Array(Type.String(), { description: "User reviewers (--reviewers)." })),
      teamReviewers: Type.Optional(Type.Array(Type.String())),
      comment: Type.Optional(Type.String({ description: "--comment <msg>" })),
      targetTrunk: Type.Optional(Type.String()),
      editMode: Type.Optional(
        StringEnum(["none", "cli", "web"] as const, {
          description:
            "none (default) => --no-edit; cli => --edit --cli; web => --web. Affects PR metadata prompting.",
        }),
      ),
      ai: Type.Optional(
        Type.Boolean({
          description: "true => --ai (let gt generate PR title/body). Default false (--no-ai).",
        }),
      ),
      forcePush: Type.Optional(
        Type.Boolean({ description: "--force (instead of default --force-with-lease). Requires confirmRemote." }),
      ),
      ignoreOutOfSyncTrunk: Type.Optional(Type.Boolean()),
      view: Type.Optional(Type.Boolean({ description: "--view (open PR in browser after submit)." })),
      confirmRemote: Type.Optional(Type.Boolean()),

      title: Type.Optional(
        Type.String({
          description:
            "Desired PR title. `gt submit` has no inline flag for this; the tool emits a `gh pr edit` command to run after submit.",
        }),
      ),
      body: Type.Optional(
        Type.String({
          description:
            "Desired PR body. `gt submit` has no inline flag for this; the tool emits a `gh pr edit` command to run after submit.",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const apply = p.apply === true;
      if (apply) requireConfirm(p.confirmRemote, "gt submit (push branches + create/update PRs)");
      if (p.forcePush) requireConfirm(p.confirmRemote, "gt submit --force");

      const wantsCustomMetadata = p.title != null || p.body != null;

      const args: string[] = ["submit"];
      if (!apply) args.push("--dry-run");

      if (p.stack === true) args.push("--stack");
      else if (p.stack === false) args.push("--no-stack");

      if (p.branch) args.push("--branch", p.branch);
      if (p.updateOnly) args.push("--update-only");
      if (p.draft) args.push("--draft");
      if (p.publish) args.push("--publish");
      if (p.mergeWhenReady) args.push("--merge-when-ready");
      if (p.rerequestReview) args.push("--rerequest-review");

      if (p.reviewers && p.reviewers.length)
        args.push("--reviewers", p.reviewers.join(","));
      if (p.teamReviewers && p.teamReviewers.length)
        args.push("--team-reviewers", p.teamReviewers.join(","));
      if (p.comment) args.push("--comment", p.comment);
      if (p.targetTrunk) args.push("--target-trunk", p.targetTrunk);

      // If the caller supplied title/body, force --no-edit so gt doesn't try
      // to prompt or open a web editor with conflicting metadata. The actual
      // metadata is applied via the suggested `gh pr edit` command instead.
      const editMode = wantsCustomMetadata ? "none" : (p.editMode ?? "none");
      if (editMode === "none") args.push("--no-edit");
      else if (editMode === "cli") args.push("--edit", "--cli");
      else if (editMode === "web") args.push("--web");

      args.push(p.ai ? "--ai" : "--no-ai");

      if (p.forcePush) args.push("--force");
      if (p.ignoreOutOfSyncTrunk) args.push("--ignore-out-of-sync-trunk");
      if (p.view) args.push("--view");

      const label = `gt ${args.join(" ")}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd);

      const blocks: string[] = [renderText(label, f)];

      let metadataNote: string | undefined;
      if (wantsCustomMetadata) {
        const ghParts: string[] = ["gh", "pr", "edit"];
        if (p.branch) ghParts.push(p.branch);
        if (p.title != null) ghParts.push("--title", shellQuote(p.title));
        if (p.body != null) ghParts.push("--body", shellQuote(p.body));
        const ghCmd = ghParts.join(" ");

        metadataNote = [
          "## metadata note",
          "`gt submit` has no flag to set PR title/body inline.",
          "To apply the title/body you supplied, run the following via the bash tool" +
            " (gt does not run gh for you; this keeps the tool composable):",
          ghCmd,
          p.stack === true || (!p.branch && p.stack !== false)
            ? "If this submit covered multiple PRs, repeat `gh pr edit <branch>` for each PR that needs metadata."
            : undefined,
        ]
          .filter((x): x is string => Boolean(x))
          .join("\n");

        blocks.push(metadataNote);
      }

      return {
        content: [{ type: "text", text: blocks.join("\n\n") }],
        details: {
          apply,
          editMode,
          wantsCustomMetadata,
          metadataNote,
          result: f,
        },
      };
    },
  });
}

/* ----------------------------- pr_lifecycle ----------------------------- */

export function registerPrLifecycle(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_pr_lifecycle",
    label: "Graphite: PR lifecycle",
    description:
      "PR lifecycle actions: open the PR/stack page in a browser, merge the stack via Graphite, or unlink a branch from its PR.",
    promptSnippet:
      "graphite_pr_lifecycle: open_url | merge | unlink for a PR/branch",
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["open_url", "merge", "unlink"] as const),
      branch: Type.Optional(Type.String({ description: "Branch name or PR number." })),
      stack: Type.Optional(
        Type.Boolean({ description: "action=open_url: open stack page (--stack)." }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description: "action=merge: false (default) => --dry-run; true => actually merge (requires confirmRemote).",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "action=merge: pass --confirm so gt prompts before merging each branch.",
        }),
      ),
      confirmRemote: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      if (p.action === "open_url") {
        args = ["pr"];
        if (p.branch) args.push(p.branch);
        if (p.stack) args.push("--stack");
      } else if (p.action === "merge") {
        const apply = p.apply === true;
        if (apply) requireConfirm(p.confirmRemote, "gt merge (merges PRs on GitHub)");
        args = ["merge"];
        if (!apply) args.push("--dry-run");
        if (p.confirm) args.push("--confirm");
      } else {
        args = ["unlink"];
        if (p.branch) args.push(p.branch);
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
