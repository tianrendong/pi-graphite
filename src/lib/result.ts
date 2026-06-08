import { spawn } from "node:child_process";
import { shellJoin } from "./argv";
import { DEFAULT_COMMAND_TIMEOUT_MS, killProcessGroup, runGt, safeNoninteractiveEnv, type GtRunResult } from "./exec";

/**
 * Structured failure hints. Only populated when the underlying `gt` command
 * exited non-zero. Never inferred from successful output.
 */
export interface GtHints {
  notInGitRepo?: boolean;
  notInitialized?: boolean;
  notAuthenticated?: boolean;
  conflictHalted?: boolean;
  checkedOutElsewhere?: { branch?: string; worktree?: string };
  restackNeeded?: boolean;
  trunkOutOfSync?: boolean;
  branchNotTracked?: boolean;
  noChangesStaged?: boolean;
  prMissing?: boolean;
  operatingOnTrunk?: boolean;
  invalidArgument?: string;
  /** exit 0 but stdout empty when output was expected (e.g. status). */
  emptyOutput?: boolean;
}

/**
 * Non-fatal warnings parsed from BOTH stdout and stderr regardless of exit
 * code. gt frequently exits 0 while skipping branches or noting that a
 * branch changed remotely / already merged; surfacing these keeps the agent
 * from trusting a misleadingly "ok" result.
 */
export interface GtWarnings {
  skippedBranches?: boolean;
  remoteChanged?: boolean;
  alreadyMerged?: boolean;
  needsRestack?: boolean;
}

const WARNING_PATTERNS: Array<[keyof GtWarnings, RegExp]> = [
  [
    "skippedBranches",
    /\b(?:skipp(?:ing|ed)\s+(?:branch(?:es)?\b|[^\n]*\bbranch\b)|branches?\s+(?:were\s+)?skipped|skipped\s+\d+\s+branches?)\b/i,
  ],
  ["remoteChanged", /updated\s+remotely|changed\s+on\s+remote|newer\s+(?:commit|version)\s+(?:on|exists)|diverged\s+from\s+remote/i],
  ["alreadyMerged", /already\s+(?:been\s+)?merged|has\s+been\s+merged|closed\s+remotely/i],
  // Negative lookbehind avoids matching "does not need to be restacked".
  ["needsRestack", /(?<!not\s)needs?\s+(?:to\s+be\s+)?restack|run\s+`?gt\s+restack`?|out\s+of\s+date\s+with\s+(?:its\s+)?parent/i],
];

function stripNonWarningPromptSkips(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      // `gt submit --no-edit --no-interactive` can report skipped inline
      // prompts. That is expected non-interactive behavior, not skipped
      // branch work. Drop those lines before warning detection.
      if (/(?:inline\s+)?prompts?.*\bskipp(?:ed|ing)\b/i.test(line)) return false;
      if (/\bskipp(?:ed|ing)\b.*(?:inline\s+)?prompts?/i.test(line)) return false;
      if (/\bskipp(?:ed|ing)\b.*\bprompt(?:s)?\b/i.test(line)) return false;
      return true;
    })
    .join("\n");
}

function parseWarnings(r: GtRunResult): GtWarnings {
  const rawText = `${r.stdout}\n${r.stderr}`;
  const text = stripNonWarningPromptSkips(rawText);
  const w: GtWarnings = {};
  // A help/usage dump is full of command descriptions, not real warnings.
  if (looksLikeUsageDump(text)) return w;
  for (const [key, re] of WARNING_PATTERNS) {
    if (re.test(text)) (w as Record<string, unknown>)[key] = true;
  }
  return w;
}

