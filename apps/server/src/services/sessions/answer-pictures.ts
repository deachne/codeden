import {
  ANSWER_PICTURE_REFUSALS,
  type AnswerPicture,
  answerPictureProblem,
  MAX_ANSWER_PICTURES,
  type ProviderInfo,
  type RuntimeResponse,
} from "@codeden/contracts";
import { badRequest } from "../errors";
import type { Answerer } from "./questions";

/**
 * Refuse pictures that can't go with this answer, in plain words, before anything is answered
 * (so the question card stays open and the owner can take the picture off): only the owner's own
 * `answer` takes them, at most `MAX_ANSWER_PICTURES`, each an image within the size limit, and
 * only when the provider takes images (read from its capabilities; a provider that isn't loaded
 * is not assumed to refuse).
 */
export function assertPicturesAllowed(
  pictures: AnswerPicture[],
  response: RuntimeResponse,
  by: Answerer,
  provider: ProviderInfo | undefined,
): void {
  if (pictures.length === 0) return;
  if (by !== "user" || response.kind !== "answer") {
    throw badRequest(
      "A picture can only go with your answer to a question.",
      "picture_not_allowed",
    );
  }
  if (pictures.length > MAX_ANSWER_PICTURES) {
    throw badRequest(ANSWER_PICTURE_REFUSALS.tooMany, "too_many_pictures");
  }
  for (const picture of pictures) {
    const bytes = Buffer.byteLength(picture.source.data, "base64");
    const problem = answerPictureProblem(picture.mediaType, bytes);
    if (problem) {
      throw badRequest(
        problem,
        problem === ANSWER_PICTURE_REFUSALS.tooLarge ? "picture_too_large" : "not_a_picture",
      );
    }
  }
  if (provider?.capabilities.images === false) {
    throw badRequest(ANSWER_PICTURE_REFUSALS.unsupported, "images_unsupported");
  }
}

/** The line that tells a waiting agent that pictures came with the answer. */
export function picturesNote(count: number): string {
  return count === 1
    ? "The user attached a picture to this answer; it follows as their next message."
    : `The user attached ${count} pictures to this answer; they follow as their next message.`;
}

/** The text of the message that carries the pictures of an answer nothing was waiting for. */
export function picturesOnlyText(count: number): string {
  return count === 1
    ? "Here is the picture I attached to my answer."
    : "Here are the pictures I attached to my answer.";
}
