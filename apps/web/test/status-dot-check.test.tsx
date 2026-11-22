import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusDot } from "../src/components/common/status-dot";

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname: "/" } }),
}));

describe("StatusDot", () => {
  it("shows a labelled check for a finished idle session and a plain dot otherwise", () => {
    const { rerender, container } = render(<StatusDot status="idle" lastTurn="completed" />);
    expect(screen.getByRole("img", { name: "Done" })).toBeTruthy();
    rerender(<StatusDot status="idle" />);
    expect(screen.queryByRole("img", { name: "Done" })).toBeNull();
    expect(container.querySelector(".bg-status-idle")).toBeTruthy();
  });
});
