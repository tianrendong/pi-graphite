import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMMAND_TIMEOUT_MS, killProcessGroup, runGt, safeNoninteractiveEnv } from "../lib/exec";
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

interface CmdResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

function runGh(args: string[], cwd: string, signal?: AbortSignal): Promise<CmdResult> {
  return new Promise((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("gh", args, {
        cwd,
        env: safeNoninteractiveEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolve({ command: "gh", args, cwd, exitCode: -1, stdout: "", stderr: "", timedOut: false, spawnError: (e as Error).message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;
    let settled = false;
    const killChild = () => {
      killed = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 1500).unref?.();
    };
    const timeout = setTimeout(killChild, DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = killChild;
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ command: "gh", args, cwd, exitCode: -1, stdout, stderr, timedOut: killed, spawnError: e.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ command: "gh", args, cwd, exitCode: code ?? -1, stdout, stderr, timedOut: killed });
    });
  });
}

function renderGhText(label: string, r: CmdResult): string {
  const lines = [`[${label}] fail`, `$ gh ${r.args.join(" ")}`, `# cwd=${r.cwd}  exit=${r.exitCode}${r.timedOut ? "  (aborted)" : ""}${r.spawnError ? `  (spawn-error: ${r.spawnError})` : ""}`];
  if (r.stdout.trim()) lines.push("--- stdout ---", r.stdout.trimEnd());
  if (r.stderr.trim()) lines.push("--- stderr ---", r.stderr.trimEnd());
  return lines.join("\n");
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
            "true => --stack (include descendants). false => --no-stack. Omitted => gt default behavior.",
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
        StringEnum(["none", "cli"] as const, {
          description:
            "none (default) => --no-edit; cli => --edit --cli. Browser/web edit mode is disabled.",
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
      view: Type.Optional(Type.Boolean({ description: "Rejected: browser viewing is disabled." })),
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
      if ((p.editMode as string | undefined) === "web") throw new Error("editMode:'web' is disabled; browser launch is not exposed.");
      if (p.view) throw new Error("view:true is disabled; browser launch is not exposed. Use graphite_pr_lifecycle action='view_url'.");

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

      args.push(p.ai ? "--ai" : "--no-ai");

      if (p.forcePush) args.push("--force");
      if (p.ignoreOutOfSyncTrunk) args.push("--ignore-out-of-sync-trunk");

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
      "PR lifecycle actions: return PR URL, merge the stack via Graphite, or unlink a branch from its PR.",
    promptSnippet:
      "graphite_pr_lifecycle: view_url | merge | unlink for a PR/branch",
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["view_url", "merge", "unlink"] as const),
      branch: Type.Optional(Type.String({ description: "Branch name or PR number." })),
      stack: Type.Optional(
        Type.Boolean({ description: "Rejected: stack browser page is disabled." }),
      ),
      apply: Type.Optional(
        Type.Boolean({
          description: "action=merge: false (default) => --dry-run; true => actually merge (requires confirmRemote).",
        }),
      ),
      confirm: Type.Optional(
        Type.Boolean({
          description: "Rejected: interactive confirmation prompts are disabled.",
        }),
      ),
      confirmRemote: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      if (p.action === "view_url") {
        if (p.stack) throw new Error("stack:true is disabled; browser stack page is not exposed.");
        const branchArgs = p.branch ? [p.branch] : [];
        const r = await runGh(["pr", "view", ...branchArgs, "--json", "url", "--jq", ".url"], p.cwd, signal);
        if (r.exitCode !== 0) throw new Error(renderGhText("gh pr view", r));
        return {
          content: [{ type: "text", text: r.stdout.trim() }],
          details: { action: p.action, url: r.stdout.trim(), result: r },
        };
      } else if (p.action === "merge") {
        const apply = p.apply === true;
        if (apply) requireConfirm(p.confirmRemote, "gt merge (merges PRs on GitHub)");
        args = ["merge"];
        if (!apply) args.push("--dry-run");
        if (p.confirm) throw new Error("confirm:true is disabled; interactive confirmation prompts are not exposed.");
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
