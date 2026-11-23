// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const update = vi.fn();
let ideasRepo = "deachne/ideas";
vi.mock("@/components/settings/settings-ui", async () => {
  const actual = await vi.importActual<typeof import("@/components/settings/settings-ui")>(
    "@/components/settings/settings-ui",
  );
  return { ...actual, useSettings: () => ({ settings: { factory: { ideasRepo } }, update }) };
});

import { IdeasRepoSetting } from "@/components/settings/ideas-repo";

describe("IdeasRepoSetting", () => {
  beforeEach(() => {
    update.mockClear();
    ideasRepo = "deachne/ideas";
  });

  it("shows the current value and saves a valid change on blur", () => {
    render(<IdeasRepoSetting />);
    const input = screen.getByTestId("ideas-repo") as HTMLInputElement;
    expect(input.value).toBe("deachne/ideas");
    fireEvent.change(input, { target: { value: " me/my-ideas " } });
    fireEvent.blur(input);
    expect(update).toHaveBeenCalledWith({ factory: { ideasRepo: "me/my-ideas" } });
  });

  it("rejects an invalid value with a plain message and does not save", () => {
    render(<IdeasRepoSetting />);
    const input = screen.getByTestId("ideas-repo");
    fireEvent.change(input, { target: { value: "not a repo" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/owner\/name/)).toBeTruthy();
  });
});
