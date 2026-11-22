import type { Session } from "@codeden/contracts";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StatusDot } from "@/components/common/status-dot";
import { OutcomeBanner } from "@/components/thread/outcome-banner";
import { sessionOutcome } from "@/lib/session-outcome";
import { usePreferencesStore } from "@/stores/preferences";

let pathname = "/";
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

const dot = (c: HTMLElement) => c.querySelector("[data-pulse]");
const base = {
  endedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  startError: null,
};
const sess = (status: string, extra = {}) =>
  ({ id: "s1", status, result: null, ...base, ...extra }) as unknown as Session;

beforeEach(() => {
  pathname = "/";
  usePreferencesStore.setState({ pulseNeedsYou: true, seenDone: {} });
});

describe("StatusDot pulse", () => {
  it("pulses a waiting session dot", () => {
    const { container } = render(<StatusDot status="waiting" sessionId="s1" />);
    expect(dot(container)).not.toBeNull();
  });
  it("does not pulse without a session, other states, the open session, or when off", () => {
    expect(dot(render(<StatusDot tone="waiting" />).container)).toBeNull();
    expect(dot(render(<StatusDot status="running" sessionId="s1" />).container)).toBeNull();
    pathname = "/sessions/s1";
    expect(dot(render(<StatusDot status="waiting" sessionId="s1" />).container)).toBeNull();
    pathname = "/";
    usePreferencesStore.setState({ pulseNeedsYou: false });
    expect(dot(render(<StatusDot status="waiting" sessionId="s1" />).container)).toBeNull();
  });
});

describe("failed reason", () => {
  it("uses the last failed turn error before the generic line", () => {
    expect(sessionOutcome(sess("failed"), "pnpm up failed\nmore")?.reason).toBe("pnpm up failed");
  });
});

describe("OutcomeBanner Done", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("shows Done, clears it after being open, and stays cleared on reopen", () => {
    const s = sess("completed");
    const { unmount } = render(<OutcomeBanner session={s} />);
    expect(screen.queryByText("Done")).not.toBeNull();
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.queryByText("Done")).toBeNull();
    unmount();
    render(<OutcomeBanner session={s} />);
    expect(screen.queryByText("Done")).toBeNull();
  });
  it("keeps Failed", () => {
    render(<OutcomeBanner session={sess("failed")} turnError="boom" />);
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.queryByText("Failed")).not.toBeNull();
  });
});
