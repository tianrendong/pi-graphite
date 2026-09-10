import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { after, mock } from "node:test";
import { createJiti } from "jiti";

// Use the same TypeScript loader as pi, without starting an agent session.
const jiti = createJiti(import.meta.url);

export async function loadTool(module, name) {
  const exports = await jiti.import(module);
  let tool;
  exports[name]({ registerTool: (definition) => { tool = definition; } });
  assert.ok(tool);
  return tool;
}

// Mock only the process boundary: tools still exercise the real argv builder,
// non-interactive runner, failure parser, and temporary PR-body file handling.
// No test can push branches, edit real PRs, or invoke an editor.
// Jiti caches imported functions. Keep one dispatcher for this test process
// rather than replacing spawn between tests (which would leave stale mocks).
let active;
const mocked = mock.method(childProcess, "spawn", (command, rawArgs, options) => {
  assert.ok(active, "No command scenario installed; refusing to spawn a real process");
  const { calls, handler } = active;
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.env.GT_EDITOR, "true");
  assert.equal(options.env.GIT_EDITOR, "true");
  assert.equal(options.env.GH_BROWSER, "true");

  let args = [...rawArgs];
  if (command === "gt") {
    assert.equal(args[0], "--cwd");
    assert.equal(args[1], options.cwd);
    assert.equal(args[2], "--no-interactive");
    assert.equal(args.at(-1), "--no-interactive");
    args = args.slice(3, -1);
  }
  // Do not record the inherited environment: it may contain credentials.
  const call = { command, args, rawArgs: [...rawArgs], cwd: options.cwd };
  calls.push(call);
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  Promise.resolve().then(() => handler(call)).then(
    ({ stdout = "", stderr = "", code = 0 } = {}) => {
      child.stdout.end(stdout);
      child.stderr.end(stderr);
      child.emit("close", code);
    },
    (error) => child.emit("error", error),
  );
  return child;
});
syncBuiltinESMExports();
after(() => {
  mocked.mock.restore();
  syncBuiltinESMExports();
});

export function mockCommands(t, handler) {
  assert.equal(active, undefined, "Command scenarios must run sequentially within a test process");
  const calls = [];
  active = { calls, handler };
  t.after(() => { active = undefined; });
  return calls;
}
