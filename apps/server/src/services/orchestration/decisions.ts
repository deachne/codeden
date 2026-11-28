/**
 * The "Decisions" section of a project's notes (`.codeden/notes.md`, §8.5): what was decided and
 * what was turned down, each with the reason, so the next planning chat doesn't start fresh or
 * re-propose a rejected idea. Plain Markdown the owner can read and edit by hand:
 *
 *     ## Decisions
 *
 *     ### Decided
 *     - Use SQLite — why: one file, no server to run
 *
 *     ### Turned down
 *     - A hosted database — why: costs money every month
 */

export interface DecisionItem {
  what: string;
  why: string;
}

export interface DecisionAdds {
  decided: DecisionItem[];
  turnedDown: DecisionItem[];
}

const SECTION = /^##\s+Decisions\s*$/i;
const NEXT_SECTION = /^##\s(?!#)/;
const WHY = " — why: ";

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();
const bullet = (item: DecisionItem) => `- ${tidy(item.what)}${WHY}${tidy(item.why)}`;

/** The decision a bullet records (the text before its reason). */
function whatOf(line: string): string {
  const text = line.replace(/^\s*[-*]\s+/, "");
  const at = text.indexOf(WHY);
  return at === -1 ? text : text.slice(0, at);
}

function sectionRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((l) => SECTION.test(l));
  if (start === -1) return null;
  const next = lines.findIndex((l, i) => i > start && NEXT_SECTION.test(l));
  return { start, end: next === -1 ? lines.length : next };
}

/** The Decisions section as written (heading included), or "" when there is none. */
export function decisionsSection(notes: string): string {
  const lines = notes.split("\n");
  const range = sectionRange(lines);
  return range ? lines.slice(range.start, range.end).join("\n").trim() : "";
}

/** Add items under one `###` heading of the section, skipping ones already listed there. */
function addTo(section: string[], heading: string, items: DecisionItem[]): number {
  const known = new Set<string>();
  let at = section.findIndex((l) => new RegExp(`^###\\s+${heading}\\s*$`, "i").test(l));
  if (at === -1) {
    while (section.length > 1 && !section[section.length - 1]?.trim()) section.pop();
    section.push("", `### ${heading}`);
    at = section.length - 1;
  }
  let end = section.findIndex((l, i) => i > at && /^###?\s/.test(l));
  if (end === -1) end = section.length;
  for (let i = at + 1; i < end; i++) known.add(tidy(whatOf(section[i] ?? "")).toLowerCase());
  const fresh: string[] = [];
  for (const item of items) {
    const key = tidy(item.what).toLowerCase();
    if (!key || known.has(key)) continue;
    known.add(key);
    fresh.push(bullet(item));
  }
  // Insert after the last non-blank line of the subsection.
  let last = end;
  while (last > at + 1 && !section[last - 1]?.trim()) last--;
  section.splice(last, 0, ...fresh);
  return fresh.length;
}

/** The notes with the new decisions added to their Decisions section (made when missing). */
export function addDecisions(
  notes: string,
  adds: DecisionAdds,
): { text: string; decided: number; turnedDown: number } {
  const lines = notes.replace(/\s*$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") lines.pop();
  let range = sectionRange(lines);
  if (!range) {
    if (lines.length > 0) lines.push("");
    lines.push("## Decisions");
    range = { start: lines.length - 1, end: lines.length };
  }
  const section = lines.slice(range.start, range.end);
  const decided = addTo(section, "Decided", adds.decided);
  const turnedDown = addTo(section, "Turned down", adds.turnedDown);
  // Keep a blank line between the section and whatever follows it.
  const after = lines.slice(range.end);
  if (after.length > 0 && section[section.length - 1]?.trim()) section.push("");
  const text = [...lines.slice(0, range.start), ...section, ...after].join("\n");
  return { text, decided, turnedDown };
}
