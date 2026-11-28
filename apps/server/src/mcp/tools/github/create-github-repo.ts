import { z } from "zod";
import type { AppServices } from "../../../services/container";
import { UNATTENDED_APPROVAL } from "../../../services/factory/unattended";
import { assertRepoName } from "../../../services/github/repositories";
import type { AskOutcome } from "../../../services/sessions/questions";
import { defineTool, ToolError } from "../../define";
import { currentTurn } from "../../transcript";

const APPROVE = "Approve";
const DENY = "Deny";

interface RepoRequest {
  name: string;
  private: boolean;
  description?: string;
}

/** The card the owner reads, in plain words: what it does, where, who can see it, no undo. */
export function repoApprovalQuestion(login: string, req: RepoRequest): string {
  const who = req.private
    ? "Only you can see it (private)."
    : "Anyone on the internet can see it (public).";
  return [
    `Create a ${req.private ? "private" : "public"} GitHub repository called "${req.name}"?`,
    "",
    `- Account: ${login}`,
    `- Who can see it: ${who}`,
    ...(req.description ? [`- Description: ${req.description}`] : []),
    "",
    "It makes an empty repository on GitHub and nothing else. It is not copied to this computer and not added to CodeDen as a project.",
    "CodeDen can't undo this: to delete the repository later you do it on GitHub.",
  ].join("\n");
}

/**
 * What the caller is told for an answer: creates the repository only for the user's own
 * "Approve". Anything else (Deny, a dismissed card, free text, an answer from someone who isn't
 * the user) creates nothing.
 */
async function settle(services: AppServices, req: RepoRequest, outcome: AskOutcome) {
  if (outcome.status === "pending") return pendingText();
  if (outcome.status === "dismissed") {
    return `Not created: the user dismissed the approval card. Nothing was created on GitHub.`;
  }
  if (outcome.by !== "user") {
    return "Not created: only the user can approve a new repository. Nothing was created on GitHub.";
  }
  if (outcome.answers.q1?.[0] !== APPROVE) {
    const said = (outcome.answers.q1 ?? []).join(", ") || "no answer";
    return `Not created: the user did not approve (answer: ${said}). Nothing was created on GitHub; don't ask again unless the user does.`;
  }
  try {
    const repo = await services.github.createRepository(req);
    return `Created ${repo.private ? "private" : "public"} repository ${repo.fullName}: ${repo.url}\nIt is not cloned and not added to CodeDen as a project; the user can ask for that.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `Not created: the user approved, but GitHub refused it (${reason}).`;
  }
}

function pendingText(): string {
  return "pending: the approval card is waiting in the user's inbox. Nothing is created until the user taps Approve. Do not wait or ask again: finish what you can, then end your turn; the result arrives as your next message.";
}

/**
 * `create_github_repo` (§8.3, §11.2): the one narrow way for the orchestrator and PMs to create a
 * GitHub repository. It only creates, never edits or deletes. Every call asks the user with an
 * approval card (never remembered, never granted for them) and the read-only `gh` allowlist
 * stays as it is.
 */
export const createGithubRepoTool = defineTool({
  name: "create_github_repo",
  description:
    "Create a new, empty GitHub repository under the owner's own GitHub account, after the owner approves it on a card (shown every time, for private repos too). Use it only when the user asked for a new repository. Private unless the user asked for public. It does not clone the repository or add it to CodeDen; offer that afterwards. Returns the repository's link. If it returns 'pending', finish what you can and end your turn: the result arrives as your next message.",
  roles: ["orchestrator", "pm"],
  scope: "session",
  input: z.object({
    name: z.string().describe("Repository name: letters, numbers, dots, dashes, underscores"),
    private: z
      .boolean()
      .optional()
      .describe("Default true. false only when the user asked for a public repository."),
    description: z.string().trim().max(350).optional(),
  }),
  handler: async (input, { services, sessionId, signal, role }) => {
    let name: string;
    try {
      name = assertRepoName(input.name);
    } catch (error) {
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }
    const req: RepoRequest = {
      name,
      private: input.private ?? true,
      ...(input.description ? { description: input.description } : {}),
    };
    // Nobody is there to approve in a dark factory, and nothing is approved on their behalf.
    if (services.factory.isUnattended(sessionId)) return UNATTENDED_APPROVAL;

    let login: string;
    try {
      login = await services.github.accountLogin();
      if (await services.github.repositoryExists(login, name)) {
        throw new ToolError(
          `${login} already has a repository called "${name}". Nothing was created; pick another name.`,
        );
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError(error instanceof Error ? error.message : String(error));
    }

    const outcome = await services.questions.ask(
      sessionId,
      currentTurn(services, sessionId),
      {
        header: "Create repository",
        question: repoApprovalQuestion(login, req),
        options: [
          {
            label: APPROVE,
            description: `Create the ${req.private ? "private" : "public"} repository ${login}/${name}`,
          },
          { label: DENY, description: "Don't create anything" },
        ],
        multiSelect: false,
        allowFreeText: false,
      },
      signal,
      role !== "orchestrator",
      (late) => settle(services, req, late),
    );
    return settle(services, req, outcome);
  },
});
