import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { resolve as resolvePath } from "node:path";

export interface GtRunOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Extra env vars merged into process.env. Safety vars always win. */
  env?: Record<string, string>;
  /** Hard timeout in ms. Default 120s. */
  timeoutMs?: number;
}

export interface GtRunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number;
  /** Output capped for the model (2000 lines / 50KB). Use {@link fullOutput} for parsing. */
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

/**
 * Uncapped output (up to SCRIPT_OUTPUT_MAX_CHARS), kept outside the result object so it never
 * lands in tool `details`, which pi persists to the session.
 */
const FULL_OUTPUT = new WeakMap<GtRunResult, { stdout: string; stderr: string }>();

/** Full stdout/stderr of a run, for parsing and for codemode scripts. */
export function fullOutput(r: GtRunResult): { stdout: string; stderr: string } {
  return FULL_OUTPUT.get(r) ?? { stdout: r.stdout, stderr: r.stderr };
}

const ANSI = /\x1b\[[0-9;]*[a-zA-Z]/g;
const MAX_BYTES = 50 * 1024;
const MAX_LINES = 2000;
/** Cap on output kept for parsing and scripts; past it the head and tail are kept. */
export const SCRIPT_OUTPUT_MAX_CHARS = 1024 * 1024;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

/** Env guardrails: disable editors, pagers, browsers. Must override caller env. */
export const SAFE_NONINTERACTIVE_ENV: Record<string, string> = {
  GT_EDITOR: "true",
  TEST_GT_EDITOR: "true",
  GIT_EDITOR: "true",
  EDITOR: "true",
  VISUAL: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GT_PAGER: "",
  GIT_PAGER: "cat",
  PAGER: "cat",
  LESS: "FRX",
  BROWSER: "true",
  GH_BROWSER: "true",
  // NOTE: we intentionally do NOT set GRAPHITE_INTERACTIVE here. Some gt
  // builds treat GRAPHITE_INTERACTIVE=1 as "invoked from Graphite Interactive"
  // and short-circuit read commands (`gt log --stack`, `gt info`) to exit 0
  // with EMPTY stdout — which made this extension blind while reporting
  // success. Non-interactive behavior is already enforced via the
  // --no-interactive argv guards in runGt() plus the editor/pager/browser
  // overrides above.
};

export function safeNoninteractiveEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(extra ?? {}),
    ...SAFE_NONINTERACTIVE_ENV,
  };
}

export function killProcessGroup(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }, signal: NodeJS.Signals): void {
  try {
    if (child.pid && process.platform !== "win32") {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {}
  try {
    child.kill(signal);
  } catch {}
}

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

/** Collects a stream, keeping the first and last half of SCRIPT_OUTPUT_MAX_CHARS when it overflows. */
class OutputCapture {
  private head = "";
  private tail = "";
  private dropped = 0;

  push(chunk: string): void {
    const half = SCRIPT_OUTPUT_MAX_CHARS / 2;
    if (this.head.length < half) {
      const room = half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    if (!chunk) return;
    const tail = this.tail + chunk;
    this.dropped += Math.max(0, tail.length - half);
    this.tail = tail.slice(-half);
  }

  text(): string {
    return this.dropped
      ? `${this.head}\n... [${this.dropped} chars omitted by pi-graphite] ...\n${this.tail}`
      : this.head + this.tail;
  }
}

/**
 * Tokens that re-enable interactive flows in gt and must never appear in
 * rawArgs. Tool authors should not pass these directly, and user-supplied
 * strings should be routed through argv helpers (assertSafeRef / flagEq)
 * so values starting with `-` can never reach this list. We still scan
 * defensively here as belt-and-braces.
 */
const FORBIDDEN_RAW_TOKENS = new Set<string>([
  "--interactive",
  "--interactive-rebase",
]);

/**
 * Run `gt` with structured args. Never builds a shell string.
 *
 * - Always injects --cwd <abs> and --no-interactive at the *start*.
 * - Also appends a trailing --no-interactive after rawArgs as defense in
 *   depth: yargs lets a later `--interactive` override an earlier
 *   `--no-interactive`, so we ensure --no-interactive is always the last
 *   word on the global option.
 * - Refuses to run if rawArgs contains a known interactive-toggle token.
 * - Does not inject --quiet (we want stderr diagnostics).
 */
async function runCommand(
  command: "gt" | "gh",
  args: string[],
  opts: GtRunOptions,
): Promise<GtRunResult> {
  const cwd = resolvePath(opts.cwd);
  const cleanOutput = (text: string) => {
    const plain = stripAnsi(text);
    // gh JSON contains user-authored PR bodies. Rebranding that data corrupts
    // body comparisons and can make a successful description update fail.
    return command === "gt" ? sanitizeBranding(plain) : plain;
  };
  return new Promise<GtRunResult>((resolve) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(command, args, {
        cwd,
        // Force any editor/pager/browser invocation to no-op instead of
        // hanging. Safety vars override opts.env by design.
        env: safeNoninteractiveEnv(opts.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (e) {
      resolve({
        command,
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

    const stdoutCapture = new OutputCapture();
    const stderrCapture = new OutputCapture();
    let killed = false;
    let settled = false;

    const killChild = () => {
      killed = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 1500).unref?.();
    };

    const timeout = setTimeout(killChild, opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout?.on("data", (d) => stdoutCapture.push(d.toString()));
    child.stderr?.on("data", (d) => stderrCapture.push(d.toString()));

    const onAbort = killChild;
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      opts.signal?.removeEventListener("abort", onAbort);
      const stdout = cleanOutput(stdoutCapture.text());
      const stderr = cleanOutput(stderrCapture.text());
      const result: GtRunResult = {
        command,
        args,
        cwd,
        exitCode,
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        timedOut: killed,
        ...(spawnError ? { spawnError } : {}),
      };
      FULL_OUTPUT.set(result, { stdout, stderr });
      resolve(result);
    };
    child.on("error", (err) => finish(-1, err.message));
    child.on("close", (code) => finish(code ?? -1));
  });
}

export async function runGt(
  rawArgs: string[],
  opts: GtRunOptions,
): Promise<GtRunResult> {
  const cwd = resolvePath(opts.cwd);
  for (const tok of rawArgs) {
    // Match both `--interactive` and `--interactive=...` forms.
    const head = tok.split("=", 1)[0];
    if (FORBIDDEN_RAW_TOKENS.has(head)) {
      throw new Error(
        `runGt: refused to pass forbidden token ${JSON.stringify(tok)} to gt. ` +
          `Interactive flows are disabled in this extension.`,
      );
    }
  }
  const args = ["--cwd", cwd, "--no-interactive"];
  args.push(...rawArgs);
  // Trailing --no-interactive wins against any later `--interactive` that
  // might still slip in via an unaudited code path.
  args.push("--no-interactive");

  return runCommand("gt", args, { ...opts, cwd });
}

export async function runGh(
  rawArgs: string[],
  opts: GtRunOptions,
): Promise<GtRunResult> {
  const cwd = resolvePath(opts.cwd);
  for (const tok of rawArgs) {
    if (tok === "--web" || tok.startsWith("--web=")) {
      throw new Error(
        `runGh: refused to pass forbidden token ${JSON.stringify(tok)} to gh. ` +
          `Browser flows are disabled in this extension.`,
      );
    }
  }
  return runCommand("gh", rawArgs, { ...opts, cwd });
}
