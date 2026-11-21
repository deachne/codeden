import type { FactoryGithub, MainHead } from "./github-port";

/**
 * CI on a project's branch as the loop sees it on one tick:
 * - `red`: `head` is red, or it is the last red head while CI still runs on a newer one (a
 *   merge that may fix it isn't known to until its CI passes);
 * - `running`: CI on the head hasn't finished (or reported), and no red head came before it;
 * - `green`: CI passed on the head.
 *
 * Release mode reads the release branch instead of the default branch (`branch`), through
 * `branchHead` rather than `mainHead`.
 */
export type MainCiView =
  | { state: "red"; head: MainHead }
  | { state: "running" }
  | { state: "green" };

/**
 * Reads of CI on each project's branches (§10.1), in memory. Each branch's head is read from
 * GitHub at most once per tick, shared by the verify step, the merge queue and intake
 * (`runTick` calls `beginTick`), and the last red head is kept until a green one replaces it.
 */
export class MainCiReads {
  private readonly reads = new Map<string, Promise<MainHead | null>>();
  private readonly red = new Map<string, MainHead>();

  /** A new tick reads the branches from GitHub again. */
  beginTick(projectId: string): void {
    for (const key of this.reads.keys()) {
      if (key === projectId || key.startsWith(`${projectId}:`)) this.reads.delete(key);
    }
  }

  /**
   * The branch's head and its CI, read once per tick; null when GitHub couldn't be read. Without
   * `branch` this is the default branch's head, as before.
   */
  head(github: FactoryGithub, projectId: string, branch?: string): Promise<MainHead | null> {
    const key = branch ? `${projectId}:${branch}` : projectId;
    let read = this.reads.get(key);
    if (!read) {
      const readHead = branch ? github.branchHead(projectId, branch) : github.mainHead(projectId);
      read = readHead.then(
        (head) => {
          if (head.checks === "failure") this.red.set(key, head);
          else if (head.checks === "success") this.red.delete(key);
          return head;
        },
        () => null,
      );
      this.reads.set(key, read);
    }
    return read;
  }

  /** CI on the branch on this tick; null when GitHub couldn't be read. */
  async view(
    github: FactoryGithub,
    projectId: string,
    branch?: string,
  ): Promise<MainCiView | null> {
    const key = branch ? `${projectId}:${branch}` : projectId;
    const head = await this.head(github, projectId, branch);
    if (!head) return null;
    if (head.checks === "success") return { state: "green" };
    const red = this.red.get(key);
    return red ? { state: "red", head: red } : { state: "running" };
  }
}