// Patterns run only on failure text.
const PATTERNS: Array<[Exclude<keyof GtHints, "checkedOutElsewhere" | "invalidArgument">, RegExp]> = [
  [
    "notInGitRepo",
    /(?:fatal|ERROR)[^\n]*not\s+(?:a|in a)\s+git\s+repository|No \.git repository found/i,
  ],
  [
    "notInitialized",
    // Output is sanitized before hint parsing, so Charcoal is replaced with
    // Graphite. We still allow the original spelling defensively in case the
    // sanitizer is bypassed.
    /Graphite has not been initialized|Charcoal has not been initialized|graphite is not (?:yet )?initialized|run\s+`?gt\s+init`?/i,
  ],
  [
    "notAuthenticated",
    /Run\s+`?gt\s+auth`?|invalid auth token|unauthorized|please log in|missing auth token/i,
  ],
  [
    "conflictHalted",
    /merge\s+conflict|rebase\s+conflict|halted\s+by|run\s+`?gt\s+continue`?|gt\s+abort/i,
  ],
  [
    "restackNeeded",
    /needs?\s+to\s+be\s+restacked|run\s+`?gt\s+restack`?|stack\s+is\s+out\s+of\s+date/i,
  ],
  [
    "trunkOutOfSync",
    /trunk\s+is\s+out\s+of\s+sync|--ignore-out-of-sync-trunk/i,
  ],
  [
    "branchNotTracked",
    /not\s+tracked\s+by\s+graphite|on\s+(?:an\s+)?untracked\s+branch|Cannot perform this operation on (?:an\s+)?untracked/i,
  ],
  [
    "noChangesStaged",
    /no\s+(?:staged\s+)?changes\s+to\s+(?:commit|amend)/i,
  ],
  [
    "prMissing",
    /no\s+pull\s+request|PR\s+not\s+found|branch\s+has\s+no\s+associated\s+pull\s+request/i,
  ],
  [
    "operatingOnTrunk",
    /Cannot perform this operation on the trunk branch/i,
  ],
];

/**
 * gt dumps its full usage/help (Commands:/Options: blocks) on an unknown
 * argument. Those command descriptions contain phrases ("halted by a rebase
 * conflict", "restack", …) that would otherwise trigger false-positive
 * hints. Detect the dump so we can suppress content-derived hints and keep
 * only the invalidArgument signal.
 */
function looksLikeUsageDump(text: string): boolean {
  return /\n\s*Commands:\s*\n/i.test(text) && /\n\s*Options:\s*\n/i.test(text);
}

function parseHints(r: GtRunResult): GtHints {
  const text = `${r.stdout}\n${r.stderr}`;
  const hints: GtHints = {};

  // Match both singular and plural ("Unknown argument(s):").
  const invalid = text.match(/Unknown arguments?:\s*([^\n]+)/i);
  if (invalid) hints.invalidArgument = invalid[1].trim();

  // When gt printed its help dump, the only trustworthy signal is the
  // unknown-argument line; everything else is description text.
  if (looksLikeUsageDump(text)) return hints;

  for (const [key, re] of PATTERNS) {
    if (re.test(text)) (hints as Record<string, unknown>)[key] = true;
  }
  if (/checked\s+out\s+in\s+(?:another|the)\s+worktree/i.test(text)) {
    const m = text.match(
      /branch\s+`?([^\s`'"]+)`?[^\n]*?checked\s+out\s+in[^\n]*?(\/[^\s)]+)?/i,
    );
    hints.checkedOutElsewhere = { branch: m?.[1], worktree: m?.[2] };
  }
  return hints;
}

export interface FormatOptions {
  /**
   * When true, an exit-0 result with empty stdout is treated as a FAILURE
   * (with an emptyOutput hint). Use for read commands that must produce
   * output, e.g. `gt log --stack` / `gt info`. Without this, gt silently
   * returning nothing would be reported as "ok" and blind the agent.
   */
  requireStdout?: boolean;
  /**
   * When true, a FAILURE appends a "partial side effects possible" note so
   * the agent knows the command may have mutated state before erroring
   * (e.g. `gt create` made a branch then hit a metadata lock). Set for any
   * command that can change local/remote state.
   */
  mutating?: boolean;
}

const PARTIAL_SIDE_EFFECTS_NOTE =
  "This command can mutate state, and it failed mid-flight: partial side effects are possible " +
  "(e.g. a created branch, partial restack, a metadata lock, or some PRs already pushed). " +
  "Run graphite_status to confirm the actual stack state before retrying.";

