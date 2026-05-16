import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerStatus } from "./tools/status";
import { registerSetup } from "./tools/setup";
import { registerSync } from "./tools/sync";
import { registerNavigate } from "./tools/navigate";
import { registerChange } from "./tools/change";
import { registerSubmit } from "./tools/submit";
import { registerRecover } from "./tools/recover";

/**
 * pi-graphite — opinionated `gt` wrapper for stacked PR workflows.
 *
 * Seven workflow tools, one correct path:
 *
 *   graphite_status        — see where you are in the stack
 *   graphite_setup         — init repo / track existing branch when needed
 *   graphite_sync          — start-of-day / after-merge cleanup + restack
 *   graphite_navigate      — move to the branch / PR you want to mutate
 *   graphite_change        — create or amend a stacked branch
 *   graphite_submit  — push the whole stack and open/update PRs
 *   graphite_recover       — continue / abort / undo after conflicts or mistakes
 *
 * Golden path:
 *
 *   status → (setup if needed) → sync → navigate → change → submit(dry-run) → submit(apply)
 *
 * Conflict path:
 *
 *   resolve files → graphite_recover continue
 *
 * Conventions:
 * - Every tool requires absolute `cwd`.
 * - `gt` is invoked with --cwd <cwd> --no-interactive by default; tools that support AI metadata pass --no-ai.
 * - Editor / pager / browser env is forced safe; interactive editor / hunk /
 *   browser flows are not exposed.
 * - graphite_submit defaults to --dry-run; apply requires
 *   `apply:true` AND `confirmRemote:true`.
 * - graphite_sync with force / deleteAll requires `confirmDestructive:true`.
 * - This extension wraps `gt` only. It deliberately does not call `gh`,
 *   touch PR titles/bodies, run reviews, or do stack surgery
 *   (split/fold/move/squash). Use the gt CLI or another tool for those.
 */
export default function (pi: ExtensionAPI) {
  registerStatus(pi);
  registerSetup(pi);
  registerSync(pi);
  registerNavigate(pi);
  registerChange(pi);
  registerSubmit(pi);
  registerRecover(pi);
}
