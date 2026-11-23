import { type ItemRecord, RoleMessageResponse, ThreadItemsPage } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentTurn } from "../src/mcp/transcript";
import { type Harness, startHarness, waitUntil } from "./support/harness";

/** A typed reply in a PM or orchestrator chat answers that chat's open ask_user card. */
describe("ask_user cards in PM and orchestrator chats", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const cards = async (sessionId: string): Promise<ItemRecord[]> => {
    const d = await h.detail(sessionId);
    if (!d.session.rootThreadId) return [];
    const res = await h.api(
      "GET",
      `/sessions/${sessionId}/threads/${d.session.rootThreadId}/items?limit=500`,
    );
    return ThreadItemsPage.parse(res.body).items.filter((r) => r.item.kind === "user_question");
  };
  const idle = (id: string) =>
    waitUntil(async () => {
      const d = await h.detail(id);
      if (d.session.status !== "idle" || !d.session.rootThreadId) return undefined;
      // The root thread is recorded before the first turn row, and a tool call needs that turn.
      try {
        currentTurn(h.server.services, id);
        return true;
      } catch {
        return undefined;
      }
    });

  const run = async (role: "pm" | "orchestrator", path: string, projectId: string | null) => {
    const first = RoleMessageResponse.parse(
      (await h.api("POST", path, { input: { text: "hello" } })).body,
    );
    await idle(first.sessionId);
    const out = await h.server.services.tools.call(
      "ask_user",
      {
        question: "Restart now?",
        wait: false,
        options: [{ label: "Restart", description: "Quick" }, { label: "Wait" }],
      },
      {
        role,
        sessionId: first.sessionId,
        projectId,
        caller: "mcp",
        signal: new AbortController().signal,
      },
    );
    expect(JSON.stringify(out)).toMatch(/pending/);
    const open = await cards(first.sessionId);
    expect(open).toHaveLength(1);
    expect(open[0]?.item).toMatchObject({ status: "in_progress", answeredByChat: true });
    await h.api("POST", path, { input: { text: "the second one" } });
    const done = await waitUntil(async () => {
      const c = (await cards(first.sessionId))[0];
      return c?.item.status === "completed" ? c : undefined;
    });
    // The inbox no longer holds the question.
    const inbox = (await h.api("GET", `/inbox?sessionId=${first.sessionId}`)).body as Array<{
      kind: string;
      status: string;
    }>;
    expect(inbox.filter((i) => i.kind === "question" && i.status === "open")).toEqual([]);
    expect(done.item).toMatchObject({ answers: { q1: ["the second one"] }, decidedBy: "user" });
  };

  it("closes a PM card when the user types a reply in the PM chat", async () => {
    await run("pm", `/orchestration/projects/${h.projectId}/pm/messages`, h.projectId);
  });

  it("closes an orchestrator card when the user types a reply in its chat", async () => {
    await run("orchestrator", "/orchestration/orchestrator/messages", null);
  });

  it("a clicked answer's own delivery does not close a second open card", async () => {
    const path = `/orchestration/projects/${h.projectId}/pm/messages`;
    const first = RoleMessageResponse.parse(
      (await h.api("POST", path, { input: { text: "again" } })).body,
    );
    await idle(first.sessionId);
    const ask = (question: string) =>
      h.server.services.tools.call(
        "ask_user",
        { question, wait: false, options: [{ label: "A" }, { label: "B" }] },
        {
          role: "pm",
          sessionId: first.sessionId,
          projectId: h.projectId,
          caller: "mcp",
          signal: new AbortController().signal,
        },
      );
    await ask("First?");
    await ask("Second?");
    const open = (await cards(first.sessionId)).filter((r) => r.item.status === "in_progress");
    expect(open).toHaveLength(2);
    const requestId = open.map((r) => (r.item as { requestId: string }).requestId)[0];
    await h.api("POST", `/sessions/${first.sessionId}/respond`, {
      requestId,
      response: { kind: "answer", answers: { q1: ["A"] } },
    });
    await idle(first.sessionId);
    const left = (await cards(first.sessionId)).filter((r) => r.item.status === "in_progress");
    expect(left).toHaveLength(1);
  });
});
