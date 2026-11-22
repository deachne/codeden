import type { Session } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ThreadHeader } from "@/components/thread/thread-header";
import { createMockClient } from "@/lib/api/mock";
import { makeSession } from "@/lib/api/mock/fixtures/helpers";
import { renderWithClient } from "./utils";

const session = (over: { provider: Session["provider"]; model: string | null }): Session =>
  makeSession({
    id: "s-model",
    projectId: "p-storefront",
    role: "agent",
    status: "idle",
    purpose: "Test",
    workKey: "issue:1",
    ...over,
  });

function show(s: Session) {
  renderWithClient(<ThreadHeader session={s} running={false} />, createMockClient(), {
    withRouter: true,
  });
}

describe("thread header model", () => {
  it("shows the friendly model name for a listed model", async () => {
    show(session({ provider: "claude", model: "opus" }));
    const el = await screen.findByTestId("thread-model");
    expect(el.textContent).not.toBe("opus");
    expect(el.textContent).not.toContain("undefined");
  });

  it("falls back to the stored id when the provider doesn't list the model", async () => {
    show(session({ provider: "claude", model: "some-unlisted-model" }));
    expect((await screen.findByTestId("thread-model")).textContent).toBe("some-unlisted-model");
  });

  it("shows nothing when the session has no model", async () => {
    show(session({ provider: "claude", model: null }));
    await screen.findByRole("button", { name: "More" });
    expect(screen.queryByTestId("thread-model")).toBeNull();
  });

  it("shows nothing when the provider isn't in the list", async () => {
    show(session({ provider: "not-a-provider" as Session["provider"], model: "x" }));
    await screen.findByRole("button", { name: "More" });
    expect(screen.queryByTestId("thread-model")).toBeNull();
  });
});
