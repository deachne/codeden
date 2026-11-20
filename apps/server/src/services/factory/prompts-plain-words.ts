import { PLAIN_WORDS_HEADING, PLAIN_WORDS_PARTS } from "@codeden/contracts";

/**
 * "Explain changes in plain words" (`Project.plainWords`, §10.1): what builders, factory and
 * ordinary sessions alike, are asked to put first in a pull request description, and how the
 * reviewer treats it. With the setting off none of it is in any prompt.
 */

/** The four parts, as the bold headings the builder writes. */
const PARTS = PLAIN_WORDS_PARTS.map((p) => `**${p}**`).join(", ");

/** The builder's instruction for its pull request description. */
export const PLAIN_WORDS_RULE = `Start the pull request description with a \`## ${PLAIN_WORDS_HEADING}\` section for the project's owner, who isn't a developer and judges the work by what it does, not by reading code. Under four short bold headings, ${PARTS}, write a sentence or two each in everyday words: what the user notices now, the steps to see it in the app, what you didn't test or verify, and how to turn it off or reverse it. No code, file names, commands or jargon there (no commit, branch, merge, diff, API). The technical detail goes in the sections after it.`;

/**
 * Whether the reviewed PR's description has the section: `present`, `missing`, or null when the
 * project doesn't ask for one.
 */
export type PlainWordsState = "present" | "missing" | null;

/** What the reviewer does about the section; empty while the setting is off. */
export function plainWordsReview(state: PlainWordsState): string {
  if (state === "missing") {
    return `This project asks every pull request to start with a \`## ${PLAIN_WORDS_HEADING}\` section for a non-developer (${PARTS}), and this description has none: add a follow-up "Explain this change in plain words". It never blocks the merge: don't request changes or reject for it.`;
  }
  if (state === "present") {
    return `This project asks every pull request to start with a \`## ${PLAIN_WORDS_HEADING}\` section for a non-developer (${PARTS}). If it is unclear, incomplete, or has code, file names or jargon in it, add a follow-up saying what to improve. It never blocks the merge: don't request changes or reject for it.`;
  }
  return "";
}
