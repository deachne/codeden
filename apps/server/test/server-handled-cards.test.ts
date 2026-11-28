import { agentEventToNewEvent, type ItemOf } from "@codeden/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { rowToItemRecord } from "../src/db/rows";
import { items } from "../src/db/schema";
import type { ProjectService } from "../src/services/projects/project-service";
import { QuestionBroker } from "../src/services/sessions/questions";
import { WorktreeCleanup } from "../src/services/sessions/worktree-cleanup";
import { createGithubEnv, type GithubEnv } from "./support/github-env";

const TURN = { threadId: "t1", turnId: "u1" };
const card = (header: string) => ({
  header,
  question: "Create it?",
  options: [{ label: "Approve" }, { label: "Deny" }],
  multiSelect: false,
  allowFreeText: false,
});

let env: GithubEnv;
let broker: QuestionBroker;
let sent: string[];

beforeEach(() => {
  env = createGithubEnv();
  sent = [];
  broker = new QuestionBroker({
    db: env.db.db,
    store: env.store,
    sendMessage: () => async (_id, text) => {
      sent.push(text);
    },
    waitMs: 20,
  });
});
afterEach(() => env.close());

const rows = () =>
  env.db.db
    .select()
    .from(items)
    .all()
    .map((r) => rowToItemRecord(r));
const cards = () =>
  rows()
    .map((r) => r.item)
    .filter((i): i is ItemOf<"user_question"> => i.kind === "user_question");

describe("cards the server acts on", () => {
  it("flags a card by its header even without a handler, and a typed reply leaves it open", async () => {
    const session = env.addSession({ status: "running" });
    await broker.ask(session.id, TURN, card("Create repository"), undefined, false);
    expect(cards()[0]).toMatchObject({ serverHandled: true });
    expect(cards()[0]?.answeredByChat).toBeUndefined();
    broker.answerOpenWithText(session.id, "Approve");
    expect(cards()[0]?.status).toBe("in_progress");
  });

  it("keeps a card stored before the flag existed open for a typed reply", async () => {
    const session = env.addSession({ status: "running" });
    await broker.ask(session.id, TURN, card("Create repository"), undefined, false);
    const record = rows()[0];
    if (!record) throw new Error("no card");
    const { serverHandled: _flag, ...old } = record.item as ItemOf<"user_question">;
    env.store.append([
      agentEventToNewEvent(session.id, {
        type: "item.updated",
        threadId: record.threadId,
        turnId: record.turnId,
        item: old,
      }),
    ]);
    expect(cards()[0]?.serverHandled).toBeUndefined();
    broker.answerOpenWithText(session.id, "Approve");
    expect(cards()[0]?.status).toBe("in_progress");
  });

  it("an ordinary no-wait card is still answered by a typed reply", async () => {
    const session = env.addSession({ status: "running" });
    await broker.ask(session.id, TURN, card("Restart"), undefined, false);
    expect(cards()[0]).toMatchObject({ answeredByChat: true });
    broker.answerOpenWithText(session.id, "Later");
    expect(cards()[0]?.status).toBe("completed");
  });

  it("a waiting card whose call timed out never offers chat as the way to answer", async () => {
    const session = env.addSession({ status: "running" });
    const out = await broker.ask(session.id, TURN, card("Create repository"));
    expect(out.status).toBe("pending");
    expect(cards()[0]?.answeredByChat).toBeUndefined();
    expect(cards()[0]?.serverHandled).toBe(true);
  });
});

describe("archiving drops what a session's open cards would do", () => {
  const cleanup = (stops: string[]) =>
    new WorktreeCleanup({
      repo: env.repo,
      projects: { get: () => env.githubProject } as unknown as ProjectService,
      store: env.store,
      settings: () => ({}) as never,
      stopSession: async (id: string) => {
        stops.push(id);
      },
      dropPending: (id: string) => broker.dropLateHandlers(id),
      sandboxes: { release: async () => ({ status: "removed", message: null }) },
    } as never);

  it.each(["completed", "failed", "interrupted"] as const)(
    "also for a %s session, which isn't stopped first",
    async (status) => {
      const session = env.addSession({ role: "agent", status });
      const acted: string[] = [];
      const out = await broker.ask(
        session.id,
        TURN,
        card("Create repository"),
        undefined,
        false,
        async () => {
          acted.push("created");
          return "done";
        },
      );
      const stops: string[] = [];
      await cleanup(stops).archive(session.id);
      expect(stops).toEqual([]);
      await broker.respond(session.id, (out as { requestId: string }).requestId, {
        kind: "answer",
        answers: { q1: ["Approve"] },
      });
      expect(acted).toEqual([]);
      expect(sent[0]).toMatch(/Nothing was done/);
    },
  );
});
