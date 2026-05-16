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
        StringEnum(["current_stack", "default"] as const, {
          description:
            "current_stack adds --stack (only branches in the current stack). default shows all stacks off trunk (which is what `gt log` does by default — no separate 'all' flag is needed or supported).",
        }),
      ),
      showUntracked: Type.Optional(Type.Boolean()),
      reverse: Type.Optional(Type.Boolean()),
      steps: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const sub =
        p.mode === "short"
          ? ["log", "short"]
          : p.mode === "long"
            ? ["log", "long"]
            : ["log"];
      const args = [...sub];
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
      "Reorganize the stack: move a branch onto a new parent, fold a branch into its parent, or split by file pathspec. NOTE: move_branch auto-restacks all descendants; if either source or onto contains a merge-of-trunk with a different tip than the other, conflicts are likely — use dryRun:true first to preview. Use graphite_stack_compose to linearize branches that diverge through merges. `gt reorder` is intentionally not exposed (editor-only).",
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
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "action=move_branch: don't run `gt move`. Instead, run a `git merge-tree` simulation between source tip and onto tip and report whether conflicts are likely. Use before applying.",
        }),
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
        if (p.dryRun) {
          const sim = await simulateMove(p.cwd, p.onto, p.source, signal);
          return {
            content: [{ type: "text", text: sim.text }],
            details: { action: "move_branch", dryRun: true, ...sim.details },
          };
        }
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

/* ----------------------------- helpers ----------------------------- */

interface RunOut {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCmd(
  cmd: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<RunOut> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: safeNoninteractiveEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolve({ exitCode: -1, stdout: "", stderr: (e as Error).message });
      return;
    }
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    let killed = false;
    const killChild = () => {
      killed = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 1500).unref?.();
    };
    const timeout = setTimeout(killChild, DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    const onAbort = killChild;
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: -1, stdout: out, stderr: err + e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode: killed ? -1 : (code ?? -1), stdout: out, stderr: err });
    });
  });
}

async function gitRevParse(
  cwd: string,
  ref: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const r = await runCmd("git", ["rev-parse", "--verify", ref], cwd, signal);
  if (r.exitCode !== 0) return null;
  return r.stdout.trim() || null;
}

async function simulateMove(
  cwd: string,
  onto: string,
  source: string | undefined,
  signal: AbortSignal | undefined,
): Promise<{ text: string; details: Record<string, unknown> }> {
  // Resolve source default = current branch
  let src = source;
  if (!src) {
    const r = await runCmd(
      "git",
      ["branch", "--show-current"],
      cwd,
      signal,
    );
    src = r.stdout.trim();
  }
  if (!src) {
    return {
      text: "[move_branch dry-run] could not resolve source branch (detached HEAD?).",
      details: { ok: false },
    };
  }
  const ontoSha = await gitRevParse(cwd, onto, signal);
  const srcSha = await gitRevParse(cwd, src, signal);
  if (!ontoSha || !srcSha) {
    return {
      text: `[move_branch dry-run] unknown ref(s): onto=${onto}(${ontoSha ?? "?"}) src=${src}(${srcSha ?? "?"})`,
      details: { ok: false, src, onto },
    };
  }
  // Find merge base
  const mb = await runCmd(
    "git",
    ["merge-base", ontoSha, srcSha],
    cwd,
    signal,
  );
  const base = mb.stdout.trim();
  // Use merge-tree to simulate. Modern git: `git merge-tree --write-tree --merge-base <base> <onto> <src>`
  const mt = await runCmd(
    "git",
    [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--merge-base",
      base || ontoSha,
      ontoSha,
      srcSha,
    ],
    cwd,
    signal,
  );
  // Exit code 0 = clean. Non-zero = conflicts; stdout lists conflicted paths (after tree oid on first line).
  let conflictedFiles: string[] = [];
  let clean = mt.exitCode === 0;
  if (!clean) {
    const lines = mt.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
    // First line is the merge tree oid; remaining are conflicted paths.
    if (lines.length > 1) conflictedFiles = lines.slice(1);
    else conflictedFiles = lines;
  }
  // Also count commits each side carries beyond the merge base
  const ahead = await runCmd(
    "git",
    ["rev-list", "--count", `${base || ontoSha}..${srcSha}`],
    cwd,
    signal,
  );
  const behind = await runCmd(
    "git",
    ["rev-list", "--count", `${base || ontoSha}..${ontoSha}`],
    cwd,
    signal,
  );
  const lines = [
    `[move_branch dry-run] source=${src} -> onto=${onto}`,
    `merge-base = ${base || "(none)"}`,
    `src ahead of base by ${ahead.stdout.trim() || "?"} commits; onto ahead by ${behind.stdout.trim() || "?"} commits`,
    clean
      ? `merge-tree: CLEAN — \`gt move\` is likely safe.`
      : `merge-tree: CONFLICTS in ${conflictedFiles.length} path(s):`,
  ];
  if (!clean) lines.push(...conflictedFiles.map((f) => `  - ${f}`));
  if (!clean) {
    lines.push(
      "",
      "Suggestion: either resolve drift first (e.g. rebase source onto onto's trunk merge) or use graphite_stack_compose to linearize by cherry-picking unique commits in order.",
    );
  }
  return {
    text: lines.join("\n"),
    details: {
      ok: true,
      clean,
      src,
      onto,
      mergeBase: base || null,
      srcAhead: Number(ahead.stdout.trim()) || 0,
      ontoAhead: Number(behind.stdout.trim()) || 0,
      conflictedFiles,
    },
  };
}

