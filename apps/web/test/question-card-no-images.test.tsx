import { ANSWER_PICTURE_REFUSALS, type ItemOf } from "@codeden/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuestionCard } from "@/components/thread/cards/question-card";
import { renderWithClient } from "./utils";

// The session runs on a provider that reports it can't take images.
vi.mock("@/lib/queries", () => ({
  useSession: () => ({ provider: "text-only" }),
  useSnapshotData: () => [{ id: "text-only", capabilities: { images: false } }],
}));

describe("QuestionCard on a provider without images", () => {
  it("says so in plain words instead of offering the picture button", () => {
    const item: ItemOf<"user_question"> = {
      id: "q",
      kind: "user_question",
      status: "in_progress",
      requestId: "req-1",
      questions: [
        {
          id: "q1",
          question: "What is growing here?",
          options: [{ label: "Canola" }],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
    };
    renderWithClient(<QuestionCard item={item} sessionId="s1" />);
    expect(screen.getByText(ANSWER_PICTURE_REFUSALS.unsupported)).toBeTruthy();
    expect(screen.queryByText("Attach a picture")).toBeNull();
  });
});
