import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runGt } from "../lib/exec";
import { assertSafeRef, shellJoin } from "../lib/argv";
import {
  ensureAllSuccess,
  ensureSuccess,
  renderText,
  type FormattedResult,
} from "../lib/result";
import { CwdParam, Type, type ToolReturn } from "../lib/schema";

const MAX_STATUS_BRANCHES = 20;
const DEFAULT_TOPOLOGY_CONTEXT_LINES = 3;
const MAX_TOPOLOGY_CONTEXT_LINES = 20;

export interface TargetedStatusResult {
  text: string;
  details: Record<string, unknown>;
}

function normalizeBranches(branches: string[] | undefined): string[] {
  if (!branches?.length) return [];
  if (branches.length > MAX_STATUS_BRANCHES) {
    throw new Error(
      `graphite_status: branches is capped at ${MAX_STATUS_BRANCHES} to avoid large outputs. ` +
        `Pass fewer branch names.`,
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of branches) {
    const safe = assertSafeRef(b, "branches[]");
    if (!seen.has(safe)) {
      seen.add(safe);
      out.push(safe);
    }
  }
  return out;
}

function normalizeContextLines(value: number | undefined): number {
  if (value == null) return DEFAULT_TOPOLOGY_CONTEXT_LINES;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("graphite_status: contextLines must be a non-negative integer.");
  }
  return Math.min(value, MAX_TOPOLOGY_CONTEXT_LINES);
}

function lineMentionsBranch(line: string, branch: string): boolean {
  // Graphite log format is not stable enough to parse structurally across gt
  // versions. Literal containment is intentionally conservative: snippets are
  // only context for humans, not structured truth.
  return line.includes(branch);
}

function buildTopologySnippet(
  stdout: string,
  branches: string[],
  contextLines: number,
): { text: string; matchedBranches: string[]; missingBranches: string[] } {
  const lines = stdout.split("\n");
  const ranges: Array<[number, number]> = [];
  const matched = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    for (const branch of branches) {
      if (lineMentionsBranch(lines[i], branch)) {
        matched.add(branch);
        ranges.push([
          Math.max(0, i - contextLines),
          Math.min(lines.length - 1, i + contextLines),
        ]);
      }
    }
  }

  if (!ranges.length) {
    return {
      text: `No matching lines found in \`gt log\` for: ${branches.join(", ")}`,
      matchedBranches: [],
      missingBranches: branches,
    };
  }

  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of ranges) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 1) {
      merged.push([start, end]);
    } else {
      last[1] = Math.max(last[1], end);
    }
  }

  const blocks = merged.map(([start, end]) => {
    const body = lines
      .slice(start, end + 1)
      .map((line, idx) => `${String(start + idx + 1).padStart(4, " ")}: ${line}`)
      .join("\n");
    return `@@ lines ${start + 1}-${end + 1} @@\n${body}`;
  });

  const matchedBranches = branches.filter((b) => matched.has(b));
  const missingBranches = branches.filter((b) => !matched.has(b));
  const suffix = missingBranches.length
    ? `\n\nMissing from snippets: ${missingBranches.join(", ")}`
    : "";

  return {
    text: `${blocks.join("\n\n")} ${suffix}`.trimEnd(),
    matchedBranches,
    missingBranches,
  };
}

function renderFilteredTopology(
  label: string,
  f: FormattedResult,
  branches: string[],
  contextLines: number,
): { text: string; details: Record<string, unknown> } {
  const r = f.result;
  const snippet = buildTopologySnippet(r.stdout, branches, contextLines);
  const status = Object.keys(f.warnings).length ? "ok (with warnings)" : "ok";
  const lines: string[] = [];
  lines.push(`[${label}] ${status} (filtered topology)`);
  lines.push(`$ gt ${shellJoin(r.args)}`);
  lines.push(`# cwd=${r.cwd}  exit=${r.exitCode}`);
  lines.push("--- topology snippets (filtered from gt log; not full graph) ---");
  lines.push(`branches=${branches.join(", ")}  contextLines=${contextLines}`);
  lines.push(snippet.text);
  if (Object.keys(f.warnings).length) {
    lines.push("--- warnings ---");
    lines.push(JSON.stringify(f.warnings));
  }
  return {
    text: lines.join("\n"),
    details: {
      command: r.args,
      cwd: r.cwd,
      warnings: f.warnings,
      matchedBranches: snippet.matchedBranches,
      missingBranches: snippet.missingBranches,
      snippet: snippet.text,
    },
  };
}

