# pi-graphite

Opinionated pi tools + skill that wrap the [Graphite](https://graphite.com)
`gt` CLI for stacked PR workflows. Seven tools, one correct path.

```
graphite_status → (graphite_setup if needed) → graphite_sync → graphite_navigate
       → graphite_change → graphite_submit (dry-run) → graphite_submit (apply)
```

The extension wraps `gt` only. It deliberately does **not** call `gh`, edit
PR titles/bodies, fetch review comments, or perform stack surgery (split /
fold / move / squash / reorder). For those flows, run the underlying `gt`
or `gh` command yourself in your own terminal; the agent should not invoke
them from bash, as their defaults open interactive prompts, hunk pickers,
or editors that will hang non-interactive sessions.

## Requirements

- `gt` CLI installed and authenticated (`gt auth`).
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
| `graphite_status`        | Read-only snapshot: current stack + current branch + PR + restack hints | `gt log --stack`, `gt info`                    |
| `graphite_setup`         | Initialize Graphite or track an existing Git branch with explicit parent | `gt init --trunk`, `gt track --parent`         |
| `graphite_sync`          | Start-of-day / after-merge cleanup + restack                            | `gt sync`                                      |
| `graphite_navigate`      | Move around the stack                                                   | `gt checkout`, `gt up`/`down`/`top`/`bottom`   |
| `graphite_change`        | Create / amend a stacked branch                                         | `gt create -am`, `gt modify -am`, `gt modify --into`, `gt absorb` |
| `graphite_submit`  | Push the entire stack and open/update PRs (dry-run by default)          | `gt submit --stack --no-edit --no-ai`          |
| `graphite_recover`       | Continue / abort / undo                                                 | `gt continue`, `gt abort`, `gt undo`           |

## Golden path

```text
graphite_status
graphite_setup                               # only if repo not initialized or branch untracked
graphite_sync                                # at session start, or after merges
graphite_navigate action=checkout branch=…   # move to the target PR / parent
# user edits files
graphite_change action=create message="…"     # or action=amend
graphite_submit apply=false             # review the dry-run plan
graphite_submit apply=true confirmRemote=true
```

Conflict path:

```text
# resolve files, then: git add -- <paths>
graphite_recover action=continue
```

Never run `git rebase --continue` after a gt command — use
`graphite_recover action=continue` so Graphite propagates the resolution to
dependent branches.

## Conventions and guardrails

- Every tool requires absolute `cwd`.
- `gt` is invoked with `--cwd <cwd> --no-interactive`, no shell strings. Tools that support AI metadata pass `--no-ai`.
- Editor / pager / browser env is forced safe (`GT_EDITOR=true`, `GT_PAGER=`,
  `BROWSER=true`, …). Commands have a hard timeout.
- Interactive editor / hunk / browser / reorder paths are not exposed.
- Commands echoed in tool output are safe to copy-paste back into a shell.
- `graphite_setup action=track_branch` requires explicit `branch`, explicit
  `parent`, and `confirmParent:true`; do not guess parent if unclear.
- `graphite_setup action=init_repo reset:true` needs `confirmDestructive:true`.
- `graphite_submit` defaults to `--dry-run`; `apply:true` also needs
  `confirmRemote:true`. `--force` push also requires `confirmRemote:true`.
- `graphite_sync` with `force` or `deleteAll` needs `confirmDestructive:true`.
- `graphite_recover action=continue` refuses to proceed if tracked files
  still contain `<<<<<<<` markers, unless `allowConflictMarkers:true`.
- Output is ANSI-stripped, branded ("Graphite" not "Charcoal"), and truncated
  to ~50 KB / 2000 lines.
- Stderr is parsed into structured `hints`
  (`notInitialized`, `conflictHalted`, `restackNeeded`, `trunkOutOfSync`,
  `branchNotTracked`, `noChangesStaged`, `checkedOutElsewhere`,
  `operatingOnTrunk`, …).

### Git hooks

Git hooks in the target repository run as normal; this extension does not
bypass them. Treat them as part of your repo's trust boundary.

## License

MIT
