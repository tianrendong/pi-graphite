import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMMAND_TIMEOUT_MS, killProcessGroup, runGt, safeNoninteractiveEnv } from "../lib/exec";
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
      resolve({ exitCode: killed ? -1 : (code ?? -1), stdout: out, stderr: err });
    });
  });
}

/** Return list of tracked files that still contain conflict markers. */
async function findUnresolvedConflictMarkers(
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  // grep for the canonical 7-char start marker at line start across tracked files.
  // `git grep` is cheap and respects gitignore / tracked-only by default.
  const r = await runGit(
    ["grep", "-l", "-E", "^<{7} "],
    cwd,
    signal,
  );
  if (r.exitCode > 1) return []; // git grep returns 1 for no matches, >1 is real error
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function registerRecovery(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_recovery",
    label: "Graphite: recovery",
    description:
      "Recover from conflicts or mistakes: continue a halted command, abort it, or undo the most recent Graphite mutation in this worktree.",
    promptSnippet:
      "graphite_recovery: continue / abort / undo Graphite commands",
    promptGuidelines: [
      "After resolving a rebase conflict, run graphite_recovery action=continue to resume the original gt command.",
      "graphite_recovery action=undo only undoes commands run from the current worktree.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      action: StringEnum(["continue", "abort", "undo"] as const),
      stageAll: Type.Optional(
        Type.Boolean({ description: "action=continue: stage all changes first (--all)." }),
      ),
      allowConflictMarkers: Type.Optional(
        Type.Boolean({
          description:
            "action=continue: bypass the pre-flight check that refuses to continue when tracked files still contain `<<<<<<<` conflict markers. Default false. Only set true if you know the markers are intentional (e.g. tests).",
        }),
      ),
      force: Type.Optional(
        Type.Boolean({ description: "action=abort|undo: skip confirmation prompt (--force)." }),
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
                `graphite_recovery: refusing to continue — ${dirty.length} tracked file(s) still contain conflict markers (\`<<<<<<<\`):\n` +
                  dirty.map((f) => `  - ${f}`).join("\n") +
                  `\n\nResolve each file (remove <<<<<<< / ======= / >>>>>>> blocks), then re-run. ` +
                  `If markers are intentional, pass allowConflictMarkers:true.`,
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