export async function buildTargetedStatus(
  cwd: string,
  branchesInput: string[],
  signal?: AbortSignal,
  opts?: { includeTopology?: boolean; contextLines?: number },
): Promise<TargetedStatusResult> {
  const branches = normalizeBranches(branchesInput);
  if (!branches.length) {
    throw new Error("buildTargetedStatus requires at least one branch.");
  }
  const includeTopology = opts?.includeTopology === true;
  const contextLines = normalizeContextLines(opts?.contextLines);

  const infoItems = await Promise.all(
    branches.map(async (branch) => {
      const args = ["info", branch];
      return {
        branch,
        label: `gt ${shellJoin(args)}`,
        result: await runGt(args, { cwd, signal }),
      };
    }),
  );
  const formattedInfo = await ensureAllSuccess(
    infoItems.map((i) => ({ label: i.label, result: i.result, requireStdout: true })),
    cwd,
  );

  const blocks = infoItems.map((item, idx) =>
    renderText(item.label, formattedInfo[idx]),
  );
  const details: Record<string, unknown> = {
    branches,
    info: Object.fromEntries(
      infoItems.map((item, idx) => [item.branch, formattedInfo[idx]]),
    ),
  };

  if (includeTopology) {
    const logArgs = ["log"];
    const log = await runGt(logArgs, { cwd, signal });
    const formattedLog = await ensureSuccess(`gt ${shellJoin(logArgs)}`, log, cwd);
    const topology = renderFilteredTopology(
      `gt ${shellJoin(logArgs)}`,
      formattedLog,
      branches,
      contextLines,
    );
    blocks.push(topology.text);
    details.topology = topology.details;
  }

  return {
    text: blocks.join("\n\n"),
    details,
  };
}

/**
 * graphite_status — read-only entry point.
 *
 * Default returns:
 *   gt log --stack    -> current stack tree
 *   gt info           -> current branch summary (parent, PR url, restack hint)
 *
 * Targeted mode accepts `branches` and returns `gt info <branch>` for each.
 * Optional topology snippets are filtered from `gt log` around those branch
 * names so callers can verify cross-stack shape without dumping all stacks.
 */
export function registerStatus(pi: ExtensionAPI) {
  pi.registerTool({
    name: "graphite_status",
    label: "Graphite: status",
    description:
      "Read-only Graphite snapshot. By default runs `gt log --stack` and `gt info` for the current stack. Pass `branches` for compact `gt info <branch>` output; add `includeTopology:true` for bounded `gt log` snippets around those branches.",
    promptSnippet:
      "graphite_status: inspect current stack, or targeted branches before mutating",
    promptGuidelines: [
      "Run graphite_status at the start of any Graphite workflow, and again whenever you are unsure where you are in the stack.",
      "For cross-stack verification, pass explicit branches with includeTopology:true instead of dumping every tracked branch.",
    ],
    parameters: Type.Object({
      cwd: CwdParam,
      branches: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Optional branch names for targeted status. Runs `gt info <branch>` for each; capped to avoid large outputs.",
        }),
      ),
      includeTopology: Type.Optional(
        Type.Boolean({
          description:
            "With branches, include bounded snippets from `gt log` around each branch (not the full graph).",
        }),
      ),
      contextLines: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: MAX_TOPOLOGY_CONTEXT_LINES,
          description:
            "Topology context lines around each matching branch. Default 3, capped at 20.",
        }),
      ),
    }),
    async execute(_id, p, signal): Promise<ToolReturn> {
      const branches = normalizeBranches(p.branches);
      if (branches.length) {
        const targeted = await buildTargetedStatus(p.cwd, branches, signal, {
          includeTopology: p.includeTopology,
          contextLines: p.contextLines,
        });
        return {
          content: [{ type: "text", text: targeted.text }],
          details: targeted.details,
        };
      }

      if (p.includeTopology) {
        throw new Error(
          "graphite_status: includeTopology requires `branches` so output stays bounded.",
        );
      }

      const [log, info] = await Promise.all([
        runGt(["log", "--stack"], { cwd: p.cwd, signal }),
        runGt(["info"], { cwd: p.cwd, signal }),
      ]);
      const [fl, fi] = await ensureAllSuccess(
        [
          { label: "gt log --stack", result: log, requireStdout: true },
          { label: "gt info", result: info, requireStdout: true },
        ],
        p.cwd,
      );
      return {
        content: [
          {
            type: "text",
            text: [
              renderText("gt log --stack", fl),
              renderText("gt info", fi),
            ].join("\n\n"),
          },
        ],
        details: { log: fl, info: fi },
      };
    },
  });
}
