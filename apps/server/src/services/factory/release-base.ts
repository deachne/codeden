import type { Project } from "@codeden/contracts";
import { errorMessage } from "../errors";
import type { FactoryContext } from "./context";

/**
 * Make sure the release branch exists before a session builds on it (`baseRef: <branch>`).
 * The branch is otherwise created only by the release refresh and by a merge, so a builder
 * started right after release mode was turned on would fail at its worktree. Null when the
 * branch exists (or was just created from the default branch); otherwise why it couldn't be.
 */
export async function ensureReleaseBase(
  ctx: FactoryContext,
  project: Project,
  base: string,
): Promise<string | null> {
  try {
    await ctx.github.ensureBranch(project.id, base);
    return null;
  } catch (error) {
    return `Could not create the release branch: ${errorMessage(error)}`;
  }
}
