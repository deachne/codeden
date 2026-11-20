/**
 * "Explain changes in plain words" (`Project.plainWords`, §10.1): a pull request description
 * starts with a section for someone who judges the work by what it does, not by reading code.
 * Shared so the builders' prompts, the PR sync and the UI agree on its shape.
 */

/** The section's heading, written as `## In plain words`. */
export const PLAIN_WORDS_HEADING = "In plain words";

/** The section's four parts, each a short bold heading inside it. */
export const PLAIN_WORDS_PARTS = [
  "What changed for you",
  "How to try it",
  "What wasn't checked",
  "How to undo it",
] as const;

/** Longest section kept from a description (the rest is cut). */
export const PLAIN_WORDS_MAX = 4_000;

const HEADING = /^##\s+in\s+plain\s+words\s*:?\s*$/i;
/** Where the section ends: the next heading of the same or a higher level, a rule, the footer. */
const END = /^(#{1,2}\s|---\s*$|<sub>|<!--)/;
/** A closing keyword on its own line, which CodeDen appends after the agent's text. */
const CLOSING_LINE = /^(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#\d+\s*$/i;

/**
 * The Markdown under the description's `## In plain words` heading, up to the next `#`/`##`
 * heading, a `---` rule or CodeDen's footer; trimmed and cut at `PLAIN_WORDS_MAX`. Null when the
 * description has no such section, or it is empty.
 */
export function plainWordsSection(body: string | null | undefined): string | null {
  if (!body) return null;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => HEADING.test(l.trim()));
  if (start < 0) return null;
  const out: string[] = [];
  let fenced = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && END.test(line.trim())) break;
    out.push(line);
  }
  while (
    out.length > 0 &&
    (out.at(-1)?.trim() === "" || CLOSING_LINE.test(out.at(-1)?.trim() ?? ""))
  )
    out.pop();
  const text = out.join("\n").trim();
  if (!text) return null;
  return text.length > PLAIN_WORDS_MAX ? `${text.slice(0, PLAIN_WORDS_MAX).trimEnd()}…` : text;
}
