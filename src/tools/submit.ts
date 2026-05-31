import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, flagEq, shellJoin } from "../lib/argv";
import { ensureSuccess, renderText } from "../lib/result";
import {
  CwdParam,
  Type,
  requireConfirm,
  type ToolReturn,
} from "../lib/schema";

/**
 * graphite_submit — the only blessed submit path.
 *
 * Wraps `gt submit --stack --no-edit --no-ai`. Defaults to --dry-run so the
 * caller can review the plan. Actually pushing requires `apply:true` AND
 * `confirmRemote:true`.
 *
 * No PR title/body fields, no editor, no browser, no gh, no
 * current-branch-only submit. The skill calls out that the correct workflow
 * is always to submit the entire stack.
 */
export function registerSubmit(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_submit",
    label: "Graphite: submit stack",
    description:
      "Push the entire current stack and create/update PRs via `gt submit --stack --no-edit`. Defaults to a dry-run plan; pass apply:true with confirmRemote:true to actually push. PR title/body editing is intentionally not exposed.",
    promptSnippet:
      "graphite_submit: plan or apply `gt submit --stack` for the full stack",
    promptGuidelines: [
      "Always call graphite_submit with apply:false (default) first to review the dry-run plan, then call again with apply:true and confirmRemote:true to actually push.",
      "This extension does not edit PR titles/bodies. If you need to set them, do it outside this extension after the push.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      apply: Type.Optional(
        Type.Boolean({
          description:
            "false => --dry-run (default). true => actually push (requires confirmRemote).",
        }),
      ),
      confirmRemote: Type.Optional(Type.Boolean()),
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
      // A dry-run does not mutate; an applied submit does.
      const f = await ensureSuccess(label, r, p.cwd, { mutating: apply });
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { apply, result: f },
      };
    },
  });
}
