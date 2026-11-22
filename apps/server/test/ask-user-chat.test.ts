import { type ItemRecord, RoleMessageResponse, ThreadItemsPage } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
      return d.session.status === "idle" && d.session.rootThreadId ? true : undefined;
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
});
