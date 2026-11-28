import { randomUUID } from "node:crypto";
import type {
  AnswerPicture,
  ItemOf,
  ItemRecord,
  RuntimeResponse,
  UserQuestion,
} from "@codeden/contracts";
import { agentEventToNewEvent } from "@codeden/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToItemRecord } from "../../db/rows";
import { items } from "../../db/schema";
import type { EventStore } from "../../events/store";
import { conflict } from "../errors";
import { picturesNote, picturesOnlyText } from "./answer-pictures";

type Answers = Record<string, string[]>;
type QuestionItem = ItemOf<"user_question">;

/** Who answers a question: the user, or the project manager of the session's project. */
export type Answerer = "user" | "pm";

/** Outcome of `ask`: answered in time, dismissed, or still waiting in the inbox. */
export type AskOutcome =
  | { status: "answered"; answers: Answers; text: string; by: Answerer }
  | { status: "dismissed" }
  | { status: "pending"; requestId: string };

/**
 * What to do with an answer that arrives after the tool call stopped waiting (or when it never
 * waited). Returns the text sent to the agent as its message. Held in memory only: after a
 * restart the answer reaches the agent as the generic "Answer to your earlier question".
 */
export type LateAnswer = (outcome: AskOutcome) => Promise<string>;

/**
 * Headers of cards whose answer must be acted on by a {@link LateAnswer} handler. The handler
 * lives in memory, so an answer that arrives after a restart finds none: it is reported as "not
 * done, ask again" instead of as a plain answer the agent could read as "done".
 */
export const SERVER_HANDLED_HEADERS: ReadonlySet<string> = new Set(["Create repository"]);

/**
 * A card only its buttons answer: flagged `serverHandled`, or (cards stored before the flag
 * existed) one whose header is in {@link SERVER_HANDLED_HEADERS}.
 */
function isServerHandled(item: QuestionItem): boolean {
  return item.serverHandled === true || SERVER_HANDLED_HEADERS.has(item.questions[0]?.header ?? "");
}

export interface QuestionBrokerDeps {
  db: Db;
  store: EventStore;
  /**
   * Deliver a late answer to the agent as a message (queued while a turn runs), from the user
   * or, when the project manager answered, from the PM. The user's pictures go along as images.
   */
  sendMessage: () => (
    sessionId: string,
    text: string,
    by: Answerer,
    pictures?: AnswerPicture[],
  ) => Promise<void>;
  /** How long `ask` waits before returning `pending`. Default 4 minutes. */
  waitMs?: number;
}

/**
 * Questions agents ask through CodeDen's `ask_user` tool (§8.3). The question becomes a
 * `user_question` item in the current turn, which the projection mirrors into the inbox
 * (and the session waits on it). The tool call blocks for a while; an answer within that
 * time is the tool's result. Otherwise the tool returns "pending", the agent ends its turn,
 * and the answer arrives later as a new user message. This works the same for every
 * provider, whatever its MCP tool timeout.
 */
export class QuestionBroker {
  private readonly waiters = new Map<string, (outcome: AskOutcome) => void>();
  private readonly late = new Map<string, { sessionId: string; handler: LateAnswer }>();

  constructor(private readonly deps: QuestionBrokerDeps) {}

  async ask(
    sessionId: string,
    turn: { threadId: string; turnId: string },
    question: Omit<UserQuestion, "id">,
    signal?: AbortSignal,
    wait = true,
    late?: LateAnswer,
  ): Promise<AskOutcome> {
    const requestId = randomUUID();
    if (late) this.late.set(requestId, { sessionId, handler: late });
    const item: QuestionItem = {
      id: `ask-${requestId}`,
      kind: "user_question",
      status: "in_progress",
      requestId,
      deferred: true,
      // A card with a late handler is answered by its buttons only: a typed reply must never
      // stand in for the tap, so it isn't offered (nor accepted) as an answer.
      ...(late || SERVER_HANDLED_HEADERS.has(question.header ?? "")
        ? { serverHandled: true }
        : wait
          ? {}
          : { answeredByChat: true }),
      questions: [{ ...question, id: "q1" }],
    };
    if (!wait) {
      // A live chat: show the card and return at once; the answer arrives as the next message.
      this.put(sessionId, turn, item);
      return { status: "pending", requestId };
    }
    const outcome = new Promise<AskOutcome>((resolve) => {
      const timer = setTimeout(() => timedOut(), this.waitMs);
      const timedOut = () => {
        finish({ status: "pending", requestId });
        this.allowChatAnswer(sessionId, requestId);
      };
      const finish = (value: AskOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(requestId);
        resolve(value);
      };
      const onAbort = () => timedOut();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.set(requestId, finish);
    });
    this.put(sessionId, turn, item);
    return outcome;
  }

