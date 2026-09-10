import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { loadTool, mockCommands } from "./helpers.mjs";

const change = await loadTool("../src/tools/change.ts", "registerChange");
const cwd = resolve(".");
const fold = { cwd, action: "fold" };
const applyFold = { ...fold, apply: true, confirmDestructive: true };

function scenario(t, options = {}) {
  return mockCommands(t, ({ command, args }) => {
    assert.equal(command, "gt");
    if (args[0] === "parent") {
      return options.parentError
        ? { code: 1, stderr: options.parentError }
        : { stdout: options.parent ?? "base\n" };
    }
    if (args[0] === "trunk") return { stdout: options.trunk ?? "main\n" };
    if (args[0] === "log") return { stdout: options.log ?? "◉ feature (current)\n◯ base\n◯ main\n" };
    if (args[0] === "fold") return options.foldResult ?? { stdout: "Folded feature into base.\n" };
    if (["create", "modify", "absorb"].includes(args[0])) return { stdout: "Done.\n" };
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
}

test("fold is part of graphite_change's public schema", () => {
  assert.equal(change.parameters.properties.action.enum.includes("fold"), true);
  assert.ok(change.parameters.properties.keep);
  assert.ok(change.parameters.properties.confirmDestructive);
});

test("fold defaults to a read-only plan, never gt fold --dry-run", async (t) => {
  const calls = scenario(t);
  const result = await change.execute("test", fold);
  assert.deepEqual(calls.map((call) => call.args[0]).sort(), ["log", "parent", "trunk"]);
  assert.equal(result.details.apply, false);
  assert.equal(result.details.parent, "base");
  assert.equal(result.details.keep, false);
  assert.match(result.content[0].text, /dry-run \(no changes made\)/);
  assert.match(result.content[0].text, /Keep parent branch base; delete the current branch/);
  assert.match(result.content[0].text, /Other branches stacked on base may also be rebased/);
  assert.match(result.content[0].text, /◉ feature \(current\)/);
  assert.match(result.content[0].text, /confirmDestructive:true/);
  assert.equal(calls.some((call) => call.args.includes("--dry-run")), false);
});

test("fold keep plan explains that parent is deleted, without mutating", async (t) => {
  const calls = scenario(t);
  const result = await change.execute("test", { ...fold, apply: false, keep: true });
  assert.match(result.content[0].text, /Keep the current branch name; delete parent branch base/);
  assert.match(result.content[0].text, /fold --keep/);
  assert.match(result.content[0].text, /keep:true, apply:true, and confirmDestructive:true/);
  assert.equal(result.details.keep, true);
  assert.equal(calls.some((call) => call.args[0] === "fold"), false);
});

test("fold apply requires destructive confirmation before running commands", async (t) => {
  const calls = scenario(t);
  for (const confirmDestructive of [undefined, false]) {
    await assert.rejects(
      change.execute("test", { ...fold, apply: true, confirmDestructive }),
      /Refused: gt fold.*confirm/,
    );
  }
  assert.equal(calls.length, 0);
});

test("confirmed fold uses only supported flags and does not stage changes", async (t) => {
  const calls = scenario(t);
  const result = await change.execute("test", applyFold);
  assert.deepEqual(calls.at(-1).args, ["fold"]);
  assert.equal(result.details.action, "fold");
  assert.equal(result.details.apply, true);
  assert.equal(result.details.keep, false);
  assert.equal(result.details.result.ok, true);
});

test("confirmed fold supports --keep without requiring a message", async (t) => {
  const calls = scenario(t);
  const result = await change.execute("test", { ...applyFold, keep: true });
  assert.deepEqual(calls.at(-1).args, ["fold", "--keep"]);
  assert.equal(result.details.keep, true);
});

for (const apply of [false, true]) {
  test(`fold refuses parent=trunk with apply=${apply}`, async (t) => {
    const calls = scenario(t, { parent: "main\n" });
    await assert.rejects(
      change.execute("test", { ...applyFold, apply }),
      /cannot fold into trunk \(main\)/,
    );
    assert.equal(calls.some((call) => call.args[0] === "fold"), false);
  });
}

test("fold on trunk fails during preflight with recovery guidance", async (t) => {
  const calls = scenario(t, { parentError: "ERROR: Cannot perform this operation on the trunk branch" });
  await assert.rejects(change.execute("test", applyFold), /operatingOnTrunk[\s\S]*graphite_navigate/);
  assert.equal(calls.some((call) => call.args[0] === "fold"), false);
});

for (const probe of ["parent", "trunk", "log"]) {
  test(`fold refuses empty ${probe} preflight output`, async (t) => {
    const calls = scenario(t, { [probe]: "" });
    await assert.rejects(change.execute("test", fold), /emptyOutput/);
    assert.equal(calls.some((call) => call.args[0] === "fold"), false);
  });
}

test("fold conflicts include Graphite recovery and partial-side-effect guidance", async (t) => {
  scenario(t, { foldResult: { code: 1, stderr: "ERROR: Restack halted by a rebase conflict. Run gt continue." } });
  await assert.rejects(
    change.execute("test", applyFold),
    /conflictHalted[\s\S]*graphite_recover[\s\S]*partial side effects/,
  );
});

test("fold warnings are surfaced even if gt exits successfully", async (t) => {
  scenario(t, { foldResult: { stdout: "Charcoal: Folded branch. Child needs to be restacked." } });
  const result = await change.execute("test", applyFold);
  assert.equal(result.details.result.warnings.needsRestack, true);
  assert.match(result.content[0].text, /ok \(with warnings\)/);
  assert.match(result.content[0].text, /Graphite: Folded branch/);
});

test("create keeps its existing message, staging, insertion, and no-AI flags", async (t) => {
  const calls = scenario(t);
  await change.execute("test", {
    cwd, action: "create", name: "feature", message: "Add feature", includeUntracked: true, insert: true,
  });
  assert.deepEqual(calls[0].args, ["create", "feature", "--message=Add feature", "--all", "--update", "--insert", "--no-ai"]);
});

test("amend and amend_into keep safe message and branch argument handling", async (t) => {
  const calls = scenario(t);
  await change.execute("test", { cwd, action: "amend", message: "--interactive" });
  await change.execute("test", { cwd, action: "amend_into", into: "base", message: "Fix base", includeUntracked: true });
  assert.deepEqual(calls[0].args, ["modify", "--all", "--message=--interactive"]);
  assert.deepEqual(calls[1].args, ["modify", "--all", "--update", "--into=base", "--message=Fix base"]);
  await assert.rejects(
    change.execute("test", { cwd, action: "amend_into", into: "--interactive", message: "Bad branch" }),
    /must not start with "-"/,
  );
  assert.equal(calls.length, 2);
});

test("absorb still defaults to dry-run and applies with --force", async (t) => {
  const calls = scenario(t);
  await change.execute("test", { cwd, action: "absorb" });
  await change.execute("test", { cwd, action: "absorb", apply: true });
  assert.deepEqual(calls.map((call) => call.args), [["absorb", "--dry-run", "--all"], ["absorb", "--force", "--all"]]);
});

test("commit actions still require explicit messages", async (t) => {
  const calls = scenario(t);
  for (const action of ["create", "amend", "amend_into"]) {
    await assert.rejects(change.execute("test", { cwd, action, into: "base" }), /requires `message`/);
  }
  assert.equal(calls.length, 0);
});
