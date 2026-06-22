import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGh, runGt, type GtRunResult } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, renderText } from "../lib/result";
import {
  CwdParam,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

interface PrDescriptionInput {
  branch: string;
  body: string;
}

interface PrInfo {
  branch: string;
  number?: number;
  body?: string;
  exists: boolean;
}

interface DescriptionApplyResult {
  branch: string;
  action: "set" | "skipped_existing_body" | "missing_pr";
  number?: number;
}

const NO_PR_RE = /no pull requests? found|not found|could not resolve to a pull request|no open pull requests?/i;

/**
 * graphite_submit — blessed submit path.
 *
 * Wraps `gt submit --stack --no-edit --no-ai`. PR descriptions are supplied
 * explicitly and then applied with non-interactive `gh pr edit --body-file`.
 * New PRs and existing empty PRs require descriptions before remote mutation.
 */
export function registerSubmit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_submit",
    label: "Graphite: submit stack",
    description:
      "Push the entire current stack and create/update PRs via `gt submit --stack --no-edit`, then set PR descriptions via `gh pr edit --body-file`. Defaults to a dry-run plan; apply requires confirmRemote and descriptions for new/empty PRs.",
    promptSnippet:
      "graphite_submit: plan or apply `gt submit --stack`; apply requires PR descriptions for new/empty PRs",
    promptGuidelines: [
      "Always call graphite_submit with apply:false (default) first to review the dry-run plan, then call again with apply:true and confirmRemote:true to actually push.",
      "When apply:true might create PRs, pass descriptions:[{branch, body}] for each new PR branch. Existing PRs with empty bodies also require descriptions.",
      "Use overwriteDescriptions:true only when user explicitly wants to replace existing non-empty PR bodies.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      apply: Type.Optional(
        Type.Boolean({
          description:
            "false => --dry-run (default). true => actually push + set provided PR descriptions (requires confirmRemote).",
        }),
      ),
      confirmRemote: Type.Optional(Type.Boolean()),
      descriptions: Type.Optional(
        Type.Array(
          Type.Object({
            branch: Type.String({
              description: "Branch whose PR body should be set.",
            }),
            body: Type.String({
              description: "Non-empty PR description/body for this branch.",
            }),
          }),
          {
            description:
              "PR descriptions keyed by branch. Required for each new PR and each existing empty PR on apply:true.",
          },
        ),
      ),
      overwriteDescriptions: Type.Optional(
        Type.Boolean({
          description:
            "Replace existing non-empty PR bodies with supplied descriptions. Default false preserves existing bodies.",
        }),
      ),
      draft: Type.Optional(
        Type.Boolean({ description: "Create new PRs as drafts (--draft)." }),
      ),
      publish: Type.Optional(
        Type.Boolean({ description: "Take PRs out of draft (--publish)." }),
      ),
      updateOnly: Type.Optional(
        Type.Boolean({
          description: "Only update existing PRs, do not create new ones (--update-only).",
        }),
      ),
      mergeWhenReady: Type.Optional(
        Type.Boolean({ description: "Enable auto-merge (--merge-when-ready)." }),
      ),
      rerequestReview: Type.Optional(
        Type.Boolean({
          description: "Re-request review from existing reviewers (--rerequest-review).",
        }),
      ),
      reviewers: Type.Optional(
        Type.Array(Type.String(), {
          description: "User reviewers (--reviewers).",
        }),
      ),
      teamReviewers: Type.Optional(
        Type.Array(Type.String(), {
          description: "Team reviewers (--team-reviewers).",
        }),
      ),
      forcePush: Type.Optional(
        Type.Boolean({
          description:
            "--force (instead of default --force-with-lease). Requires confirmRemote.",
        }),
      ),
      ignoreOutOfSyncTrunk: Type.Optional(
        Type.Boolean({
          description: "Submit even if trunk is out of sync (--ignore-out-of-sync-trunk).",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const apply = p.apply === true;
      if (apply) {
        requireConfirm(
          p.confirmRemote,
          "gt submit --stack (push branches + create/update PRs)",
        );
      }
      if (p.forcePush) {
        requireConfirm(p.confirmRemote, "gt submit --force");
      }

      const descriptionByBranch = normalizeDescriptions(p.descriptions ?? []);
      const overwriteDescriptions = p.overwriteDescriptions === true;
      let preflight: PrInfo[] = [];
      let requiredDescriptions: string[] = [];

      const branches = await stackBranches(p.cwd, signal);
      const branchSet = new Set(branches);
      const unknownDescriptions = [...descriptionByBranch.keys()].filter(
        (branch) => !branchSet.has(branch),
      );
      if (unknownDescriptions.length) {
        throw new Error(
          `Refused: descriptions provided for branches outside current stack: ${unknownDescriptions.join(", ")}.`,
        );
      }
      preflight = await inspectPrs(p.cwd, branches, signal);
      requiredDescriptions = requiredDescriptionBranches(preflight, p.updateOnly === true);

      if (apply) {
        const missing = requiredDescriptions.filter(
          (branch) => !descriptionByBranch.get(branch)?.trim(),
        );
        if (missing.length) {
          throw new Error(
            `Refused: PR descriptions missing for ${missing.join(", ")}. ` +
              `Pass descriptions:[{branch, body}] before graphite_submit apply:true.`,
          );
        }
      }

      const args = ["submit", "--stack"];
      if (!apply) args.push("--dry-run");
      args.push("--no-edit", "--no-ai");

      if (p.updateOnly) args.push("--update-only");
      if (p.draft) args.push("--draft");
      if (p.publish) args.push("--publish");
      if (p.mergeWhenReady) args.push("--merge-when-ready");
      if (p.rerequestReview) args.push("--rerequest-review");

      const assertReviewer = (rv: string, label: string) => {
        assertSafeRef(rv, label);
        // gt joins reviewers on ',' before calling gh. Reject any element
        // that itself contains a comma or whitespace so a single array
        // entry cannot expand into multiple reviewers.
        if (/[,\s]/.test(rv)) {
          throw new Error(
            `${label} must not contain commas or whitespace (got ${JSON.stringify(rv)}). ` +
              `Pass each reviewer as a separate array element.`,
          );
        }
      };
      if (p.reviewers && p.reviewers.length) {
        for (const rv of p.reviewers) assertReviewer(rv, "reviewers[]");
        args.push(flagEq("--reviewers", p.reviewers.join(",")));
      }
      if (p.teamReviewers && p.teamReviewers.length) {
        for (const rv of p.teamReviewers) assertReviewer(rv, "teamReviewers[]");
        args.push(flagEq("--team-reviewers", p.teamReviewers.join(",")));
      }
      if (p.forcePush) args.push("--force");
      if (p.ignoreOutOfSyncTrunk) args.push("--ignore-out-of-sync-trunk");

      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      let f;
      try {
        // A dry-run does not mutate; an applied submit does.
        f = await ensureSuccess(label, r, p.cwd, { mutating: apply });
      } catch (e) {
        if (apply && descriptionByBranch.size) {
          await applyDescriptions(p.cwd, descriptionByBranch, overwriteDescriptions, signal, true).catch(() => undefined);
        }
        throw e;
      }

      const descriptionResults = apply
        ? await applyDescriptions(p.cwd, descriptionByBranch, overwriteDescriptions, signal, false)
        : [];
      const dryRunNote = !apply && requiredDescriptions.length
        ? `\n\n--- pr-description-preflight ---\nDescriptions required before apply:true: ${requiredDescriptions.join(", ")}`
        : "";
      const applyNote = descriptionResults.length
        ? `\n\n--- pr-description-updates ---\n${descriptionResults.map(renderDescriptionResult).join("\n")}`
        : "";

      return {
        content: [{ type: "text", text: renderText(label, f) + dryRunNote + applyNote }],
        details: {
          apply,
          result: f,
          prDescriptionPreflight: preflight.map((x) => ({
            branch: x.branch,
            exists: x.exists,
            number: x.number,
            bodyEmpty: !x.body?.trim(),
          })),
          requiredDescriptions,
          descriptionUpdates: descriptionResults,
        },
      };
    },
  });
}

