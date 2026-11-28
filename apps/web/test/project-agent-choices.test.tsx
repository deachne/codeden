// @vitest-environment jsdom
import { Project } from "@codeden/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const setAgentChoice = vi.fn(async () => true);
vi.mock("@/lib/project-actions", () => ({ useProjectActions: () => ({ setAgentChoice }) }));
vi.mock("@/lib/queries", () => ({ useSnapshotData: () => [] }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/settings">{children}</a>,
}));
// The picker itself is covered by its own tests: here it picks Cursor's `auto`, or clears.
vi.mock("@/components/composer/model-picker/model-picker", () => ({
  ModelPicker: (props: {
    projectId?: string | null;
    value: unknown;
    placeholder?: string;
    onChange: (next: { provider: string; model: string | null; effort: null }) => void;
    footer?: (close: () => void) => ReactNode;
  }) => (
    <div data-project={props.projectId}>
      <span>{props.value ? "has choice" : props.placeholder}</span>
      <button
        type="button"
        onClick={() => props.onChange({ provider: "cursor", model: "auto", effort: null })}
      >
        pick
      </button>
      {props.footer?.(() => {})}
    </div>
  ),
}));

import { ProjectAgentChoices } from "@/components/project/project-agent-choices";

const choice = { provider: "cursor", model: "auto", effort: null } as const;
const rows = () => ({
  pm: within("project-pm-choice"),
  workers: within("project-worker-choice"),
});
function within(testId: string) {
  const root = screen.getByTestId(testId);
  return {
    pick: () => fireEvent.click(root.querySelector("button") as HTMLElement),
    follow: () =>
      fireEvent.click(
        screen.getAllByText(/Follow shared setting:/)[
          testId === "project-pm-choice" ? 0 : 1
        ] as HTMLElement,
      ),
    text: root.textContent ?? "",
  };
}

describe("ProjectAgentChoices", () => {
  const project = Project.parse({
    id: "p1",
    kind: "local",
    name: "Barn",
    slug: "barn",
    path: "/code/barn",
    defaultBranch: "main",
    defaultProvider: null,
    autonomy: null,
    timezone: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    archivedAt: null,
  });
  beforeEach(() => setAgentChoice.mockClear());
  afterEach(cleanup);

  it("shows both pickers on 'Follow shared setting', for this project, with the plain-words note", () => {
    render(<ProjectAgentChoices project={project} />);
    expect(rows().pm.text).toContain("Follow shared setting");
    expect(rows().workers.text).toContain("Follow shared setting");
    expect(
      screen
        .getByTestId("project-pm-choice")
        .querySelector("[data-project]")
        ?.getAttribute("data-project"),
    ).toBe("p1");
    expect(screen.getByText(/not an uncensored model/)).toBeTruthy();
  });

  it("saves a worker choice at once, with no warning", () => {
    render(<ProjectAgentChoices project={project} />);
    rows().workers.pick();
    expect(setAgentChoice).toHaveBeenCalledWith(project, "workerChoice", choice);
    expect(screen.queryByText(/starts a fresh conversation with it/)).toBeNull();
  });

  it("says a PM change starts a fresh conversation, and saves only once confirmed", async () => {
    render(<ProjectAgentChoices project={project} />);
    rows().pm.pick();
    expect(screen.getByText(/starts a fresh conversation with it/)).toBeTruthy();
    expect(setAgentChoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(setAgentChoice).not.toHaveBeenCalled();

    rows().pm.pick();
    fireEvent.click(screen.getByText("Change and start fresh"));
    expect(setAgentChoice).toHaveBeenCalledWith(project, "pmChoice", choice);
  });

  it("clears a choice back to the shared setting, and does nothing when nothing changed", () => {
    const set = { ...project, workerChoice: choice, pmChoice: choice } as Project;
    render(<ProjectAgentChoices project={set} />);
    rows().workers.follow();
    expect(setAgentChoice).toHaveBeenCalledWith(set, "workerChoice", null);
    setAgentChoice.mockClear();
    // Picking what is already chosen saves nothing and asks nothing.
    rows().workers.pick();
    rows().pm.pick();
    expect(setAgentChoice).not.toHaveBeenCalled();
    expect(screen.queryByText(/starts a fresh conversation with it/)).toBeNull();
  });
});
