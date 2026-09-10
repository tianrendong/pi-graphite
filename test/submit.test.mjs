import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadTool, mockCommands } from "./helpers.mjs";

const submit = await loadTool("../src/tools/submit.ts", "registerSubmit");
const cwd = resolve(".");
const template = "## Summary\n<!-- Describe your change -->\n\n## Test plan\n- [ ] Tests pass\n";
const description = "## Summary\nFix template handling.\n\n## Test plan\n- [x] npm test\n";
const apply = { cwd, apply: true, confirmRemote: true };
const descriptions = [{ branch: "feature", body: description }];

function scenario(t, options = {}) {
  const branches = options.branches ?? ["feature"];
  const prs = new Map(Object.entries(options.prs ?? {}).map(([branch, pr]) => [branch, { ...pr }]));
  const edits = [];
  const calls = mockCommands(t, async ({ command, args }) => {
    if (command === "gt") {
      if (args[0] === "trunk") return { stdout: "main\n" };
      if (args[0] === "log") {
        return { stdout: [...branches.map((branch) => `◉ ${branch}`), "◯ main"].join("\n") };
      }
      if (args[0] === "submit") {
        if (args.includes("--dry-run")) return { stdout: "Would submit stack.\n" };
        if (!args.includes("--update-only")) {
          for (const branch of options.createdBranches ?? branches) {
            if (!prs.has(branch)) prs.set(branch, { number: prs.size + 1, body: options.generatedBody ?? template });
          }
        }
        options.onSubmit?.(prs);
        return options.submitError
          ? { code: 1, stderr: options.submitError }
          : { stdout: "Submitted stack.\n" };
      }
    }
    if (command === "gh" && args[0] === "pr") {
      const branch = args[2];
      if (args[1] === "view") {
        const pr = prs.get(branch);
        return pr
          ? { stdout: JSON.stringify({ ...pr, headRefName: branch, body: options.crlf ? pr.body.replace(/\r?\n/g, "\r\n") : pr.body }) }
          : { code: 1, stderr: `no pull requests found for branch "${branch}"` };
      }
      if (args[1] === "edit") {
        assert.equal(args[3], "--body-file");
        const body = await readFile(args[4], "utf8");
        edits.push({ branch, body, path: args[4] });
        if (options.editError) return { code: 1, stderr: options.editError };
        if (!options.ignoreEdits) prs.get(branch).body = body;
        return { stdout: "Updated PR.\n" };
      }
    }
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
  return { prs, edits, calls };
}

function submissions(calls) {
  return calls.filter(({ command, args }) => command === "gt" && args[0] === "submit");
}

test("new PR template is replaced without overwriteDescriptions", async (t) => {
  const { prs, edits, calls } = scenario(t);
  const result = await submit.execute("test", { ...apply, descriptions });
  assert.equal(prs.get("feature").body, description);
  assert.equal(edits.length, 1);
  assert.deepEqual(result.details.descriptionUpdates, [{ branch: "feature", action: "set", number: 1 }]);
  assert.deepEqual(result.details.requiredDescriptions, ["feature"]);
  assert.deepEqual(submissions(calls)[0].args, ["submit", "--stack", "--no-edit", "--no-ai"]);
  await assert.rejects(access(edits[0].path), { code: "ENOENT" });
});

test("new PR commit-text fallback is also replaced", async (t) => {
  const { prs } = scenario(t, { generatedBody: "Auto-generated commit summary" });
  await submit.execute("test", { ...apply, descriptions });
  assert.equal(prs.get("feature").body, description);
});

test("new PR with an empty body still receives its description", async (t) => {
  const { prs } = scenario(t, { generatedBody: "" });
  await submit.execute("test", { ...apply, descriptions });
  assert.equal(prs.get("feature").body, description);
});

test("previously empty PR populated during submit still receives supplied body", async (t) => {
  const { prs, edits } = scenario(t, {
    prs: { feature: { number: 12, body: "  \n" } },
    onSubmit: (prs) => { prs.get("feature").body = template; },
  });
  const result = await submit.execute("test", { ...apply, descriptions });
  assert.equal(prs.get("feature").body, description);
  assert.equal(edits.length, 1);
  assert.equal(result.details.prDescriptionPreflight[0].bodyEmpty, true);
});

test("authored body present before submit is preserved by default", async (t) => {
  const { prs, edits } = scenario(t, { prs: { feature: { number: 12, body: "Authored description" } } });
  const result = await submit.execute("test", { ...apply, descriptions });
  assert.equal(prs.get("feature").body, "Authored description");
  assert.equal(edits.length, 0);
  assert.equal(result.details.descriptionUpdates[0].action, "skipped_existing_body");
});

test("preservation decision uses pre-submit body, even if gt clears it", async (t) => {
  const { edits } = scenario(t, {
    prs: { feature: { number: 12, body: "Authored description" } },
    onSubmit: (prs) => { prs.get("feature").body = ""; },
  });
  const result = await submit.execute("test", { ...apply, descriptions });
  assert.equal(edits.length, 0);
  assert.equal(result.details.descriptionUpdates[0].action, "skipped_existing_body");
});

test("existing template-only PR stays protected unless overwrite is explicit", async (t) => {
  const { prs, edits } = scenario(t, { prs: { feature: { number: 12, body: template } } });
  await submit.execute("test", { ...apply, descriptions });
  assert.equal(prs.get("feature").body, template);
  assert.equal(edits.length, 0);
  await submit.execute("test", { ...apply, descriptions, overwriteDescriptions: true });
  assert.equal(prs.get("feature").body, description);
  assert.equal(edits.length, 1);
});

test("mixed stack replaces only new/empty bodies without overwrite", async (t) => {
  const { prs, edits } = scenario(t, {
    branches: ["feature", "empty", "authored"],
    prs: { empty: { number: 2, body: "" }, authored: { number: 3, body: "Keep this" } },
    onSubmit: (prs) => { prs.get("empty").body = template; },
  });
  await submit.execute("test", {
    ...apply,
    descriptions: ["feature", "empty", "authored"].map((branch) => ({ branch, body: description })),
  });
  assert.deepEqual(edits.map((edit) => edit.branch), ["feature", "empty"]);
  assert.equal(prs.get("authored").body, "Keep this");
});

test("failed submit repairs created template bodies using the same snapshot", async (t) => {
  const { prs, edits } = scenario(t, {
    branches: ["feature", "missing", "authored"],
    prs: { authored: { number: 10, body: "Keep this" } },
    createdBranches: ["feature"],
    submitError: "ERROR: remote push failed",
  });
  await assert.rejects(
    submit.execute("test", {
      ...apply,
      descriptions: ["feature", "missing", "authored"].map((branch) => ({ branch, body: description })),
    }),
    /remote push failed[\s\S]*partial side effects/,
  );
  assert.equal(prs.get("feature").body, description);
  assert.equal(prs.get("authored").body, "Keep this");
  assert.equal(prs.has("missing"), false);
  assert.deepEqual(edits.map((edit) => edit.branch), ["feature"]);
});

test("dry-run reports descriptions needed but never edits template bodies", async (t) => {
  const { calls, edits, prs } = scenario(t);
  const result = await submit.execute("test", { cwd, descriptions });
  assert.equal(result.details.apply, false);
  assert.deepEqual(result.details.requiredDescriptions, ["feature"]);
  assert.match(result.content[0].text, /Descriptions required before apply:true: feature/);
  assert.equal(submissions(calls)[0].args.includes("--dry-run"), true);
  assert.equal(edits.length, 0);
  assert.equal(prs.size, 0);
});

test("missing descriptions refuse before any submit", async (t) => {
  const { calls } = scenario(t);
  await assert.rejects(submit.execute("test", apply), /PR descriptions missing for feature/);
  assert.equal(submissions(calls).length, 0);
});

test("empty existing PR requires description before submit", async (t) => {
  const { calls } = scenario(t, { prs: { feature: { number: 12, body: "" } } });
  await assert.rejects(submit.execute("test", apply), /PR descriptions missing for feature/);
  assert.equal(submissions(calls).length, 0);
});

test("updateOnly excludes branches without a PR from required descriptions", async (t) => {
  const { prs } = scenario(t, {
    branches: ["feature", "existing"],
    prs: { existing: { number: 12, body: "Authored description" } },
  });
  const result = await submit.execute("test", { ...apply, updateOnly: true });
  assert.deepEqual(result.details.requiredDescriptions, []);
  assert.equal(prs.has("feature"), false);
});

test("PR body text is not rebranded while verifying descriptions", async (t) => {
  const { prs } = scenario(t);
  const body = "## Summary\nPreserve Charcoal and charcoal literally in PR text.\n";
  await submit.execute("test", { ...apply, descriptions: [{ branch: "feature", body }] });
  assert.equal(prs.get("feature").body, body);
});

test("verification accepts GitHub line-ending normalization", async (t) => {
  const { edits } = scenario(t, { crlf: true });
  await submit.execute("test", { ...apply, descriptions });
  assert.equal(edits.length, 1);
});

test("verification rejects an unchanged, non-empty template", async (t) => {
  const { edits } = scenario(t, { ignoreEdits: true });
  await assert.rejects(
    submit.execute("test", { ...apply, descriptions }),
    /body does not match the supplied description/,
  );
  await assert.rejects(access(edits[0].path), { code: "ENOENT" });
});

test("temporary body file is removed when gh edit fails", async (t) => {
  const { edits } = scenario(t, { editError: "permission denied" });
  await assert.rejects(submit.execute("test", { ...apply, descriptions }), /permission denied/);
  await assert.rejects(access(edits[0].path), { code: "ENOENT" });
});

test("description and confirmation guardrails remain enforced", async (t) => {
  const { calls } = scenario(t);
  await assert.rejects(submit.execute("test", { cwd, apply: true, descriptions }), /confirm/);
  await assert.rejects(submit.execute("test", { ...apply, descriptions: [{ branch: "feature", body: " \n" }] }), /must be non-empty/);
  await assert.rejects(submit.execute("test", { ...apply, descriptions: [...descriptions, ...descriptions] }), /Duplicate PR description/);
  assert.equal(calls.length, 0);
  await assert.rejects(submit.execute("test", { ...apply, descriptions: [{ branch: "outside", body: description }] }), /outside current stack/);
  assert.equal(submissions(calls).length, 0);
});