function normalizeDescriptions(inputs: PrDescriptionInput[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const d of inputs) {
    const branch = assertSafeRef(d.branch, "descriptions[].branch");
    if (m.has(branch)) {
      throw new Error(`Duplicate PR description for branch ${branch}.`);
    }
    if (!d.body.trim()) {
      throw new Error(`PR description for branch ${branch} must be non-empty.`);
    }
    m.set(branch, d.body);
  }
  return m;
}

async function stackBranches(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const [trunkResult, logResult] = await Promise.all([
    runGt(["trunk"], { cwd, signal }),
    runGt(["log", "--stack"], { cwd, signal }),
  ]);
  assertCommandOk("gt trunk", trunkResult);
  assertCommandOk("gt log --stack", logResult);

  const trunk = trunkResult.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .pop();

  const branches: string[] = [];
  const seen = new Set<string>();
  for (const line of logResult.stdout.split("\n")) {
    const m = line.match(/^[\s│]*[◉○◯●]\s+([^\s()]+)/u);
    if (!m) continue;
    const branch = m[1];
    if (branch === trunk || seen.has(branch)) continue;
    seen.add(branch);
    branches.push(branch);
  }
  return branches;
}

async function inspectPrs(cwd: string, branches: string[], signal?: AbortSignal): Promise<PrInfo[]> {
  const out: PrInfo[] = [];
  for (const branch of branches) {
    const r = await runGh([
      "pr",
      "view",
      branch,
      "--json",
      "number,body,headRefName",
    ], { cwd, signal });
    if (r.exitCode === 0 && !r.timedOut && !r.spawnError) {
      let parsed: { number?: number; body?: string | null } = {};
      try {
        parsed = JSON.parse(r.stdout || "{}");
      } catch (e) {
        throw new Error(`Failed to parse gh pr view JSON for ${branch}: ${(e as Error).message}`);
      }
      out.push({
        branch,
        number: parsed.number,
        body: parsed.body ?? "",
        exists: true,
      });
      continue;
    }
    const text = `${r.stdout}\n${r.stderr}`;
    if (NO_PR_RE.test(text)) {
      out.push({ branch, exists: false });
      continue;
    }
    assertCommandOk(`gh pr view ${branch}`, r);
  }
  return out;
}

