import { PLAIN_WORDS_HEADING, PLAIN_WORDS_PARTS } from "@codeden/contracts";

/**
 * "Explain changes in plain words" (`Project.plainWords`, §10.1): what builders, factory and
 * ordinary sessions alike, are asked to put first in a pull request description, and how the
 * reviewer treats it. With the setting off none of it is in any prompt.
 */

/** The four parts, as the bold headings the builder writes. */
const PARTS = PLAIN_WORDS_PARTS.map((p) => `**${p}**`).join(", ");

/** The builder's instruction for its pull request description. */
export const PLAIN_WORDS_RULE = `Start the pull request description with a \`## ${PLAIN_WORDS_HEADING}\` section for the project's owner, who isn't a developer and judges the work by what it does, not by reading code. Under four short bold headings, ${PARTS}, write a sentence or two each in everyday words: what the user notices now, the steps to see it in the app, what you didn't test or verify, and how to turn it off or reverse it. No code, file names, commands or jargon there (no commit, branch, merge, diff, API). "How to try it" leads with a link that already works (the running app's address), never Terminal commands; give a command only after the link, and only when the owner asks for one. The technical detail goes in the sections after it.`;

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

/**
 * For a project that asks for plain words: how an unattended agent words `factory_record_decision`,
 * whose question, decision and reason become a card the owner reads in the inbox.
 */
export const DECISION_PLAIN_WORDS_RULE =
  'This project asks for plain words: write the question, the decision and the reason for the owner, who isn\'t a developer. Lead with the result in one or two plain sentences, then say clearly whether anything is needed from them ("Nothing needed from you", or the one decision). Add only the detail they need, kept short. Say what the app now does for them, not what the process did. Keep internal jargon out of the whole note: round N, lens, findings, held follow-ups, issue limit, area reviewer, CI, branch, base, PR, commit, merge, revise round, reviewer capacity, worktree. When you mention a "next round" or similar, say what it means and roughly when it happens. Make the question read naturally as a heading. Put issue and PR numbers and file names at the bottom under "Details".';