export interface FormattedResult {
  ok: boolean;
  isFailure: boolean;
  result: GtRunResult;
  /** Empty object on success. Populated only on failure. */
  hints: GtHints;
  /** Non-fatal warnings parsed on success AND failure. */
  warnings: GtWarnings;
  /** Recovery suggestion derived from hints + auxiliary probes. */
  suggestion?: string;
}

export function formatResult(r: GtRunResult, opts?: FormatOptions): FormattedResult {
  const hardFailure = r.exitCode !== 0 || r.timedOut || !!r.spawnError;
  const emptyOutput =
    !hardFailure && !!opts?.requireStdout && r.stdout.trim() === "";
  const isFailure = hardFailure || emptyOutput;
  const hints = isFailure ? parseHints(r) : {};
  if (emptyOutput) hints.emptyOutput = true;
  return {
    ok: !isFailure,
    isFailure,
    result: r,
    hints,
    warnings: parseWarnings(r),
  };
}

/** Render a formatted result into a single text block. */
export function renderText(label: string, f: FormattedResult): string {
  const r = f.result;
  const lines: string[] = [];
  lines.push(`$ gt ${shellJoin(r.args)}`);
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
  if (f.isFailure && Object.keys(f.hints).length) {
    lines.push("--- hints ---");
    lines.push(JSON.stringify(f.hints));
  }
  if (Object.keys(f.warnings).length) {
    lines.push("--- warnings ---");
    lines.push(JSON.stringify(f.warnings));
    lines.push(
      "gt reported success but the above conditions were detected in its output. " +
        "Verify the result (e.g. run graphite_status) before assuming the stack is in the expected state.",
    );
  }
  if (f.isFailure && f.suggestion) {
    lines.push("--- suggestion ---");
    lines.push(f.suggestion);
  }
  const status = f.ok
    ? Object.keys(f.warnings).length
      ? "ok (with warnings)"
      : "ok"
    : "fail";
  return `[${label}] ${status}\n${lines.join("\n")}`;
}

/* ----------------------- auxiliary probes (best-effort) ----------------------- */

function execText(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: safeNoninteractiveEnv(),
        stdio: ["ignore", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
    } catch {
      resolve("");
      return;
    }
    const timeout = setTimeout(() => {
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 1500).unref?.();
    }, DEFAULT_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 4096) out = out.slice(-4096);
    });
    child.on("error", () => {
      clearTimeout(timeout);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timeout);
      resolve(out);
    });
  });
}

async function detectCurrentBranch(cwd: string): Promise<string | undefined> {
  const t = (await execText("git", ["-C", cwd, "branch", "--show-current"], cwd)).trim();
  return t || undefined;
}

async function detectTrunk(cwd: string): Promise<string | undefined> {
  // Route through the hardened runner so cwd resolve, forbidden-token scan,
  // trailing --no-interactive injection, and env scrubbing all apply.
  const r = await runGt(["trunk"], { cwd }).catch(() => undefined);
  if (!r || r.exitCode !== 0) return undefined;
  const out = r.stdout;
  // gt trunk prints the trunk name on its own line. Take last non-empty line.
  const cleaned = out
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/charcoal/gi, (m) => (m[0] === m[0].toUpperCase() ? "Graphite" : "graphite"));
  const line = cleaned
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    // Skip Graphite banner / init lines so we keep the actual trunk name.
    .filter((s) => !/Graphite|Welcome/i.test(s) && !/initialized/i.test(s))
    .pop();
  return line || undefined;
}

