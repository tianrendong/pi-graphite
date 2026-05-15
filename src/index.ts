import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerRepo } from "./tools/repo";
import {
  registerStackView,
  registerStackRestack,
  registerStackReorganize,
} from "./tools/stack";
import {
  registerBranchInspect,
  registerBranchCreate,
  registerBranchUpdate,
  registerBranchTracking,
  registerBranchNavigate,
} from "./tools/branch";
import { registerRemoteSync } from "./tools/remote";
import { registerPrSubmit, registerPrLifecycle } from "./tools/pr";
import { registerRecovery } from "./tools/recovery";

/**
 * pi-graphite — Layer A (Domain Resource).
 *
 * Registers structured tools that wrap the Graphite (`gt`) CLI:
 *
 *   graphite_repo
 *   graphite_stack_view
 *   graphite_stack_restack
 *   graphite_stack_reorganize
 *   graphite_branch_inspect
 *   graphite_branch_create
 *   graphite_branch_update
 *   graphite_branch_tracking
 *   graphite_branch_navigate
 *   graphite_remote_sync
 *   graphite_pr_submit
 *   graphite_pr_lifecycle
 *   graphite_recovery
 *
 * Conventions:
 * - Every tool requires absolute `cwd`.
 * - `gt` is invoked with --cwd <cwd> --no-interactive by default.
 * - Remote / destructive operations require explicit `confirmRemote` /
 *   `confirmDestructive` flags. Submit/merge default to dry-run.
 * - Output is ANSI-stripped and truncated to ~50KB / 2000 lines.
 */
export default function (pi: ExtensionAPI) {
  registerRepo(pi);

  registerStackView(pi);
  registerStackRestack(pi);
  registerStackReorganize(pi);

  registerBranchInspect(pi);
  registerBranchCreate(pi);
  registerBranchUpdate(pi);
  registerBranchTracking(pi);
  registerBranchNavigate(pi);

  registerRemoteSync(pi);

  registerPrSubmit(pi);
  registerPrLifecycle(pi);

  registerRecovery(pi);
}
