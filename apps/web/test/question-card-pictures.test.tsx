import { ANSWER_PICTURE_REFUSALS, type ItemOf, MAX_ANSWER_PICTURE_BYTES } from "@codeden/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionCard } from "@/components/thread/cards/question-card";
import { createMockClient } from "@/lib/api/mock";
import { renderWithClient } from "./utils";

const card: ItemOf<"user_question"> = {
  id: "q",
  kind: "user_question",
  status: "in_progress",
  requestId: "req-1",
  questions: [
    {
      id: "q1",
      question: "What is growing here?",
      options: [{ label: "Canola" }, { label: "Wheat" }],
      multiSelect: false,
      allowFreeText: true,
    },
  ],
};

const file = (name: string, type: string, size = 4) => {
  const f = new File(["abcd"], name, { type });
  if (size !== 4) Object.defineProperty(f, "size", { value: size });
  return f;
};
const choose = (...files: File[]) =>
  fireEvent.change(screen.getByLabelText("Choose a picture"), { target: { files } });

describe("QuestionCard pictures", () => {
  afterEach(() => vi.restoreAllMocks());

  it("previews a picture, lets it be removed, and sends it with the answer", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    renderWithClient(<QuestionCard item={card} sessionId="s1" />, client);
    fireEvent.click(screen.getByText("Canola"));

    choose(file("field.png", "image/png"));
    await screen.findByAltText("field.png");
    fireEvent.click(screen.getByRole("button", { name: "Remove field.png" }));
    expect(screen.queryByAltText("field.png")).toBeNull();

    choose(file("field.png", "image/png"));
    await screen.findByAltText("field.png");
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(respond).toHaveBeenCalledTimes(1));
    const [sessionId, requestId, response, pictures] = respond.mock.calls[0] ?? [];
    expect([sessionId, requestId, response]).toEqual([
      "s1",
      "req-1",
      { kind: "answer", answers: { q1: ["Canola"] } },
    ]);
    expect(pictures).toEqual([
      {
        type: "image",
        mediaType: "image/png",
        name: "field.png",
        source: { type: "base64", data: "YWJjZA==" },
      },
    ]);
  });

  it("sends an answer without pictures exactly as before", async () => {
    const client = createMockClient();
    const respond = vi.spyOn(client, "respond").mockResolvedValue();
    renderWithClient(<QuestionCard item={card} sessionId="s1" />, client);
    fireEvent.click(screen.getByText("Wheat"));
    fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() =>
      expect(respond).toHaveBeenCalledWith("s1", "req-1", {
        kind: "answer",
        answers: { q1: ["Wheat"] },
      }),
    );
  });

  it("refuses a file that is not a picture and a picture that is too big, in plain words", async () => {
    renderWithClient(<QuestionCard item={card} sessionId="s1" />);
    choose(file("report.pdf", "application/pdf"));
    expect((await screen.findByRole("alert")).textContent).toBe(
      ANSWER_PICTURE_REFUSALS.notAPicture,
    );
    choose(file("huge.png", "image/png", MAX_ANSWER_PICTURE_BYTES + 1));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(ANSWER_PICTURE_REFUSALS.tooLarge),
    );
    expect(screen.queryByAltText("huge.png")).toBeNull();
  });

  it("offers no picture button on an MCP server's form", () => {
    renderWithClient(<QuestionCard item={{ ...card, mcpServer: "deploy" }} sessionId="s1" />);
    expect(screen.queryByText("Attach a picture")).toBeNull();
  });
});
