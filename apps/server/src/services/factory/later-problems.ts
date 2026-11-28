import type { FactoryItem } from "@codeden/contracts";

/**
 * Bugs filed after a review approved the work they came from (§10.1, Visibility), for the
 * reviewer scorecard. The link is the bug's own words: a `#N` or a `/pull/N` or `/issues/N` link
 * in its title or text that names one merged item, by its pull request or its issue. A bug that
 * names no merged work, or several, is "unlinked" and charged to nobody: the factory never guesses.
 */

/** The marker the factory writes into a review follow-up's issue (`follow-ups.ts`). */
const FOLLOW_UP_MARKER = "codeden:factory follow-up";

const REFERENCE = /(?:^|[^\w&/])#(\d{1,9})\b|\/(?:pull|issues)\/(\d{1,9})\b/g;

/** Every issue or pull request number the text names. */
export function referencedNumbers(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(REFERENCE)) out.add(Number(m[1] ?? m[2]));
  return out;
}

/**
 * A bug the scorecard looks at: filed by the scout, an area reviewer or a person (not a review's
 * own follow-up: the reviewer found that one, so it isn't a miss), and not turned away since
 * (a bug that was rejected or never let in wasn't a real problem).
 */
export function isLaterBug(item: FactoryItem): boolean {
  if (item.type !== "bug" || (item.source !== "issue" && item.source !== "discovery")) return false;
  if (item.stage === "rejected" || item.stage === "ignored") return false;
  return !item.summary.includes(FOLLOW_UP_MARKER);
}

/** The merged item each issue or pull request number belongs to. */
function mergedByNumber(items: FactoryItem[]): Map<number, FactoryItem> {
  const byNumber = new Map<number, FactoryItem>();
  for (const i of items) {
    if (i.source === "revert" || i.mergedAt === null) continue;
    for (const n of [i.pr?.number, i.issue?.number, i.rebuiltFrom?.number]) {
      if (n !== undefined) byNumber.set(n, i);
    }
  }
  return byNumber;
}

/** What a bug names: the one merged item it came from, or "unlinked" (none or several). */
export type BugSource =
  | { kind: "linked"; item: FactoryItem }
  | { kind: "unlinked" }
  /** Names exactly one merged item, but the bug was filed before that item merged. */
  | { kind: "notLater" };

/**
 * Where each later bug says it came from, by bug item id. A named item only counts when it merged
 * before the bug was filed ("found later"), and never the bug's own issue.
 */
export function bugSources(items: FactoryItem[]): Map<string, BugSource> {
  const byNumber = mergedByNumber(items);
  const out = new Map<string, BugSource>();
  for (const bug of items) {
    if (!isLaterBug(bug)) continue;
    const named = new Map<string, FactoryItem>();
    for (const n of referencedNumbers(`${bug.title}\n${bug.summary}`)) {
      const found = byNumber.get(n);
      if (found && found.id !== bug.id) named.set(found.id, found);
    }
    const [only] = [...named.values()];
    if (named.size !== 1 || !only) out.set(bug.id, { kind: "unlinked" });
    else if (only.mergedAt !== null && only.mergedAt <= bug.createdAt)
      out.set(bug.id, { kind: "linked", item: only });
    else out.set(bug.id, { kind: "notLater" });
  }
  return out;
}
