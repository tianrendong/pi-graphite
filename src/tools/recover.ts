import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  killProcessGroup,
  runGt,
  safeNoninteractiveEnv,
} from "../lib/exec";
import { shellJoin } from "../lib/argv";
import { ensureSuccess, renderText } from "../lib/result";
import { CwdParam, StringEnum, Type, type ToolReturn } from "../lib/schema";

function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("git", args, {
        cwd,
        env: safeNoninteractiveEnv(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolve({ exitCode: -1, stdout: "", stderr: (e as Error).message });
      return;
    }
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
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
      resolve({
        exitCode: killed ? -1 : (code ?? -1),
        stdout: out,
        stderr: err,
      });
    });
  });
}

async function findUnresolvedConflictMarkers(
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const r = await runGit(["grep", "-l", "-E", "^<{7} "], cwd, signal);
  if (r.exitCode > 1) return [];
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/**
 * graphite_recover — `gt continue` / `gt abort` / `gt undo`.
 *
 * After a conflict during sync/restack/create/modify, resolve the files
 * (and `git add` them), then call action=continue. Never use
 * `git rebase --continue` — Graphite needs to propagate the resolution to
 * dependent branches.
 */
export function registerRecover(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_recover",
    label: "Graphite: recover",
    description:
      "Recover or repair Graphite stack state: continue (resume a paused gt command after resolving conflicts), abort (cancel the in-flight operation), undo (revert the most recent gt mutation in this worktree), or restack (rebase the current stack so each branch sits on its parent's latest commit). Always prefer this over `git rebase --continue`.",
    promptSnippet:
      "graphite_recover: continue / abort / undo / restack — never use `git rebase --continue`",
    promptGuidelines: [
      "After resolving a rebase or cherry-pick conflict from a gt command, call graphite_recover action=continue (not `git rebase --continue`) so Graphite propagates the fix to dependent branches.",
      "graphite_recover action=undo only undoes commands run from the current worktree.",
      "Use graphite_recover action=restack when graphite_status reports branches out of date with their parent but no remote pull is needed; use graphite_sync when trunk itself may have moved.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["continue", "abort", "undo", "restack"] as const),
      stageAll: Type.Optional(
        Type.Boolean({
          description: "action=continue: stage all changes first (--all).",
        }),
      ),
      allowConflictMarkers: Type.Optional(
        Type.Boolean({
          description:
            "action=continue: bypass the pre-flight check that refuses to continue when tracked files still contain `<<<<<<<` markers. Default false.",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({
          description: "action=abort|undo: skip confirmation (--force).",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      let args: string[];
      switch (p.action) {
        case "continue": {
          if (!p.allowConflictMarkers) {
            const dirty = await findUnresolvedConflictMarkers(p.cwd, signal);
            if (dirty.length) {
              throw new Error(
                `graphite_recover: refusing to continue — ${dirty.length} tracked file(s) still contain conflict markers (\`<<<<<<<\`):\n` +
                  dirty.map((f) => `  - ${f}`).join("\n") +
                  `\n\nResolve each file, then re-run. If markers are intentional, pass allowConflictMarkers:true.`,
              );
            }
          }
          args = ["continue"];
          if (p.stageAll) args.push("--all");
          break;
        }
        case "abort":
          args = ["abort"];
          if (p.force) args.push("--force");
          break;
        case "undo":
          args = ["undo"];
          if (p.force) args.push("--force");
          break;
        case "restack":
          args = ["restack"];
          break;
      }
      const label = `gt ${shellJoin(args)}`;
      const r = await runGt(args, { cwd: p.cwd, signal });
      const f = await ensureSuccess(label, r, p.cwd, { mutating: true });
      return {
        content: [{ type: "text", text: renderText(label, f) }],
        details: { action: p.action, result: f },
      };
    },
  });
}
