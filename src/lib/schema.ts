import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export { Type, StringEnum };
export type { Static };

/** Stage mode shared by create / modify. */
export const StageMode = StringEnum([
  "none",
  "all",
  "update",
  "patch",
] as const);

export function stageArgs(mode: "none" | "all" | "update" | "patch"): string[] {
  switch (mode) {
    case "none":
      return [];
    case "all":
      return ["--all"];
    case "update":
      return ["--update"];
    case "patch":
      return ["--patch"];
  }
}

/** Common cwd param. Required so we always pass an absolute path to gt. */
export const CwdParam = Type.String({
  description: "Absolute path to the repository working directory.",
});

/** Helper to require an explicit ack flag for irreversible/remote ops. */
export function requireConfirm(
  flag: boolean | undefined,
  what: string,
): void {
  if (!flag) {
    throw new Error(
      `Refused: ${what} would mutate remote or destructive state. Pass the matching confirm flag (e.g. confirmRemote: true) to proceed.`,
    );
  }
}

/** Shape returned to the LLM by every tool. */
export type ToolReturn = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
};
