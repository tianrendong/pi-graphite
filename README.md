# pi-graphite

Structured pi tools that wrap the [Graphite](https://graphite.com) `gt` CLI so
agents (and humans) can drive stacked PR workflows safely from pi.

This package is **Layer A** of the planned design — one tool per Graphite
domain resource (repo / stack / branch / PR / recovery), not one tool per `gt`
subcommand and not a workflow orchestrator.

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

## Registered tools

| Tool                         | Resource | Wraps                                             |
| ---------------------------- | -------- | ------------------------------------------------- |
| `graphite_repo`              | repo     | `gt trunk`, `gt init`, `gt log short`             |
| `graphite_stack_view`        | stack    | `gt log` / `gt log short` / `gt log long`         |
| `graphite_stack_restack`     | stack    | `gt restack` (+ `--branch/--downstack/--upstack/--only`) |
| `graphite_stack_reorganize`  | stack    | `gt move`, `gt fold`, `gt split --by-file`        |
| `graphite_branch_inspect`    | branch   | `gt info` (+ `gt parent`, `gt children`)          |
| `graphite_branch_create`     | branch   | `gt create`                                       |
| `graphite_branch_update`     | branch   | `gt modify`, `gt absorb`, `gt squash`, `gt pop`, `gt rename`, `gt delete` |
| `graphite_branch_tracking`   | branch   | `gt track`, `gt untrack`, `gt freeze`, `gt unfreeze` |
| `graphite_branch_navigate`   | branch   | `gt checkout`, `gt up`, `gt down`, `gt top`, `gt bottom` |
| `graphite_remote_sync`       | remote   | `gt sync`, `gt get`                               |
| `graphite_pr_submit`         | PR       | `gt submit` (dry-run by default)                  |
| `graphite_pr_lifecycle`      | PR       | `gt pr`, `gt merge`, `gt unlink`                  |
| `graphite_recovery`          | recovery | `gt continue`, `gt abort`, `gt undo`              |

## Conventions

- Every tool requires an absolute `cwd`.
- `gt` is invoked with `--cwd <cwd> --no-interactive` by default. No shell strings.
- Remote / destructive operations require explicit ack flags:
  - `graphite_pr_submit` defaults to `--dry-run`; `apply: true` needs `confirmRemote: true`.
  - `graphite_pr_lifecycle action=merge` defaults to `--dry-run`; `apply: true` needs `confirmRemote: true`.
  - `graphite_remote_sync` with `force` or `deleteAll` needs `confirmDestructive: true`.
  - `graphite_branch_update action=delete close:true` needs `confirmRemote: true`.
  - `graphite_stack_reorganize action=fold foldClose:true` needs `confirmRemote: true`.
- Output is ANSI-stripped and truncated to ~50 KB / 2000 lines.
- Stderr is parsed into structured `hints` (e.g. `notInitialized`, `conflictHalted`,
  `checkedOutElsewhere`, `restackNeeded`, `trunkOutOfSync`).

## Intentional non-goals (in Layer A)

- No `graphite_raw` passthrough. Use bash for arbitrary `gt` flags.
- No workflow orchestration (plan → apply across multiple commands).
- No wrapping of `gt add/cherry-pick/rebase/reset/restore` passthroughs.
- No wrapping of browser/help commands (`dash`, `docs`, `guide`, `changelog`,
  `feedback`, `demo`, `completion`, `fish`).
- `gt reorder` (editor-only) and `gt split --by-commit / --by-hunk`
  (interactive-only) are intentionally not exposed.

Layer B (workflow tools) and Layer C (raw escape hatch) are planned, not built.

## License

MIT
