import { ResetRoleSessionResponse, RoleMessageResponse, Snapshot } from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionRepo } from "../src/services/sessions/repo";
import { type Harness, startHarness, waitUntil } from "./support/harness";

describe("Start fresh on a role session", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it("archives the old orchestrator and starts a new one from the current settings", async () => {
    const sent = RoleMessageResponse.parse(
      (await h.api("POST", "/orchestration/orchestrator/messages", { input: { text: "hi" } })).body,
    );
    await waitUntil(async () => {
      const d = await h.detail(sent.sessionId);
      return d.session.status === "idle" ? true : undefined;
    });
    const before = (await h.detail(sent.sessionId)).session;

    await h.api("PATCH", "/settings", {
      providers: { orchestrator: { provider: "fake", model: "fake-fast", effort: null } },
    });
    const res = ResetRoleSessionResponse.parse(
      (await h.api("POST", "/orchestration/orchestrator/reset", {})).body,
    );
    expect(res.archived?.id).toBe(before.id);
    expect(res.archived?.archivedAt).toBeTruthy();
    expect(res.session.id).not.toBe(before.id);
    expect(res.session.provider).toBe("fake");
    expect(res.session.model).toBe("fake-fast");

    const roles = h.server.services.orchestration.roles;
    expect(roles.find("orchestrator", null)?.id).toBe(res.session.id);
    expect(roles.refs().orchestrator).toBe(res.session.id);
    const snapshot = Snapshot.parse((await h.api("GET", "/snapshot")).body);
    expect(snapshot.roleSessions?.orchestrator).toBe(res.session.id);
    // The old chat stays readable.
    expect((await h.detail(before.id)).session.id).toBe(before.id);
  });

  it("refuses while a turn is running", async () => {
    const current = h.server.services.orchestration.roles.find("orchestrator", null);
    expect(current).toBeDefined();
    // Force a running turn directly: the Fake provider's turns end too fast to catch.
    const { repo } = (h.server.services.sessions as unknown as { deps: { repo: SessionRepo } })
      .deps;
    repo.update(current?.id as string, (x) => ({ ...x, status: "running" }));
    const res = await h.api("POST", "/orchestration/orchestrator/reset", {});
    expect(res.status).toBe(409);
    expect(h.server.services.orchestration.roles.find("orchestrator", null)?.id).toBe(current?.id);
  });
});
