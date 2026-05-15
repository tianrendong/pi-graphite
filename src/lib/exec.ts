import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { resolve as resolvePath } from "node:path";

export interface GtRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Extra env vars merged into process.env */
  env?: Record<string, string>;
}

export interface GtRunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/**
 * Replace Graphite's internal product name "Charcoal" with "Graphite" so
 * users and the LLM see a consistent product name. Casing is preserved.
 */
export function sanitizeBranding(s: string): string {
  return s.replace(/charcoal/gi, (m) => (m[0] === m[0].toUpperCase() ? "Graphite" : "graphite"));
}

export function truncateOutput(s: string): string {
  if (s.length <= MAX_BYTES) {
    const lines = s.split("\n");
    if (lines.length <= MAX_LINES) return s;
    const kept = lines.slice(0, MAX_LINES).join("\n");
    return `${kept}\n... [truncated: ${lines.length - MAX_LINES} more lines]`;
  }
  const kept = s.slice(0, MAX_BYTES);
  return `${kept}\n... [truncated: ${s.length - MAX_BYTES} more bytes]`;
}

/**
 * Run `gt` with structured args. Never builds a shell string.
 *
 * - Always injects --cwd <abs>.
 * - Always injects --no-interactive. No escape hatch by design: agent-driven
 *   tools must never block on a TTY prompt.
 * - Does not inject --quiet (we want stderr diagnostics).
 */
export async function runGt(
  rawArgs: string[],
  opts: GtRunOptions,
): Promise<GtRunResult> {
  const cwd = resolvePath(opts.cwd);
  const args = ["--cwd", cwd, "--no-interactive"];
  args.push(...rawArgs);

  return new Promise<GtRunResult>((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("gt", args, {
        cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        command: "gt",
        args,
        cwd,
        exitCode: -1,
        stdout: "",
        stderr: "",
        timedOut: false,
        spawnError: (e as Error).message,
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let killed = false;

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > MAX_BYTES * 4) stdout = stdout.slice(-MAX_BYTES * 2);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > MAX_BYTES * 4) stderr = stderr.slice(-MAX_BYTES * 2);
    });

    const onAbort = () => {
      killed = true;
      try {
        child.kill("SIGTERM");
        setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {}
        }, 1500).unref?.();
      } catch {}
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (err) => {
      resolve({
        command: "gt",
        args,
        cwd,
        exitCode: -1,
        stdout: sanitizeBranding(stripAnsi(stdout)),
        stderr: sanitizeBranding(stripAnsi(stderr)),
        timedOut: false,
        spawnError: err.message,
      });
    });

    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        command: "gt",
        args,
        cwd,
        exitCode: code ?? -1,
        stdout: truncateOutput(sanitizeBranding(stripAnsi(stdout))),
        stderr: truncateOutput(sanitizeBranding(stripAnsi(stderr))),
        timedOut: killed,
      });
    });
  });
}
