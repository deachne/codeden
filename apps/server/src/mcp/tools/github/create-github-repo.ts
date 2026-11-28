import { z } from "zod";
import type { AppServices } from "../../../services/container";
import { ServiceError } from "../../../services/errors";
import { assertRepoName } from "../../../services/github/repositories";
import type { AskOutcome } from "../../../services/sessions/questions";
import { defineTool, ToolError } from "../../define";
import { currentTurn } from "../../transcript";

const APPROVE = "Approve";
const DENY = "Deny";

/** The card's header; `SERVER_HANDLED_HEADERS` in the question broker names it too. */
export const REPO_CARD_HEADER = "Create repository";

/** What a dark-factory PM is told: nobody is there to approve, and nothing is approved for them. */
const UNATTENDED_REPO =
  "Not asked: this project runs as a dark factory, so nobody is watching to approve a new repository, and nothing is approved on the user's behalf. Don't try again. If the repository is needed, call `factory_record_decision` with `needsHuman: true`, saying what you needed and why, and carry on with whatever doesn't depend on it.";

interface RepoRequest {
  name: string;
  private: boolean;
  description?: string;
}

/** Agent text on one line inside quotes, so it can't pose as a line of the card. */
function oneLine(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " ").trim());
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
    ...(req.description ? [`- Description the agent wrote: ${oneLine(req.description)}`] : []),
    "",
    "It makes an empty repository on GitHub and nothing else. It is not copied to this computer and not added to CodeDen as a project.",
    "CodeDen can't undo this: to delete the repository later you do it on GitHub.",
  ].join("\n");
}

/** Statuses where GitHub definitely did not create the repository. */
const REFUSED = new Set([400, 403, 404, 409, 422]);

/**
 * What the caller is told for an answer: creates the repository only for the user's own
 * "Approve", on the account the card named. Anything else (Deny, a dismissed card, free text,
 * an answer from someone who isn't the user) creates nothing.
 */
async function settle(services: AppServices, login: string, req: RepoRequest, outcome: AskOutcome) {
  if (outcome.status === "pending") return pendingText();
  if (outcome.status === "dismissed") {
    return "Not created: the user dismissed the approval card. Nothing was created on GitHub.";
  }
  if (outcome.by !== "user") {
    return "Not created: only the user can approve a new repository. Nothing was created on GitHub.";
  }
  if (outcome.answers.q1?.[0] !== APPROVE) {
    const said = (outcome.answers.q1 ?? []).join(", ") || "no answer";
    return `Not created: the user did not approve (answer: ${said}). Nothing was created on GitHub; don't ask again unless the user does.`;
  }
  try {
    // The card named an account; GitHub may have been switched to another since.
    const now = await services.github.currentLogin();
    if (now !== login) {
      return `Not created: the card named the account ${login}, but CodeDen is now signed in to GitHub as ${now}. Nothing was created; ask again with a new card.`;
    }
    const repo = await services.github.createRepository(req);
    return `Created ${repo.private ? "private" : "public"} repository ${repo.fullName}: ${repo.url}\nIt is not cloned and not added to CodeDen as a project; the user can ask for that.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof ServiceError && REFUSED.has(error.status)) {
      return `Not created: the user approved, but GitHub refused it (${reason}).`;
    }
    return `Unknown: the user approved, but the request to GitHub failed (${reason}). The repository may or may not exist: check the user's GitHub account before asking again.`;
  }
}

function pendingText(): string {
  return "pending: the approval card is waiting in the user's inbox. Nothing is created until the user taps Approve. Do not wait or ask again: finish what you can, then end your turn; the result arrives as your next message.";
}

/**
 * `create_github_repo` (§8.3, §11.2): the one narrow way for the orchestrator and PMs to create a
 * GitHub repository. It only creates, never edits or deletes. Every call asks the user with an
 * approval card (never remembered, never granted for them) and the read-only `gh` allowlist
 * stays as it is. The call never waits on the card: the server acts on the answer and sends the
 * result to the caller as a message.
 */
export const createGithubRepoTool = defineTool({
  name: "create_github_repo",
  description:
    "Create a new, empty GitHub repository under the owner's own GitHub account, after the owner approves it on a card (shown every time, for private repos too). Use it only when the user asked for a new repository. Private unless the user asked for public. It does not clone the repository or add it to CodeDen; offer that afterwards. It returns 'pending' at once: finish what you can and end your turn; the result (the repository's link, or why nothing was created) arrives as your next message.",
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
  handler: async (input, { services, sessionId }) => {
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
    if (services.factory.isUnattended(sessionId)) return UNATTENDED_REPO;

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
        header: REPO_CARD_HEADER,
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
      undefined,
      // Never wait: the answer is acted on by the server (below), whenever it comes.
      false,
      async (late) =>
        `Result of your create_github_repo request:\n${await settle(services, login, req, late)}`,
    );
    return settle(services, login, req, outcome);
  },
});
