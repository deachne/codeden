import { z } from "zod";

/**
 * App previews for the owner (the PM's `start_preview` and `stop_preview` tools): the project's
 * app started from a branch so the owner can try it with a link instead of Terminal commands.
 */

/** Work key prefix of a preview session; the rest is the branch name. */
export const PREVIEW_WORK_KEY_PREFIX = "preview:";

/** Input of `start_preview`: a branch, a pull request number, or both (at least one). */
export const StartPreviewInput = z
  .object({
    /** The branch to run: a pull request's head branch, or a session's branch. */
    branch: z.string().trim().min(1).max(200).optional(),
    /** A pull request whose head branch to run; also keys the preview. */
    prNumber: z.int().positive().optional(),
  })
  .refine((v) => v.branch !== undefined || v.prNumber !== undefined, {
    message: "Pass a branch or a prNumber",
  });
export type StartPreviewInput = z.infer<typeof StartPreviewInput>;

/** Input of `stop_preview`: the same target as `start_preview`. */
export const StopPreviewInput = StartPreviewInput;
export type StopPreviewInput = StartPreviewInput;

/** Result of `start_preview`. */
export const StartPreviewResult = z.discriminatedUnion("status", [
  z.object({
    /** `started`: a new preview session; `reused`: the branch already had one running. */
    status: z.enum(["started", "reused"]),
    /** The app's address from the `devServer` port; null when the project's `devServer` sets no port. */
    url: z.string().nullable(),
    /** Where the url works: only on the Mac CodeDen runs on (it is 127.0.0.1), never the phone. */
    reachableFrom: z.literal("this-computer"),
    /** The preview session, where the owner can watch the app in the browser panel. */
    sessionId: z.string().min(1),
    /** Path of that session in the CodeDen app; works wherever CodeDen does. */
    sessionLink: z.string().min(1),
    message: z.string(),
  }),
  z.object({
    /** The project's `.codeden/project.json` sets no `devServer`; nothing was started. */
    status: z.literal("no_dev_server"),
    message: z.string(),
  }),
]);
export type StartPreviewResult = z.infer<typeof StartPreviewResult>;

/** Result of `stop_preview`. */
export const StopPreviewResult = z.object({
  /** `stopped`, or `none` when the branch has no running preview. */
  status: z.enum(["stopped", "none"]),
  message: z.string(),
});
export type StopPreviewResult = z.infer<typeof StopPreviewResult>;

/** The work key of a preview: by pull request when a number is given, else by branch. */
export function previewWorkKey(target: { branch?: string; prNumber?: number }): string {
  if (target.prNumber !== undefined) return `${PREVIEW_WORK_KEY_PREFIX}pr-${target.prNumber}`;
  return `${PREVIEW_WORK_KEY_PREFIX}${(target.branch ?? "").replace(/\s+/g, "-")}`;
}