/** Enrich a failed FormattedResult with an actionable suggestion. */
export async function enrichFailure(cwd: string, f: FormattedResult): Promise<void> {
  if (!f.isFailure) return;
  const parts: string[] = [];

  if (f.hints.branchNotTracked) {
    const [branch, trunk] = await Promise.all([
      detectCurrentBranch(cwd),
      detectTrunk(cwd),
    ]);
    const b = branch ?? "<current-branch>";
    const p = trunk ?? "<trunk>";
    parts.push(
      `Current branch (${b}) is not tracked by Graphite. To track it after verifying the intended parent, call: ` +
        `graphite_setup({ action: "track_branch", branch: "${b}", parent: "${p}", confirmParent: true }). ` +
        `Do not guess the parent if unclear; ask the user first.`,
    );
  }
  if (f.hints.notInitialized) {
    parts.push(
      `Graphite not initialized in this repo. Call: graphite_setup({ action: "init_repo", trunk: "<trunk-branch>" }).`,
    );
  }
  if (f.hints.conflictHalted) {
    parts.push(
      `A Graphite command is halted by a conflict. After resolving in git, call: ` +
        `graphite_recover({ action: "continue" }) (or "abort").`,
    );
  }
  if (f.hints.restackNeeded) {
    parts.push(`Stack is out of date. Call: graphite_sync() to sync and restack.`);
  }
  if (f.hints.trunkOutOfSync) {
    parts.push(
      `Trunk is out of sync with remote. Call: graphite_sync() first.`,
    );
  }
  if (f.hints.notAuthenticated) {
    parts.push(
      `Graphite is not authenticated. Run \`gt auth\` interactively or set GRAPHITE_AUTH_TOKEN.`,
    );
  }
  if (f.hints.checkedOutElsewhere) {
    const b = f.hints.checkedOutElsewhere.branch ?? "<branch>";
    parts.push(
      `Branch ${b} is checked out in another worktree. Switch to that worktree, or use ` +
        `switch to a different branch with graphite_navigate before mutating the stack.`,
    );
  }
  if (f.hints.invalidArgument) {
    parts.push(
      `gt rejected an unknown argument (${f.hints.invalidArgument}). The local gt version may not support this flag; remove it and retry.`,
    );
  }
  if (f.hints.operatingOnTrunk) {
    parts.push(
      `Operation refused on the trunk branch. Check out a non-trunk branch first with graphite_navigate.`,
    );
  }
  if (f.hints.emptyOutput) {
    parts.push(
      `gt exited 0 but produced no output where output was expected. This usually means the current branch is not tracked by Graphite, you are not in a Graphite-initialized repo, or the gt build short-circuited (do NOT set GRAPHITE_INTERACTIVE). ` +
        `Confirm with \`git -C <cwd> rev-parse --abbrev-ref HEAD\` and \`gt --version\`, and consider running graphite_setup. ` +
        `As a fallback you may run a read-only gt command directly (e.g. \`gt log --stack\`) with non-interactive flags.`,
    );
  }

  if (parts.length) f.suggestion = parts.join(" ");
}

/**
 * Format a GtRunResult; if it failed, enrich and throw an Error whose message
 * contains the rendered output plus the recovery suggestion. The thrown Error
 * makes the tool result `isError: true` so the agent sees a real failure.
 */
export async function ensureSuccess(
  label: string,
  r: GtRunResult,
  cwd: string,
  opts?: FormatOptions,
): Promise<FormattedResult> {
  const f = formatResult(r, opts);
  if (f.isFailure) {
    await enrichFailure(cwd, f);
    if (opts?.mutating) {
      f.suggestion = f.suggestion
        ? `${f.suggestion} ${PARTIAL_SIDE_EFFECTS_NOTE}`
        : PARTIAL_SIDE_EFFECTS_NOTE;
    }
    throw new Error(renderText(label, f));
  }
  return f;
}

/**
 * Run multiple gt calls and ensure all succeed. If any failed, enriches each
 * failed result and throws an Error containing every rendered block so the
 * agent sees the full picture, not just the first error.
 */
export async function ensureAllSuccess(
  items: Array<{ label: string; result: GtRunResult; requireStdout?: boolean }>,
  cwd: string,
): Promise<FormattedResult[]> {
  const formatted = items.map((i) => ({
    label: i.label,
    f: formatResult(i.result, { requireStdout: i.requireStdout }),
  }));
  const failed = formatted.filter((x) => x.f.isFailure);
  if (failed.length) {
    await Promise.all(failed.map((x) => enrichFailure(cwd, x.f)));
    const blocks = formatted.map((x) => renderText(x.label, x.f));
    throw new Error(blocks.join("\n\n"));
  }
  return formatted.map((x) => x.f);
}
