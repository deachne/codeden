import { IDEAS_MOVED_LABEL } from "@codeden/contracts";
import type { GithubClient } from "./client";
import { commentOnIssue } from "./issues";

/** An idea in the Ideas repository that a new issue says it came from. */
export interface IdeaSource {
  owner: string;
  repo: string;
  number: number;
}

const IDEA_SOURCE =
  /Idea source:\s*(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:#|\/issues\/)(\d+)/i;

/**
 * The idea an issue body names on its `Idea source: owner/repo#N` line (or the issue's URL),
 * when that repository is the Ideas repository; otherwise null.
 */
export function ideaSourceOf(body: string, ideasRepo: string): IdeaSource | null {
  const m = body.match(IDEA_SOURCE);
  if (!m) return null;
  const [, owner, repo, number] = m as unknown as [string, string, string, string];
  if (`${owner}/${repo}`.toLowerCase() !== ideasRepo.trim().toLowerCase()) return null;
  return { owner, repo, number: Number(number) };
}

/**
 * Marks the idea `moved` and comments where it went, so the Ideas repository shows that the
 * idea now lives in a project. Best effort: a failure is logged and never fails the new issue.
 */
export async function markIdeaMoved(
  client: GithubClient,
  idea: IdeaSource,
  to: { projectName: string; url: string },
  log?: (message: string) => void,
): Promise<void> {
  try {
    await client.run(async (octokit) => {
      await octokit.rest.issues.addLabels({
        owner: idea.owner,
        repo: idea.repo,
        issue_number: idea.number,
        labels: [IDEAS_MOVED_LABEL],
      });
    });
    await commentOnIssue(
      { client },
      { owner: idea.owner, repo: idea.repo, remoteUrl: "", defaultBranch: "" },
      idea.number,
      `Moved to ${to.projectName} as ${to.url}`,
    );
  } catch (error) {
    log?.(
      `github: could not mark idea ${idea.owner}/${idea.repo}#${idea.number} moved: ${String(error)}`,
    );
  }
}
