import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadTool, mockCommands } from "./helpers.mjs";

const status = await loadTool("../src/tools/status.ts", "registerStatus");
const cwd = resolve(".");
const longLog = Array.from({ length: 5_000 }, (_, i) => `◯ tdong/branch-${i}`).join("\n");

test("long gt output is capped for the model but complete for scripts and topology", async (t) => {
  mockCommands(t, ({ args }) => {
    if (args[0] === "log") return { stdout: longLog };
    if (args[0] === "info") return { stdout: `${args[1] ?? "tdong/branch-4999"}\nParent: main\n` };
    throw new Error(`Unexpected: ${args.join(" ")}`);
  });

  const full = await status.execute("test", { cwd });
  assert.match(full.content[0].text, /\[truncated: \d+ more (?:lines|bytes)\]/);
  assert.match(full.structuredContent, /tdong\/branch-4999\n/);
  assert.doesNotMatch(full.structuredContent, /\[truncated:/);
  // Session-persisted details keep only the capped output.
  assert.ok(full.details.log.result.stdout.length < full.structuredContent.length);

  // A branch past the model cap is still found by the topology filter.
  const targeted = await status.execute("test", { cwd, branches: ["tdong/branch-4999"], includeTopology: true });
  assert.deepEqual(targeted.details.topology.missingBranches, []);
});