  /**
   * Handle a response if `requestId` belongs to an `ask_user` question. Returns false for
   * provider-native requests (the caller forwards those to the runner). `pictures` are the
   * user's attached pictures (already checked): a waiting tool call is told they follow, and
   * they reach the agent as a normal message of the user's, in the late answer's own message
   * when nothing was waiting.
   */
  async respond(
    sessionId: string,
    requestId: string,
    response: RuntimeResponse,
    by: Answerer = "user",
    pictures: AnswerPicture[] = [],
  ): Promise<boolean> {
    const record = this.find(sessionId, requestId);
    if (!record) return false;
    const item = record.item as QuestionItem;
    if (item.status !== "in_progress")
      throw conflict("The question was already answered", "answered");
    const answers = response.kind === "answer" ? response.answers : undefined;
    const done: QuestionItem = answers
      ? { ...item, status: "completed", answers, decidedBy: by }
      : { ...item, status: "cancelled" };
    this.put(sessionId, record, done);
    const withPictures = answers !== undefined && pictures.length > 0;
    const text = answers ? formatAnswers(item, answers) : "";
    const outcome: AskOutcome = answers
      ? {
          status: "answered",
          answers,
          text: withPictures ? `${text}\n\n${picturesNote(pictures.length)}` : text,
          by,
        }
      : { status: "dismissed" };
    const waiter = this.waiters.get(requestId);
    const lateAnswer = this.late.get(requestId)?.handler;
    this.late.delete(requestId);
    if (waiter) {
      waiter(outcome);
      if (withPictures) {
        await this.deps.sendMessage()(sessionId, picturesOnlyText(pictures.length), by, pictures);
      }
    } else if (lateAnswer) {
      const result = await lateAnswer(outcome);
      // The handler has acted; a session that can't take the message anymore (stopped,
      // archived) mustn't make the user's tap fail after the fact.
      await this.deps
        .sendMessage()(sessionId, result, by, pictures)
        .catch(() => {});
    } else if (isServerHandled(item)) {
      await this.deps
        .sendMessage()(
          sessionId,
          "Nothing was done: the answer to your approval card arrived after CodeDen restarted, so the request was lost. If the user still wants it, ask again with a new card.",
          by,
          pictures,
        )
        .catch(() => {});
    } else if (outcome.status === "answered") {
      const note = withPictures ? `\n\n${picturesOnlyText(pictures.length)}` : "";
      await this.deps.sendMessage()(
        sessionId,
        `Answer to your earlier question:\n${text}${note}`,
        by,
        pictures,
      );
    }
    return true;
  }

  /**
   * The user typed a normal chat message while `ask_user` cards of this session are open: the
   * message is the answer. Each open card with no waiting tool call closes as answered with the
   * text (shown as the "Other" answer), so it doesn't linger in the inbox. The message itself
   * reaches the agent as usual, so nothing is sent here. Cards a tool call still waits on are
   * left alone (the message is queued behind that call and the card still answers it), and so
   * are server-handled approval cards, which only their buttons answer.
   */
  answerOpenWithText(sessionId: string, text: string): void {
    const rows = this.deps.db
      .select()
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.kind, "user_question")))
      .all();
    for (const record of rows.map(rowToItemRecord)) {
      const item = record.item;
      if (item.kind !== "user_question" || !item.deferred || item.status !== "in_progress")
        continue;
      if (this.waiters.has(item.requestId)) continue;
      // A typed reply is never an answer a server-handled card may take: it stays open for a tap
      // on its buttons (its handler too), and the message reaches the agent as usual.
      if (isServerHandled(item) || this.late.has(item.requestId)) continue;
      const answers = Object.fromEntries(item.questions.map((q) => [q.id, [text]]));
      this.put(sessionId, record, { ...item, status: "completed", answers, decidedBy: "user" });
    }
  }

  /**
   * Forget the late handlers of a session that was stopped: nothing is left to act on them, and
   * a held handler keeps the session's state alive. A card left open then answers as "nothing was
   * done" (see `respond`), the same as after a restart.
   */
  dropLateHandlers(sessionId: string): void {
    for (const [requestId, entry] of this.late) {
      if (entry.sessionId === sessionId) this.late.delete(requestId);
    }
  }

  /**
   * A waiting question whose tool call gave up: the card no longer holds the agent, so it
   * says a typed chat reply answers it (the reply closes it, see `answerOpenWithText`).
   */
  private allowChatAnswer(sessionId: string, requestId: string): void {
    const record = this.find(sessionId, requestId);
    const item = record?.item;
    if (!record || item?.kind !== "user_question" || item.status !== "in_progress") return;
    if (item.answeredByChat || isServerHandled(item) || this.late.has(requestId)) return;
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: "item.updated",
        threadId: record.threadId,
        turnId: record.turnId,
        item: { ...item, answeredByChat: true },
      }),
    ]);
  }

  private get waitMs(): number {
    return this.deps.waitMs ?? 4 * 60_000;
  }

  private find(sessionId: string, requestId: string): ItemRecord | undefined {
    const rows = this.deps.db
      .select()
      .from(items)
      .where(and(eq(items.sessionId, sessionId), eq(items.kind, "user_question")))
      .all();
    return rows
      .map(rowToItemRecord)
      .find(
        (r) => r.item.kind === "user_question" && r.item.requestId === requestId && r.item.deferred,
      );
  }

  private put(sessionId: string, turn: { threadId: string; turnId: string }, item: QuestionItem) {
    this.deps.store.append([
      agentEventToNewEvent(sessionId, {
        type: item.status === "in_progress" ? "item.started" : "item.completed",
        threadId: turn.threadId,
        turnId: turn.turnId,
        item,
      }),
    ]);
  }
}

/** "Q: ... / A: ..." lines for the agent. */
export function formatAnswers(item: QuestionItem, answers: Answers): string {
  return item.questions
    .map((q) => `Q: ${q.question}\nA: ${(answers[q.id] ?? []).join(", ") || "(no answer)"}`)
    .join("\n\n");
}
