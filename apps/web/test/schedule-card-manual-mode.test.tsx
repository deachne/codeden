import type { AutomationListItem } from "@codeden/contracts";
import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ScheduleCard } from "@/components/automations/schedule-card";
import type { useAutomationActions } from "@/components/automations/use-automation-actions";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

const idle = { mutate: () => {}, isPending: false };
const actions = {
  run: idle,
  skipNext: idle,
  unskipNext: idle,
  clearOverride: idle,
  pause: idle,
  toggle: idle,
} as unknown as ReturnType<typeof useAutomationActions>;

/** A scheduled automation, switched on, in the given mock project (notes-cli is Manual). */
async function renderCard(
  projectId: string,
  trigger?: AutomationListItem["automation"]["trigger"],
) {
  const client = createMockClient();
  const { automations: items } = await client.automations.list(projectId);
  const found = items.find((i) => i.automation.trigger.type === "cron");
  if (!found) throw new Error("the mock has no scheduled automation");
  const item: AutomationListItem = {
    ...found,
    automation: { ...found.automation, enabled: true, ...(trigger ? { trigger } : {}) },
  };
  renderWithClient(<ScheduleCard item={item} projectId={projectId} actions={actions} />, client, {
    withRouter: true,
  });
  await screen.findByTestId("schedule-card");
}

describe("the schedule card in a Manual project", () => {
  it("says Manual mode is why a scheduled automation does not run on its own", async () => {
    await renderCard("p-notes");
    await screen.findByText("Manual project: runs only when you start it");
    expect(screen.getByText("Not scheduled: this project is in Manual mode")).toBeTruthy();
  });

  it("keeps the usual text in a project that is not Manual", async () => {
    await renderCard("p-storefront");
    await waitFor(() => expect(screen.queryByText(/Manual/)).toBeNull());
    expect(screen.queryByText("Manual project: runs only when you start it")).toBeNull();
  });

  it("adds no Manual note to an automation that is only run by hand", async () => {
    await renderCard("p-notes", { type: "manual" });
    expect(screen.queryByText("Manual project: runs only when you start it")).toBeNull();
    expect(screen.queryByText(/Next run/)).toBeNull();
  });
});
