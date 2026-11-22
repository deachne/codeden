import { z } from "zod";
import { Id, Timestamp } from "./common";
import { redactSecrets } from "./redact";

/**
 * Parked ideas (§10.1): good ideas the dark factory's scout set aside because it may file only a
 * few issues per round. Each is kept per project with two plain-words reasons, shown to the owner
 * as a short card (Build it / Not now), and copied to an issue in the owner's Ideas repository so
 * none is lost. An idea is never deleted: "Not now" and the 60-day tidy-up only hide it.
 */

/** Repository the parked ideas are copied to when the setting is not changed. */
export const DEFAULT_IDEAS_REPO = "deachne/ideas";

/** Label every copied idea carries on its Ideas issue. */
export const IDEAS_LABEL = "codeden";

/** Label an Ideas issue gets when the owner says "Not now". */
export const IDEAS_SOMEDAY_LABEL = "someday";

/** An idea the owner never touched is hidden from the list after this many days. */
export const PARKED_IDEA_HIDE_DAYS = 60;

/** Longest title, reason or detail stored; longer ones are cut and ended with "…". */
export const PARKED_IDEA_TITLE_MAX = 120;
export const PARKED_IDEA_REASON_MAX = 400;
export const PARKED_IDEA_DETAILS_MAX = 1500;

/** `parked`: waiting for the owner; `building`: filed as factory work; `not_now`: set aside. */
export const ParkedIdeaStatus = z.enum(["parked", "building", "not_now"]);
export type ParkedIdeaStatus = z.infer<typeof ParkedIdeaStatus>;

/** One parked idea, as stored (event `factory.parked_idea.updated`; an upsert). */
export const ParkedIdea = z.object({
  id: Id,
  projectId: Id,
  /** Plain words, 6 to 10 of them. No issue or PR numbers and no file names. */
  title: z.string().min(1).max(PARKED_IDEA_TITLE_MAX),
  /** `parkedIdeaKey` of the title: the same idea parked again shares it. */
  key: z.string().min(1),
  /** Why the scout liked it: what it fixes or improves for the owner, in a sentence or two. */
  whyLiked: z.string().min(1).max(PARKED_IDEA_REASON_MAX),
  /** Why it was set aside this round. */
  whyParked: z.string().min(1).max(PARKED_IDEA_REASON_MAX),
  /** Technical detail for a collapsed "Details" at the bottom of the card; null when none. */
  details: z.string().max(PARKED_IDEA_DETAILS_MAX).nullable().default(null),
  status: ParkedIdeaStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The issue in the Ideas repository; null until it is created there. */
  ideasIssue: z
    .object({ number: z.int().positive(), url: z.string().min(1) })
    .nullable()
    .default(null),
  /** Labels still to be put on the Ideas issue (a failed sync is retried). */
  pendingLabels: z.array(z.string()).default([]),
  /** A comment still to be written on the Ideas issue (a failed sync is retried). */
  pendingComment: z.string().nullable().default(null),
  /** The factory issue "Build it" filed in this project; null before. */
  builtIssue: z
    .object({ number: z.int().positive(), url: z.string().min(1) })
    .nullable()
    .default(null),
});
export type ParkedIdea = z.infer<typeof ParkedIdea>;

/**
 * The key two parkings of one idea share: the title trimmed, whitespace collapsed, punctuation at
 * the end dropped, lowercased.
 */
export function parkedIdeaKey(title: string): string {
  return title
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?\s]+$/, "")
    .toLowerCase();
}

/** A text on one line with secrets masked, cut to `max` and ended with "…". */
export function cleanIdeaText(text: string, max: number): string {
  const one = redactSecrets(text.trim().replace(/\s+/g, " "));
  if (one.length <= max) return one;
  let kept = one.slice(0, max - 1).trimEnd();
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
  return `${kept}…`;
}

/**
 * Whether the list shows an idea: still `parked` and younger than `PARKED_IDEA_HIDE_DAYS`. An
 * older one keeps its status and its Ideas issue; it just isn't listed.
 */
export function parkedIdeaShown(
  idea: Pick<ParkedIdea, "status" | "createdAt">,
  now: Date,
): boolean {
  if (idea.status !== "parked") return false;
  return now.getTime() - Date.parse(idea.createdAt) < PARKED_IDEA_HIDE_DAYS * 86_400_000;
}

/** Most idea titles the Inbox card lists before "and N more". */
export const PARKED_IDEAS_CARD_LISTED = 5;

/** The id of a project's one "new parked ideas" Inbox card. */
export const parkedIdeasInboxId = (projectId: string) => `inbox:parked-ideas:${projectId}`;

/**
 * The Inbox card for ideas the scout parked: "3 new ideas parked by the scout" and a bullet list
 * of up to {@link PARKED_IDEAS_CARD_LISTED} titles, then "and N more". Plain words, titles only.
 */
export function parkedIdeasCard(titles: readonly string[]): { title: string; body: string } {
  const n = titles.length;
  const bullets = titles.slice(0, PARKED_IDEAS_CARD_LISTED).map((t) => `- ${t}`);
  if (n > PARKED_IDEAS_CARD_LISTED) bullets.push(`- and ${n - PARKED_IDEAS_CARD_LISTED} more`);
  return {
    title: `${n} new idea${n === 1 ? "" : "s"} parked by the scout`,
    body: bullets.join("\n"),
  };
}

/** What the scout gives `factory_park_idea`. Both reasons are required, in plain words. */
export const ParkIdeaRequest = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .describe(
      "The idea in plain words, 6 to 10 of them, as the owner would say it. No issue or PR numbers, no file names.",
    ),
  whyLiked: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Why you liked it: what it fixes or improves for the owner, in one or two plain sentences.",
    ),
  whyParked: z
    .string()
    .trim()
    .min(1)
    .describe(
      'Why you did not file it this round, in plain words (for example "smaller than the three picked this round").',
    ),
  details: z
    .string()
    .trim()
    .optional()
    .describe("Optional technical detail (files, issue numbers) for a collapsed Details section."),
});
export type ParkIdeaRequest = z.infer<typeof ParkIdeaRequest>;

/** `GET /api/projects/:id/factory/parked-ideas`: the ideas the list shows, newest first. */
export const ParkedIdeasResponse = z.object({ ideas: z.array(ParkedIdea).default([]) });
export type ParkedIdeasResponse = z.infer<typeof ParkedIdeasResponse>;

/** `POST .../parked-ideas/:ideaId/build` and `.../not-now`: the idea, now changed. */
export const ParkedIdeaResponse = z.object({ idea: ParkedIdea });
export type ParkedIdeaResponse = z.infer<typeof ParkedIdeaResponse>;

/** The body of the issue copied to the Ideas repository: the date first, then plain words. */
export function ideasIssueBody(
  idea: Pick<ParkedIdea, "whyLiked" | "whyParked" | "details" | "createdAt" | "title">,
): string {
  return [
    `Parked ${idea.createdAt.slice(0, 10)}`,
    "",
    idea.title,
    "",
    `**Why the scout liked it:** ${idea.whyLiked}`,
    "",
    `**Why it's parked:** ${idea.whyParked}`,
    ...(idea.details
      ? ["", "<details>", "<summary>Details</summary>", "", idea.details, "", "</details>"]
      : []),
    "",
    "_Parked by the CodeDen factory's scout._",
  ].join("\n");
}
