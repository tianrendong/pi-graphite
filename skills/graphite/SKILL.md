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
  reorder). The extension does not expose stack surgery. Do not invoke
  `gt` directly from bash for these — those subcommands prompt
  interactively (base selectors, hunk pickers, editors) and will hang.
  Ask the user to run them manually in their own terminal.

## Tools

The extension registers seven tools. Prefer them over `gt`/`git`/`gh` in bash.

| Tool | Purpose |
|---|---|
| `graphite_status` | Read-only snapshot: current stack + current branch + PR + restack hint |
| `graphite_setup` | Initialize Graphite or track an existing Git branch with explicit parent |
| `graphite_sync` | `gt sync` — pull trunk, drop merged branches, restack |
| `graphite_navigate` | `gt checkout` / `up` / `down` / `top` / `bottom` / trunk |
| `graphite_change` | `gt create` / `gt modify` / `gt modify --into` / `gt absorb` |
| `graphite_submit` | `gt submit --stack --no-edit` (dry-run by default) |
| `graphite_recover` | `gt continue` / `gt abort` / `gt undo` |

All tools require an absolute `cwd`.

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
- **Prefer `graphite_sync` over manual restack.** The extension does not
  expose a standalone restack tool. Sync covers both pull + restack.
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
- **No interactive editor / browser / hunk picker.** All paths are
  non-interactive; pass explicit messages.
