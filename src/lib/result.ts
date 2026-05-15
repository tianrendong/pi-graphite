import { spawn } from "node:child_process";
import type { GtRunResult } from "./exec";

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

function parseHints(r: GtRunResult): GtHints {
  const text = `${r.stdout}\n${r.stderr}`;
  const hints: GtHints = {};
  for (const [key, re] of PATTERNS) {
    if (re.test(text)) (hints as Record<string, unknown>)[key] = true;
  }
  if (/checked\s+out\s+in\s+(?:another|the)\s+worktree/i.test(text)) {
    const m = text.match(
      /branch\s+`?([^\s`'"]+)`?[^\n]*?checked\s+out\s+in[^\n]*?(\/[^\s)]+)?/i,
    );
    hints.checkedOutElsewhere = { branch: m?.[1], worktree: m?.[2] };
  }
  const invalid = text.match(/Unknown argument:\s*([^\n]+)/i);
  if (invalid) hints.invalidArgument = invalid[1].trim();
  return hints;
}

export interface FormattedResult {
  ok: boolean;
  isFailure: boolean;
  result: GtRunResult;
  /** Empty object on success. Populated only on failure. */
  hints: GtHints;
  /** Recovery suggestion derived from hints + auxiliary probes. */
  suggestion?: string;
}

export function formatResult(r: GtRunResult): FormattedResult {
  const isFailure = r.exitCode !== 0 || r.timedOut || !!r.spawnError;
  return {
    ok: !isFailure,
    isFailure,
    result: r,
    hints: isFailure ? parseHints(r) : {},
  };
}

/** Render a formatted result into a single text block. */
export function renderText(label: string, f: FormattedResult): string {
  const r = f.result;
  const lines: string[] = [];
  lines.push(`$ gt ${r.args.join(" ")}`);
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
  if (f.isFailure && f.suggestion) {
    lines.push("--- suggestion ---");
    lines.push(f.suggestion);
  }
  return `[${label}] ${f.ok ? "ok" : "fail"}\n${lines.join("\n")}`;
}

/* ----------------------- auxiliary probes (best-effort) ----------------------- */

function execText(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve("");
      return;
    }
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > 4096) out = out.slice(-4096);
    });
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(out));
  });
}

async function detectCurrentBranch(cwd: string): Promise<string | undefined> {
  const t = (await execText("git", ["-C", cwd, "branch", "--show-current"], cwd)).trim();
  return t || undefined;
}

async function detectTrunk(cwd: string): Promise<string | undefined> {
  const out = await execText("gt", ["--cwd", cwd, "--no-interactive", "trunk"], cwd);
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
      `Current branch (${b}) is not tracked by Graphite. To track it, call: ` +
        `graphite_branch_tracking({ action: "track", branch: "${b}", parent: "${p}" }). ` +
        `Verify parent is correct before applying.`,
    );
  }
  if (f.hints.notInitialized) {
    parts.push(
      `Graphite not initialized in this repo. Call: graphite_repo({ action: "init", trunk: "<trunk-branch>" }).`,
    );
  }
  if (f.hints.conflictHalted) {
    parts.push(
      `A Graphite command is halted by a conflict. After resolving in git, call: ` +
        `graphite_recovery({ action: "continue" }) (or "abort").`,
    );
  }
  if (f.hints.restackNeeded) {
    parts.push(`Stack is out of date. Call: graphite_stack_restack().`);
  }
  if (f.hints.trunkOutOfSync) {
    parts.push(
      `Trunk is out of sync with remote. Call: graphite_remote_sync({ action: "sync" }) first.`,
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
        `\`graphite_branch_create({ onto: "${b}", ... })\` to stack a new branch on top.`,
    );
  }
  if (f.hints.invalidArgument) {
    parts.push(
      `gt rejected an unknown argument (${f.hints.invalidArgument}). The local gt version may not support this flag; remove it and retry.`,
    );
  }
  if (f.hints.operatingOnTrunk) {
    parts.push(
      `Operation refused on the trunk branch. Check out a non-trunk branch first (graphite_branch_navigate).`,
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
): Promise<FormattedResult> {
  const f = formatResult(r);
  if (f.isFailure) {
    await enrichFailure(cwd, f);
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
  items: Array<{ label: string; result: GtRunResult }>,
  cwd: string,
): Promise<FormattedResult[]> {
  const formatted = items.map((i) => ({ label: i.label, f: formatResult(i.result) }));
  const failed = formatted.filter((x) => x.f.isFailure);
  if (failed.length) {
    await Promise.all(failed.map((x) => enrichFailure(cwd, x.f)));
    const blocks = formatted.map((x) => renderText(x.label, x.f));
    throw new Error(blocks.join("\n\n"));
  }
  return formatted.map((x) => x.f);
}