function requiredDescriptionBranches(prs: PrInfo[], updateOnly: boolean): string[] {
  return prs
    .filter((pr) => {
      if (pr.exists) return !pr.body?.trim();
      return !updateOnly;
    })
    .map((pr) => pr.branch);
}

async function applyDescriptions(
  cwd: string,
  descriptionByBranch: Map<string, string>,
  overwrite: boolean,
  signal: AbortSignal | undefined,
  allowMissingPr: boolean,
): Promise<DescriptionApplyResult[]> {
  const results: DescriptionApplyResult[] = [];
  for (const [branch, body] of descriptionByBranch) {
    const info = (await inspectPrs(cwd, [branch], signal))[0];
    if (!info?.exists) {
      if (allowMissingPr) {
        results.push({ branch, action: "missing_pr" });
        continue;
      }
      throw new Error(`PR for branch ${branch} not found after submit; cannot set description.`);
    }
    if (info.body?.trim() && !overwrite) {
      results.push({ branch, action: "skipped_existing_body", number: info.number });
      continue;
    }

    const dir = await mkdtemp(join(tmpdir(), "pi-graphite-pr-body-"));
    const bodyFile = join(dir, "body.md");
    try {
      await writeFile(bodyFile, body, "utf8");
      const edit = await runGh(["pr", "edit", branch, "--body-file", bodyFile], { cwd, signal });
      assertCommandOk(`gh pr edit ${branch} --body-file <tmp>`, edit);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const verify = (await inspectPrs(cwd, [branch], signal))[0];
    if (!verify?.body?.trim()) {
      throw new Error(`PR description verification failed for ${branch}: body is still empty.`);
    }
    results.push({ branch, action: "set", number: verify.number });
  }
  return results;
}

function assertCommandOk(label: string, r: GtRunResult): void {
  if (r.exitCode === 0 && !r.timedOut && !r.spawnError) return;
  const lines = [`[${label}] fail`];
  lines.push(`$ ${r.command} ${shellJoin(r.args)}`);
  lines.push(
    `# cwd=${r.cwd}  exit=${r.exitCode}${r.timedOut ? "  (aborted)" : ""}${
      r.spawnError ? `  (spawn-error: ${r.spawnError})` : ""
    }`,
  );
  if (r.stdout.trim()) {
    lines.push("--- stdout ---");
    lines.push(r.stdout.replace(/\s+$/, ""));
  }
  if (r.stderr.trim()) {
    lines.push("--- stderr ---");
    lines.push(r.stderr.replace(/\s+$/, ""));
  }
  throw new Error(lines.join("\n"));
}

function renderDescriptionResult(r: DescriptionApplyResult): string {
  const pr = r.number ? ` (#${r.number})` : "";
  switch (r.action) {
    case "set":
      return `${r.branch}${pr}: description set + verified`;
    case "skipped_existing_body":
      return `${r.branch}${pr}: existing description preserved`;
    case "missing_pr":
      return `${r.branch}: PR missing after failed submit; skipped description update`;
  }
}
