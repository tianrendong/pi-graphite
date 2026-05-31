---
name: graphite
description: Manage stacked PRs with the Graphite (gt) CLI via the pi-graphite extension. Use when creating, updating, navigating, or pushing a Graphite stack, or when recovering from a halted gt command. Wraps `gt` only — does not touch PR titles/bodies, reviews, or stack surgery.
---

# Graphite (pi-graphite)

This skill drives the [pi-graphite](https://www.npmjs.com/package/pi-graphite)
extension. The extension is a deliberately small, opinionated wrapper around
the Graphite (`gt`) CLI. There is exactly one correct workflow; follow it.

## When to use

Use this skill whenever the user wants to:

- start work on a stacked-PR repo
- create a new PR on top of the current branch
- amend an existing PR with new changes
- push the current stack to GitHub
- sync after PRs merged on `main`
- recover from a gt conflict

Do not use it for:

- editing PR titles / bodies / labels / reviewers metadata — prefer a
  dedicated `gh` tool/extension; see the `gh` rule below
- reading PR review comments or CI status — same
- rewriting history beyond create/amend (split / fold / move / squash /
  reorder). The extension does not expose stack surgery, and those
  subcommands prompt interactively (base selectors, hunk pickers, editors)
  and will hang. Ask the user to run them in their own terminal.

## Tools

The extension registers these tools. Prefer them over `gt`/`git`/`gh` in bash.

| Tool | Purpose |
|---|---|
| `graphite_status` | Read-only snapshot: current stack + current branch + PR + restack hint |
| `graphite_setup` | Initialize Graphite or track an existing Git branch with explicit parent |
| `graphite_sync` | `gt sync` — pull trunk, drop merged branches, restack |
| `graphite_get` | `gt get <branch>` — pull a branch / stack from the remote |
| `graphite_navigate` | `gt checkout` / `up` / `down` / `top` / `bottom` / trunk |
| `graphite_change` | `gt create` / `gt modify` / `gt modify --into` / `gt absorb` |
| `graphite_submit` | `gt submit --stack --no-edit` (dry-run by default) |
| `graphite_recover` | `gt continue` / `gt abort` / `gt undo` / `gt restack` |

All tools require an absolute `cwd`.

## Reading tool output (don't trust a bare "ok")

Each result starts with `[<label>] ok | ok (with warnings) | fail`. Read past
the status line:

- **`fail`** — read the `--- hints ---` and `--- suggestion ---` blocks; they
  tell you exactly which recovery tool to call.
- **`ok (with warnings)`** — gt exited 0 but its output mentioned skipped /
  remotely-changed / already-merged branches or a needed restack. Treat this
  as "succeeded but verify": run `graphite_status` before assuming the stack
  is in the expected shape.
- **`emptyOutput` hint on a status call** — gt returned nothing where output
  was expected. Usually means the branch is untracked, the repo is not
  Graphite-initialized, or the gt build short-circuited. Follow the
  suggestion (often `graphite_setup`), and you may run a **read-only** gt
  command directly to confirm (see the direct-`gt` rule).
- After a **failed mutating** command (change / submit apply / sync / get /
  recover / setup) the suggestion warns "partial side effects possible".
  Always run `graphite_status` to see the real state before retrying.

## Golden path

```
graphite_status
     ↓
graphite_setup                      (only if repo not initialized or branch untracked)
     ↓
graphite_sync                       (start of session, or after PRs merged)
     ↓
graphite_navigate                   (move to the branch you want to mutate)
     ↓
graphite_change                     (create or amend)
     ↓
graphite_submit apply=false   (review dry-run plan)
     ↓
graphite_submit apply=true    (push, with confirmRemote=true)
   confirmRemote=true
```

When a `gt` command halts on conflict:

```
resolve files in editor → git add -- <paths> → graphite_recover action="continue"
```

Never run `git rebase --continue` after a Graphite-initiated rebase; use
`graphite_recover action="continue"` so Graphite propagates the resolution
to dependent branches.

## Recipes

### Initialize repo if Graphite is missing

If a tool reports `notInitialized`:

```
# Ask user for trunk if unclear.
graphite_setup({ cwd, action: "init_repo", trunk: "main" })
graphite_status({ cwd })
```

If resetting existing Graphite metadata is explicitly intended:

```
graphite_setup({ cwd, action: "init_repo", trunk: "main", reset: true, confirmDestructive: true })
```

### Track existing Git branch if untracked

If a tool reports `branchNotTracked`:

1. Identify the intended Graphite parent branch.
2. If parent is unclear, ask the user.
3. Track only after parent is confirmed.

```
graphite_setup({
  cwd,
  action: "track_branch",
  branch: "<existing-git-branch>",
  parent: "<intended-parent-branch>",
  confirmParent: true,
})
graphite_status({ cwd })
```

Never guess parent silently. Wrong parent means wrong stack shape.

### Start a session

```
graphite_status({ cwd })
graphite_sync({ cwd })          # pull trunk, drop merged, restack
graphite_status({ cwd })        # confirm state
```

### Create a new PR on top of the current branch

```
graphite_status({ cwd })                     # confirm position
# ... user makes code changes ...
graphite_change({ cwd, action: "create", message: "..." })
graphite_submit({ cwd, apply: false })
# review plan with user; then:
graphite_submit({ cwd, apply: true, confirmRemote: true })
```

### Update an existing PR

```
graphite_status({ cwd })
graphite_navigate({ cwd, action: "checkout", branch: "<pr-branch>" })
# ... user makes code changes ...
graphite_change({ cwd, action: "amend", message: "..." })
graphite_submit({ cwd, apply: false })
graphite_submit({ cwd, apply: true, confirmRemote: true })
```

### Add a child PR off a specific parent

```
graphite_navigate({ cwd, action: "checkout", branch: "<parent-branch>" })
# ... changes ...
graphite_change({ cwd, action: "create", message: "..." })
graphite_submit({ cwd, apply: false })
```

### Land changes into a downstack branch

```
# Make the change locally (working tree dirty).
graphite_change({ cwd, action: "amend_into", into: "<downstack-branch>", message: "..." })
graphite_status({ cwd })
graphite_submit({ cwd, apply: false })
```

For larger reshuffles touching several downstack commits, prefer `absorb`:

```
graphite_change({ cwd, action: "absorb" })             # dry-run
graphite_change({ cwd, action: "absorb", apply: true }) # apply
```

### After PRs in the stack merge

```
graphite_sync({ cwd })
graphite_status({ cwd })
```

If `gt sync` halts on conflict, use the conflict recipe below.

### Restack without pulling from remote

When `graphite_status` shows branches out of date with their parent but trunk
has not moved (no remote pull needed), restack directly:

```
graphite_recover({ cwd, action: "restack" })
graphite_status({ cwd })
```

Use `graphite_sync` instead when trunk itself may have advanced on the remote.
If restack halts on a conflict, follow the conflict recipe.

### Pull a branch / stack from the remote

To check out a teammate's branch, or re-pull a branch that changed remotely:

```
graphite_get({ cwd, branch: "<branch>" })
graphite_status({ cwd })
```

If local commits should be overwritten by the remote version:

```
graphite_get({ cwd, branch: "<branch>", force: true, confirmDestructive: true })
```

### Resolve a conflict

1. Read the failing tool's `--- stderr ---` and `hints` block.
2. Resolve markers in the listed files.
3. Stage the resolved files from bash. Always use `git add --` followed
   by the file paths so a path that starts with `-` cannot be parsed as a
   git flag (e.g. `git add -- path/with-dash`). Use `git add -A` only if
   the user explicitly wants to stage everything. Never run
   `git add --interactive` or `git add -p`.
4. `graphite_recover({ cwd, action: "continue" })`.
5. If you want to bail entirely: `graphite_recover({ cwd, action: "abort" })`.

If you made a mistake with the last gt command:

```
graphite_recover({ cwd, action: "undo" })
```

## Rules

- **Submit stacks, not branches.** `graphite_submit` always passes
  `--stack`. There is no safe single-branch submit path in this extension.
  If the user truly needs to push only one branch, ask them to run
  `gt submit --branch=<name>` themselves in their own terminal — do not
  invoke it from bash, because `gt submit` defaults to interactive prompts
  and an editor for PR metadata.
- **Use `graphite_setup` only for preconditions.** Initialize missing repos
  or track existing Git branches. Do not use it for daily branch creation;
  use `graphite_change action="create"` instead.
- **Never guess tracking parent.** `track_branch` requires explicit branch,
  explicit parent, and `confirmParent:true`.
- **Restack vs sync.** Use `graphite_recover action="restack"` to rebase the
  stack onto each parent's latest commit when no remote pull is needed. Use
  `graphite_sync` when trunk may have advanced remotely (it pulls + restacks).
- **Pull remote branches with `graphite_get`.** `graphite_sync` only touches
  trunk + already-tracked local branches; use `graphite_get` to download a
  branch/stack from the remote.
- **Always dry-run first.** Show the user the dry-run plan from
  `graphite_submit apply=false` before pushing.
- **`apply:true` requires `confirmRemote:true`.** The tool will refuse
  otherwise. This is intentional friction.
- **Destructive sync flags require `confirmDestructive:true`** (`force`,
  `deleteAll`).
- **Never use `git rebase --continue` after a gt command.** Use
  `graphite_recover action="continue"`.
- **This extension wraps gt only.** For PR body/title edits, review
  comments, check runs, etc., use a dedicated `gh` tool/extension if
  available. If you must shell out to `gh` from bash, pass fully explicit
  non-interactive arguments only — never `gh auth login`, `--web`, or any
  command that opens a browser, editor, or prompt.
- **Direct `gt` is allowed only when no tool covers the command.** The tools
  above are the default path. If you genuinely need a `gt` subcommand this
  extension does not expose (and the user has not asked to run it
  themselves), you may call `gt` from bash, but ONLY with explicit
  non-interactive flags and never an interactive subcommand:
  - Always pass `--no-interactive` (and `--cwd <abs>`).
  - Safe read-only fallbacks: `gt log`, `gt log --stack`, `gt info`,
    `gt children`, `gt parent`, `gt trunk`, `gt state`.
  - Never run interactive surgery (`gt split` / `fold` / `move` / `squash` /
    `reorder`) or anything that opens an editor, pager, hunk picker, or
    browser — those hang. Ask the user to run those in their own terminal.
  - Prefer the dedicated tool whenever one exists; direct `gt` skips the
    safety confirmations, hint parsing, and warning detection the tools add.
- **No interactive editor / browser / hunk picker.** All paths are
  non-interactive; pass explicit messages.
