import { describe, expect, it } from "vitest";
import {
  ANSWER_PICTURE_REFUSALS,
  answerPictureProblem,
  MAX_ANSWER_PICTURE_BYTES,
  MAX_ANSWER_PICTURES,
  RespondRequest,
} from "../src";

const answer = { kind: "answer", answers: { q1: ["Yes"] } } as const;
const picture = {
  type: "image",
  mediaType: "image/png",
  name: "field.png",
  source: { type: "base64", data: "iVBORw0KGgo=" },
} as const;

describe("pictures on a question answer", () => {
  it("round-trips an answer with a picture", () => {
    const first = RespondRequest.parse({ requestId: "r1", response: answer, pictures: [picture] });
    expect(RespondRequest.parse(JSON.parse(JSON.stringify(first)))).toEqual(first);
    expect(first.pictures).toEqual([picture]);
  });

  it("still parses a response without pictures: none by default", () => {
    const approval = { kind: "approval", decision: "allow_once" } as const;
    expect(RespondRequest.parse({ requestId: "r1", response: approval }).pictures).toEqual([]);
  });

  it("refuses a file that is not an image, a path instead of bytes, and too many pictures", () => {
    const parse = (pictures: unknown[]) =>
      RespondRequest.safeParse({ requestId: "r1", response: answer, pictures }).success;
    expect(parse([{ ...picture, mediaType: "application/pdf" }])).toBe(false);
    expect(parse([{ ...picture, source: { type: "path", path: "/etc/passwd" } }])).toBe(false);
    expect(parse(Array.from({ length: MAX_ANSWER_PICTURES + 1 }, () => picture))).toBe(false);
    expect(parse(Array.from({ length: MAX_ANSWER_PICTURES }, () => picture))).toBe(true);
  });

  it("says in plain words why a picture can't go with an answer", () => {
    expect(answerPictureProblem("image/jpeg", 1024)).toBeUndefined();
    expect(answerPictureProblem("image/png", MAX_ANSWER_PICTURE_BYTES)).toBeUndefined();
    expect(answerPictureProblem("image/png", MAX_ANSWER_PICTURE_BYTES + 1)).toBe(
      ANSWER_PICTURE_REFUSALS.tooLarge,
    );
    expect(answerPictureProblem("application/pdf", 10)).toBe(ANSWER_PICTURE_REFUSALS.notAPicture);
    expect(answerPictureProblem("", 10)).toBe(ANSWER_PICTURE_REFUSALS.notAPicture);
  });
});
