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
    // The session can report idle a moment before its first turn row exists: retry until it does.
    const out = await waitUntil(async () => {
      const r = await h.server.services.tools.call(
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
      return JSON.stringify(r).includes("no turn to attach") ? undefined : r;
    });
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

/** A waiting question whose tool call timed out tells the user a typed reply answers it. */
describe("ask_user wait: true after the wait timed out", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ askUserWaitMs: 300 });
  });
  afterAll(async () => {
    await h.close();
  });

  it("marks the open card answerable in chat, and a typed reply closes it", async () => {
    const path = `/orchestration/projects/${h.projectId}/pm/messages`;
    const first = RoleMessageResponse.parse(
      (await h.api("POST", path, { input: { text: "hello" } })).body,
    );
    const sessionId = first.sessionId;
    const rootThread = async () => {
      const d = await h.detail(sessionId);
      return d.session.status === "idle" ? d.session.rootThreadId : undefined;
    };
    const threadId = await waitUntil(rootThread);
    // The session can report idle a moment before its first turn row exists.
    await waitUntil(async () => {
      try {
        return currentTurn(h.server.services, sessionId);
      } catch {
        return undefined;
      }
    });
    const cards = async () =>
      ThreadItemsPage.parse(
        (await h.api("GET", `/sessions/${sessionId}/threads/${threadId}/items?limit=500`)).body,
      ).items.filter((r) => r.item.kind === "user_question");
    const ctx = {
      role: "pm" as const,
      sessionId,
      projectId: h.projectId,
      caller: "mcp" as const,
      signal: new AbortController().signal,
    };
    // Answered inside the wait: the card is never flagged.
    const quick = h.server.services.tools.call(
      "ask_user",
      { question: "Quick?", options: [{ label: "Yes" }, { label: "No" }] },
      ctx,
    );
    const quickCard = await waitUntil(async () => (await cards())[0]);
    await h.api("POST", `/sessions/${sessionId}/respond`, {
      requestId: (quickCard.item as { requestId: string }).requestId,
      response: { kind: "answer", answers: { q1: ["Yes"] } },
    });
    expect(JSON.stringify(await quick)).toMatch(/answered|Yes/);
    await new Promise((r) => setTimeout(r, 500));
    expect((await cards())[0]?.item).toMatchObject({ status: "completed" });
    expect((await cards())[0]?.item).not.toHaveProperty("answeredByChat", true);

    // Left unanswered: after the wait the card says a chat reply works.
    const slow = await h.server.services.tools.call(
      "ask_user",
      { question: "Slow?", options: [{ label: "A" }, { label: "B" }] },
      ctx,
    );
    expect(JSON.stringify(slow)).toMatch(/pending/);
    const flagged = await waitUntil(async () => {
      const c = (await cards()).find((r) => r.item.status === "in_progress");
      return c && (c.item as { answeredByChat?: boolean }).answeredByChat ? c : undefined;
    });
    expect(flagged.item).toMatchObject({ status: "in_progress", answeredByChat: true });
    const inbox = (await h.api("GET", `/inbox?sessionId=${sessionId}`)).body as Array<{
      kind: string;
      status: string;
    }>;
    expect(inbox.filter((i) => i.kind === "question" && i.status === "open")).toHaveLength(1);

    await h.api("POST", path, { input: { text: "B please" } });
    const done = await waitUntil(async () => {
      const c = (await cards()).find(
        (r) => r.item.status === "completed" && r.item.id === flagged.item.id,
      );
      return c;
    });
    expect(done.item).toMatchObject({ answers: { q1: ["B please"] }, decidedBy: "user" });
  });
});