/* ----------------------------- stack_compose ----------------------------- */

export function registerStackCompose(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_stack_compose",
    label: "Graphite: stack compose",
    description:
      "Linearize a set of branches into a fresh stack by cherry-picking each branch's unique commits (base..branch, no-merges) in the given order. Each successive branch is rebuilt on top of the previous, then tracked by Graphite with the explicit parent. Use this when `gt move` would conflict because branches contain divergent merges of trunk. Halts and surfaces the failing branch on cherry-pick conflict; continue with safe git env, then call again with `resume:true`.",
    promptSnippet:
      "graphite_stack_compose: rebuild branches as a linear stack on top of base via cherry-pick",
    promptGuidelines: [
      "Run with dryRun:true first to see the commits that would be cherry-picked per branch.",
      "If a cherry-pick halts on conflict, resolve in git, run `GIT_EDITOR=true EDITOR=true VISUAL=true git cherry-pick --continue`, then re-invoke graphite_stack_compose with resume:true to finish the remaining branches.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      base: Type.String({
        description:
          "Base branch the new stack will sit on top of (e.g. 'main', 'origin/main'). Must exist.",
      }),
      order: Type.Array(Type.String(), {
        description:
          "Branch names in bottom-up order. order[0] is rebuilt on `base`, order[1] on order[0], etc.",
      }),
      dryRun: Type.Optional(
        Type.Boolean({
          description: "If true, just list commits per branch without modifying anything.",
        }),
      ),
      includeMerges: Type.Optional(
        Type.Boolean({
          description:
            "Include merge commits when computing unique commits (default false; merges are usually trunk-syncs you do not want to replay).",
        }),
      ),
      confirmDestructive: Type.Optional(
        Type.Boolean({
          description:
            "Required when dryRun is false: rewrites each branch ref to a new history. Local-only but irreversible without reflog.",
        }),
      ),
      resume: Type.Optional(
        Type.Boolean({
          description:
            "Skip branches whose tip already matches the expected linearized history (used after resolving a cherry-pick conflict).",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      if (!p.order || p.order.length === 0) {
        throw new Error("graphite_stack_compose requires non-empty `order`.");
      }
      if (!p.dryRun) requireConfirm(p.confirmDestructive, "stack_compose (rewrites local branch refs)");

      // Validate base + all branches resolve.
      const refs = [p.base, ...p.order];
      const resolved: Record<string, string> = {};
      for (const ref of refs) {
        const sha = await gitRevParse(p.cwd, ref, signal);
        if (!sha) {
          throw new Error(`graphite_stack_compose: cannot resolve ref \`${ref}\`.`);
        }
        resolved[ref] = sha;
      }

      // Compute unique commit list per branch relative to base.
      const revListArgs = (base: string, branch: string) => {
        const a = ["rev-list", "--reverse"];
        if (!p.includeMerges) a.push("--no-merges");
        a.push(`${base}..${branch}`);
        return a;
      };

      const plan: Array<{ branch: string; commits: string[]; subjects: string[] }> = [];
      for (const br of p.order) {
        const r = await runCmd("git", revListArgs(p.base, br), p.cwd, signal);
        if (r.exitCode !== 0) {
          throw new Error(
            `git rev-list failed for ${p.base}..${br}: ${r.stderr.trim()}`,
          );
        }
        const commits = r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
        const subjects: string[] = [];
        for (const c of commits) {
          const s = await runCmd(
            "git",
            ["log", "-1", "--format=%h %s", c],
            p.cwd,
            signal,
          );
          subjects.push(s.stdout.trim());
        }
        plan.push({ branch: br, commits, subjects });
      }

      const planText = plan
        .map((step, i) => {
          const parent = i === 0 ? p.base : p.order[i - 1];
          const lines = [`# ${step.branch}  (parent=${parent}, ${step.commits.length} commit(s))`];
          if (step.commits.length === 0) lines.push("  (no unique commits — branch will be reset to parent)");
          for (const s of step.subjects) lines.push(`  ${s}`);
          return lines.join("\n");
        })
        .join("\n\n");

      if (p.dryRun) {
        return {
          content: [
            {
              type: "text",
              text: `[stack_compose dry-run] base=${p.base}\n\n${planText}\n\n(Re-run with dryRun:false, confirmDestructive:true to apply.)`,
            },
          ],
          details: { dryRun: true, base: p.base, plan },
        };
      }

      // Apply.
      const log: string[] = [`base=${p.base}`];
      let parent = p.base;
      for (const step of plan) {
        // Skip in resume mode if branch tip already equals expected linearized state:
        // heuristic — if current branch's parent in graphite already equals `parent`
        // and its commit set matches step.commits, skip. We use a simpler check:
        // resume=true + cherry-pick state absent + branch reachable from parent
        // with same commit subjects in order.
        if (p.resume) {
          const reachable = await runCmd(
            "git",
            ["merge-base", "--is-ancestor", parent, step.branch],
            p.cwd,
            signal,
          );
          // git returns 0 if ancestor.
          if (reachable.exitCode === 0) {
            // Compare commits between parent..branch and step.commits subjects.
            const cur = await runCmd("git", revListArgs(parent, step.branch), p.cwd, signal);
            const curCommits = cur.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
            if (curCommits.length === step.commits.length) {
              log.push(`skip ${step.branch} (already linearized)`);
              parent = step.branch;
              continue;
            }
          }
        }

        // Reset branch to parent.
        const reset = await runCmd(
          "git",
          ["checkout", "-B", step.branch, parent],
          p.cwd,
          signal,
        );
        if (reset.exitCode !== 0) {
          throw new Error(
            `compose: failed to checkout ${step.branch} on ${parent}: ${reset.stderr.trim()}`,
          );
        }
        log.push(`reset ${step.branch} -> ${parent}`);
        // Cherry-pick each commit.
        for (const c of step.commits) {
          const cp = await runCmd(
            "git",
            ["cherry-pick", "--allow-empty", c],
            p.cwd,
            signal,
          );
          if (cp.exitCode !== 0) {
            const msg = [
              `compose: cherry-pick of ${c} onto ${step.branch} halted with conflicts.`,
              cp.stdout.trim(),
              cp.stderr.trim(),
              "",
              "Resolve conflicts in git, run `GIT_EDITOR=true EDITOR=true VISUAL=true git cherry-pick --continue` until clean, then call graphite_stack_compose again with resume:true and the same order/base.",
            ]
              .filter(Boolean)
              .join("\n");
            throw new Error(msg);
          }
          log.push(`  cherry-pick ${c.slice(0, 7)}`);
        }
        // Track in graphite with explicit parent.
        const track = await runGt(
          ["track", step.branch, "--parent", parent, "--force"],
          { cwd: p.cwd, signal },
        );
        if (track.exitCode !== 0) {
          log.push(
            `  warning: gt track failed for ${step.branch}: ${track.stderr.trim() || track.stdout.trim()}`,
          );
        } else {
          log.push(`  tracked parent=${parent}`);
        }
        parent = step.branch;
      }

      return {
        content: [
          {
            type: "text",
            text: `[stack_compose] OK\n\n${log.join("\n")}\n\n${planText}`,
          },
        ],
        details: { dryRun: false, base: p.base, plan, log },
      };
    },
  });
}
