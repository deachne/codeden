import { badRequest, conflict, ServiceError } from "../errors";
import type { GithubClient } from "./client";

/** A repository CodeDen created for the owner (§8.3 `create_github_repo`). */
export interface CreatedRepository {
  /** `owner/name`. */
  fullName: string;
  url: string;
  private: boolean;
}

/** GitHub's own limit for a repository name. */
const MAX_NAME_LENGTH = 100;

/**
 * Why `name` can't be a GitHub repository name, in plain words, or undefined when it can. Checked
 * before any card is shown, so a typo never reaches the owner.
 */
export function repoNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "The repository needs a name.";
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `The name is too long (GitHub allows ${MAX_NAME_LENGTH} characters at most).`;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
    return "A repository name can only use letters, numbers, dots, dashes and underscores (no spaces or slashes).";
  }
  if (trimmed === "." || trimmed === "..") return `"${trimmed}" can't be used as a name.`;
  if (trimmed.toLowerCase().endsWith(".git")) return 'A name can\'t end in ".git".';
  return undefined;
}

/** The name as it will be created: trimmed. */
export function cleanRepoName(name: string): string {
  return name.trim();
}

/** Throws a plain-words 400 when the name isn't usable. */
export function assertRepoName(name: string): string {
  const problem = repoNameProblem(name);
  if (problem) throw badRequest(problem, "invalid_repo_name");
  return cleanRepoName(name);
}

/** Whether `login/name` already exists (404 means it is free). */
export async function repoExists(
  client: GithubClient,
  login: string,
  name: string,
): Promise<boolean> {
  try {
    await client.run((o) => o.rest.repos.get({ owner: login, repo: name }));
    return true;
  } catch (error) {
    if (error instanceof ServiceError && error.code === "github_not_found") return false;
    throw error;
  }
}

/**
 * Create a repository under the signed-in account. Nothing else: no clone, no files, no CodeDen
 * project. A name taken in the meantime is reported in plain words.
 */
export async function createRepository(
  client: GithubClient,
  req: { name: string; private: boolean; description?: string },
): Promise<CreatedRepository> {
  const name = assertRepoName(req.name);
  try {
    const { data } = await client.run((o) =>
      o.rest.repos.createForAuthenticatedUser({
        name,
        private: req.private,
        ...(req.description ? { description: req.description } : {}),
        auto_init: false,
      }),
    );
    return { fullName: data.full_name, url: data.html_url, private: data.private };
  } catch (error) {
    if (
      error instanceof ServiceError &&
      error.code === "github_validation" &&
      /already exists/i.test(error.message)
    ) {
      throw conflict(
        `The account already has a repository called "${name}": ${error.message}`,
        "repo_exists",
      );
    }
    throw error;
  }
}
