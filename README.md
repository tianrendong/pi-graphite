# pi-graphite

Opinionated pi tools + skill that wrap the [Graphite](https://graphite.com)
`gt` CLI for stacked PR workflows. A small set of tools, one correct path.

```
graphite_status → (graphite_setup if needed) → graphite_sync → graphite_navigate
       → graphite_change → graphite_submit (dry-run) → graphite_submit (apply)
```

The extension wraps `gt` for stack operations. Submit also uses explicit,
non-interactive `gh pr view/edit --body-file` calls to enforce PR descriptions.
It deliberately does **not** edit PR titles, fetch review comments, or expose
interactive stack surgery (split / squash / reorder). Reparenting a
tracked branch is supported via `graphite_move` (`gt move --source --onto`).
Folding is supported via `graphite_change action=fold` (`gt fold [--keep]`).
Both default to read-only plans and require confirmed apply. For the remaining
surgery flows, run the underlying `gt` or `gh` command yourself in your own
terminal; the agent should not invoke them
from bash, as their defaults open interactive prompts, hunk pickers, or editors
that will hang non-interactive sessions.

## Requirements

- `gt` CLI installed and authenticated (`gt auth`).
- `gh` CLI installed and authenticated for PR body inspection/editing.
- A pi runtime that loads npm or local pi packages.

## Install

```bash
# global
pi install npm:pi-graphite

# project-local
pi install -l npm:pi-graphite

# from a local checkout
pi install /path/to/pi-graphite
# or, for one session
pi -e /path/to/pi-graphite
```

The package also ships a `graphite` skill (`skills/graphite/SKILL.md`) that pi
auto-discovers. It describes the golden path and per-recipe tool calls; the
agent loads it on demand.

## Registered tools

| Tool                     | Purpose                                                                 | Wraps                                          |
| ------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------- |
| `graphite_status`        | Read-only snapshot: current stack, or targeted branches + bounded topology snippets | `gt log --stack`, `gt info`, `gt info <branch>`, filtered `gt log` |
| `graphite_setup`         | Initialize Graphite or track an existing Git branch with explicit parent | `gt init --trunk`, `gt track --parent`         |
| `graphite_sync`          | Start-of-day / after-merge cleanup + restack                            | `gt sync`                                      |
| `graphite_get`           | Pull a branch / stack from the remote                                   | `gt get <branch>`                              |
| `graphite_navigate`      | Move around the stack                                                   | `gt checkout`, `gt up`/`down`/`top`/`bottom`   |
| `graphite_move`          | Reparent a tracked branch + restack descendants (dry-run by default)    | `gt move --source --onto`                      |
| `graphite_change`        | Create / amend / absorb / fold stacked branches                         | `gt create -am`, `gt modify -am`, `gt modify --into`, `gt absorb`, `gt fold [--keep]` |
| `graphite_submit`  | Push the entire stack, open/update PRs, and enforce descriptions (dry-run by default) | `gt submit --stack --no-edit --no-ai` + `gh pr edit --body-file` |
| `graphite_recover`       | Continue / abort / undo / restack                                       | `gt continue`, `gt abort`, `gt undo`, `gt restack` |

## Targeted status

Default status shows the current stack only:

```text
graphite_status cwd=/repo
```

For cross-stack checks, pass explicit branches. This runs `gt info <branch>`
for each branch and, with `includeTopology:true`, returns bounded snippets
from `gt log` around those names instead of dumping every tracked branch.

```text
graphite_status cwd=/repo branches=[feature-a,feature-b] includeTopology=true
```

## Golden path

```text
graphite_status
graphite_setup                               # only if repo not initialized or branch untracked
graphite_sync                                # at session start, or after merges
graphite_navigate action=checkout branch=…   # move to the target PR / parent
# user edits files
graphite_change action=create message="…"     # or action=amend
graphite_submit apply=false             # review plan + required descriptions
graphite_submit apply=true confirmRemote=true descriptions=[{branch:"feature", body:"..."}]
```

Conflict path:

```text
# resolve files, then: git add -- <paths>
graphite_recover action=continue
```

Never run `git rebase --continue` after a gt command — use
`graphite_recover action=continue` so Graphite propagates the resolution to
dependent branches.

## PR templates

Read the repository's PR template before submitting and provide the **completed
body**, including its sections and checklists, in `descriptions:[{branch, body}]`.
The tool does not merge text into templates automatically.

Preservation is based on PR bodies **before** submit. New PRs and previously empty
PRs receive the supplied descriptions even when `gt` fills them with a template
or commit text during submit. Already non-empty bodies remain untouched unless
`overwriteDescriptions:true` is explicit. This includes template-only bodies
left on existing PRs by earlier submits; use the overwrite flag to replace those.
The same rules apply to best-effort description repair after a partial submit
failure. Written bodies are read back and checked against the supplied text.

## Fold branches

Fold the current branch into its non-trunk parent, retaining existing commits
and restacking descendants of the combined branch (including other branches
stacked on that parent):

```text
graphite_status cwd=/repo
graphite_change cwd=/repo action=fold                        # read-only plan
graphite_change cwd=/repo action=fold apply=true confirmDestructive=true
graphite_status cwd=/repo
```

By default, the parent branch name survives and the current branch is deleted.
Pass `keep:true` to both plan and apply to retain the current branch name and
delete the parent instead (`gt fold --keep`). Fold does not squash commits or
stage working-tree changes, and needs no `message`. The plan is implemented by
the extension: `gt fold` itself has no `--dry-run` flag. Resolve conflicts with
`graphite_recover action=continue` (or abort). Local folding does not close PRs
or delete remote branches; review those separately before the next submit.

## Conventions and guardrails

- Every tool requires absolute `cwd`.
- `gt` is invoked with `--cwd <cwd> --no-interactive`, no shell strings. Tools that support AI metadata pass `--no-ai`.
- Editor / pager / browser env is forced safe (`GT_EDITOR=true`, `GT_PAGER=`,
  `BROWSER=true`, …). Commands have a hard timeout. `GRAPHITE_INTERACTIVE` is
  deliberately **not** set — some `gt` builds treat it as "running inside
  Graphite Interactive" and silently return empty output for read commands.
- Interactive editor / hunk / browser / reorder paths are not exposed.
- Commands echoed in tool output are safe to copy-paste back into a shell.
- `graphite_setup action=track_branch` requires explicit `branch`, explicit
  `parent`, and `confirmParent:true`; do not guess parent if unclear.
- `graphite_setup action=init_repo reset:true` needs `confirmDestructive:true`.
- `graphite_submit` defaults to `--dry-run`; `apply:true` also needs
  `confirmRemote:true`. `--force` push also requires `confirmRemote:true`.
  Before remote mutation, apply mode inspects the current stack with `gh pr view`
  and refuses if any new PR branch (or existing empty PR body) lacks a
  non-empty `descriptions:[{branch, body}]` entry. After `gt submit`, it writes
  supplied bodies with `gh pr edit --body-file` and verifies the supplied text
  (allowing line-ending and surrounding-whitespace normalization). Non-empty
  bodies from before submit are preserved unless overwrite is explicit.
- `graphite_change action=fold` defaults to a read-only plan. Applying requires
  `confirmDestructive:true`; `keep:true` chooses which branch name survives.
- `graphite_sync` with `force` or `deleteAll` needs `confirmDestructive:true`.
- `graphite_recover action=continue` refuses to proceed if tracked files
  still contain `<<<<<<<` markers, unless `allowConflictMarkers:true`.
- Output is ANSI-stripped and truncated to ~50 KB / 2000 lines. `gt` output
  is branded ("Graphite" not "Charcoal"); `gh` PR-body text is not rebranded.
- Failure output is parsed into structured `hints`
  (`notInitialized`, `conflictHalted`, `restackNeeded`, `trunkOutOfSync`,
  `branchNotTracked`, `noChangesStaged`, `checkedOutElsewhere`,
  `operatingOnTrunk`, `emptyOutput`, …).
- Read commands that must produce output (`graphite_status`) treat an
  exit-0 **empty stdout** as a failure (`emptyOutput` hint) instead of a
  misleading "ok".
- Output is also scanned (on success **and** failure) for non-fatal
  `warnings` (`skippedBranches`, `remoteChanged`, `alreadyMerged`,
  `needsRestack`). `skippedBranches` only detects skipped branch work; prompt
  skip messages from non-interactive submit are ignored. A result with
  warnings is reported as `ok (with warnings)` so a `gt sync` / `gt submit`
  that silently skipped work is not mistaken for a clean success.
- A **mutating** command that fails appends a "partial side effects possible"
  note, prompting a follow-up `graphite_status`.

### Git hooks

Git hooks in the target repository run as normal; this extension does not
bypass them. Treat them as part of your repo's trust boundary.

## Development

```bash
npm install
npm run check
npm test
```

Tests load the tools through Jiti and mock the process boundary; they never
push real branches or modify real PRs.

## License

MIT
