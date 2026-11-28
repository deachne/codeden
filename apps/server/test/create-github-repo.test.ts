import type { ItemOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rowToItemRecord } from "../src/db/rows";
import { items } from "../src/db/schema";
import type { AppServices } from "../src/services/container";
import { repoNameProblem } from "../src/services/github/repositories";
import { QuestionBroker } from "../src/services/sessions/questions";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

// The tool attaches its card to the session's running turn; these sessions have none.
vi.mock("../src/mcp/transcript", () => ({
  currentTurn: () => ({ threadId: "t1", turnId: "u1" }),
}));

const { createGithubRepoTool } = await import("../src/mcp/tools/github/create-github-repo");

describe("repository names", () => {
  it("refuses names GitHub would, in plain words", () => {
    for (const bad of [
      "",
      "   ",
      "my repo",
      "a/b",
      "x".repeat(101),
      ".",
      "..",
      "tool.git",
      "ünï",
    ]) {
      expect(repoNameProblem(bad), JSON.stringify(bad)).toBeTruthy();
    }
    for (const good of ["notes", "my-repo_2", ".github", "v1.2.3", "x".repeat(100), " padded "]) {
      expect(repoNameProblem(good), JSON.stringify(good)).toBeUndefined();
    }
  });
});

describe("create_github_repo", () => {
  let env: GithubEnv;
  let sent: string[];
  let unattended: boolean;
  let services: AppServices;
  let sessionId: string;

  beforeEach(() => {
    env = createGithubEnv();
    sent = [];
    unattended = false;
    sessionId = env.addSession({ role: "pm" }).id;
    const questions = new QuestionBroker({
      db: env.db.db,
      store: env.store,
      sendMessage: () => async (_id, text) => {
        sent.push(text);
      },
    });
    services = {
      github: env.service,
      questions,
      factory: { isUnattended: () => unattended },
    } as unknown as AppServices;
  });
  afterEach(() => env.close());

  const call = (input: Record<string, unknown>, role: "pm" | "orchestrator" = "pm") =>
    createGithubRepoTool.handler(createGithubRepoTool.input.parse(input), {
      services,
      sessionId,
      projectId: null,
      role,
      caller: "mcp",
      signal: new AbortController().signal,
    });
  const cards = () =>
    env.db.db
      .select()
      .from(items)
      .all()
      .map(rowToItemRecord)
      .map((r) => r.item)
      .filter((i): i is ItemOf<"user_question"> => i.kind === "user_question");
  const openCard = () => {
    const card = cards().find((c) => c.status === "in_progress");
    if (!card) throw new Error("no open card");
    return card;
  };
  const answer = (label: string, by: "user" | "pm" = "user") =>
    services.questions.respond(
      sessionId,
      openCard().requestId,
      { kind: "answer", answers: { q1: [label] } },
      by,
    );
  const created = () => [...env.gh.repositories.keys()];

  it("shows a card and creates nothing before Approve; Approve makes a private repo", async () => {
    const result = await call({ name: "farm-notes", description: "Field notes" }, "orchestrator");
    expect(String(result)).toMatch(/^pending/);
    expect(created()).toEqual([]);
    const card = openCard();
    const q = card.questions[0];
    expect(q?.question).toContain('private GitHub repository called "farm-notes"');
    expect(q?.question).toContain("Account: octo");
    expect(q?.question).toContain("Only you can see it");
    expect(q?.question).toContain("can't undo");
    expect(q?.options.map((o) => o.label)).toEqual(["Approve", "Deny"]);
    expect(q?.allowFreeText).toBe(false);

    await answer("Approve");
    expect(created()).toEqual(["octo/farm-notes"]);
    expect(env.gh.repositories.get("octo/farm-notes")).toEqual({
      private: true,
      description: "Field notes",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Created private repository octo/farm-notes");
    expect(sent[0]).toContain("https://github.com/octo/farm-notes");
  });

  it("returns the link straight away when the PM's call is still waiting", async () => {
    const pending = call({ name: "barn" });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    expect(created()).toEqual([]);
    await answer("Approve");
    expect(String(await pending)).toContain("https://github.com/octo/barn");
    expect(sent).toEqual([]);
  });

  it("says plainly that a public repository can be seen by anyone, and creates it public", async () => {
    await call({ name: "open-notes", private: false }, "orchestrator");
    const q = openCard().questions[0];
    expect(q?.question).toContain('public GitHub repository called "open-notes"');
    expect(q?.question).toContain("Anyone on the internet can see it");
    await answer("Approve");
    expect(env.gh.repositories.get("octo/open-notes")?.private).toBe(false);
  });

  it("creates nothing on Deny and tells the caller", async () => {
    const pending = call({ name: "nope" });
    await vi.waitFor(() => expect(cards()).toHaveLength(1));
    await answer("Deny");
    expect(String(await pending)).toMatch(/^Not created: the user did not approve/);
    expect(created()).toEqual([]);
  });

  it("creates nothing on a dismissed card, and messages an orchestrator that didn't wait", async () => {
    await call({ name: "nope" }, "orchestrator");
    await services.questions.respond(sessionId, openCard().requestId, { kind: "cancel" });
    expect(created()).toEqual([]);
    expect(sent[0]).toMatch(/^Not created: the user dismissed/);
  });

  it("never lets anyone but the user approve", async () => {
    await call({ name: "sneaky" }, "orchestrator");
    await answer("Approve", "pm");
    expect(created()).toEqual([]);
    expect(sent[0]).toMatch(/only the user can approve/);
  });

  it("doesn't treat a typed chat reply as approval", async () => {
    await call({ name: "typed" }, "orchestrator");
    services.questions.answerOpenWithText(sessionId, "Approve");
    expect(created()).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("asks every time, even for a name approved before", async () => {
    await call({ name: "again" }, "orchestrator");
    await answer("Approve");
    await call({ name: "again-2" }, "orchestrator");
    expect(cards().filter((c) => c.status === "in_progress")).toHaveLength(1);
    expect(created()).toEqual(["octo/again"]);
  });

  it("refuses bad names and taken names without showing a card", async () => {
    await expect(call({ name: "my repo" })).rejects.toThrow(/letters, numbers/);
    await expect(call({ name: "" })).rejects.toThrow(/needs a name/);
    env.gh.repositories.set("octo/taken", { private: true, description: null });
    await expect(call({ name: "taken" })).rejects.toThrow(
      /already has a repository called "taken"/,
    );
    expect(cards()).toEqual([]);
  });

  it("is denied without a card in a dark factory", async () => {
    unattended = true;
    expect(String(await call({ name: "robot" }))).toMatch(/^Not approved/);
    expect(cards()).toEqual([]);
    expect(created()).toEqual([]);
  });

  it("reports a name taken between the card and the approval", async () => {
    await call({ name: "race" }, "orchestrator");
    env.gh.repositories.set("octo/race", { private: true, description: null });
    await answer("Approve");
    expect(sent[0]).toMatch(/^Not created: the user approved, but GitHub refused it/);
  });

  it("is listed for the orchestrator and PMs only", () => {
    expect([...createGithubRepoTool.roles].sort()).toEqual(["orchestrator", "pm"]);
  });
});
