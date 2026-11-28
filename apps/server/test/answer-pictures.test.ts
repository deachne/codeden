import {
  ANSWER_PICTURE_REFUSALS,
  type AnswerPicture,
  MAX_ANSWER_PICTURE_BYTES,
  type ProviderInfo,
  type RuntimeResponse,
  ThreadItemsPage,
} from "@codeden/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPicturesAllowed } from "../src/services/sessions/answer-pictures";
import { type Harness, startHarness, waitUntil } from "./support/harness";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const picture = (data = PNG_B64): AnswerPicture => ({
  type: "image",
  mediaType: "image/png",
  name: "field.png",
  source: { type: "base64", data },
});
const answer: RuntimeResponse = { kind: "answer", answers: { q1: ["A"] } };
const provider = (images: boolean) => ({ capabilities: { images } }) as unknown as ProviderInfo;

describe("assertPicturesAllowed", () => {
  it("lets an answer with a picture through, and refuses everything else in plain words", () => {
    expect(() => assertPicturesAllowed([picture()], answer, "user", provider(true))).not.toThrow();
    expect(() => assertPicturesAllowed([picture()], answer, "user", undefined)).not.toThrow();
    // No pictures: nothing to check, whatever the response.
    expect(() =>
      assertPicturesAllowed([], { kind: "cancel" }, "user", provider(false)),
    ).not.toThrow();
    const big = picture(Buffer.alloc(MAX_ANSWER_PICTURE_BYTES + 1).toString("base64"));
    expect(() => assertPicturesAllowed([big], answer, "user", provider(true))).toThrow(
      ANSWER_PICTURE_REFUSALS.tooLarge,
    );
    expect(() => assertPicturesAllowed([picture()], answer, "user", provider(false))).toThrow(
      ANSWER_PICTURE_REFUSALS.unsupported,
    );
    const approval = { kind: "approval", decision: "allow_once" } as const;
    expect(() => assertPicturesAllowed([picture()], approval, "user", provider(true))).toThrow(
      /only go with your answer/,
    );
    expect(() => assertPicturesAllowed([picture()], { kind: "cancel" }, "user", undefined)).toThrow(
      /only go with your answer/,
    );
    expect(() => assertPicturesAllowed([picture()], answer, "pm", provider(true))).toThrow(
      /only go with your answer/,
    );
  });
});

describe("a picture on a question card's answer", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it("is refused when too big or not an image, and otherwise reaches the agent", async () => {
    const sessionId = await h.startFakeSession();
    const asked = await h.server.services.tools.call(
      "ask_user",
      { question: "What is growing here?", wait: false, options: [{ label: "A" }, { label: "B" }] },
      {
        role: "agent",
        sessionId,
        projectId: h.projectId,
        caller: "mcp",
        signal: new AbortController().signal,
      },
    );
    expect(JSON.stringify(asked)).toMatch(/pending/);
    const root = (await h.detail(sessionId)).session.rootThreadId as string;
    const items = async () =>
      ThreadItemsPage.parse(
        (await h.api("GET", `/sessions/${sessionId}/threads/${root}/items?limit=500`)).body,
      ).items;
    const card = async () => (await items()).find((r) => r.item.kind === "user_question")?.item;
    const open = await card();
    if (open?.kind !== "user_question") throw new Error("no question card");
    const respond = (pictures: unknown[], response: unknown = answer) =>
      h.api("POST", `/sessions/${sessionId}/respond`, {
        requestId: open.requestId,
        response,
        pictures,
      });

    // Too big: plain message, and the question stays open.
    const big = picture(Buffer.alloc(MAX_ANSWER_PICTURE_BYTES + 1).toString("base64"));
    const tooBig = await respond([big]);
    expect(tooBig.status).toBe(400);
    expect(JSON.stringify(tooBig.body)).toContain(ANSWER_PICTURE_REFUSALS.tooLarge);
    // Not an image, and a picture on an approval or a dismissal: refused too.
    expect((await respond([{ ...picture(), mediaType: "application/pdf" }])).status).toBe(400);
    expect((await respond([picture()], { kind: "cancel" })).status).toBe(400);
    expect((await card())?.status).toBe("in_progress");

    // A picture within the limits: the answer is recorded and the agent's next reply names it.
    expect((await respond([picture()])).status).toBe(200);
    expect((await card())?.status).toBe("completed");
    const reply = await waitUntil(async () => {
      const list = await items();
      const idle = (await h.detail(sessionId)).session.status === "idle";
      const message = list.flatMap((r) => (r.item.kind === "assistant_message" ? [r.item] : []));
      return idle ? message.find((m) => m.text.includes("I can see 1 picture")) : undefined;
    });
    expect(reply.text).toContain("field.png");
    // The picture is the user's own message, stored as an artifact: no bytes in the transcript.
    const sent = (await items()).flatMap((r) =>
      r.item.kind === "user_message" && r.item.input.attachments.length > 0 ? [r.item] : [],
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.input.attachments[0]).toMatchObject({
      type: "image",
      source: { type: "artifact" },
    });
    expect(JSON.stringify(await items())).not.toContain(PNG_B64);
  });
});
