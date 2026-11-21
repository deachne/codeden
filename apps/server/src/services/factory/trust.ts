import type {
  FactoryItem,
  FactoryLimits,
  FactoryTuning,
  GithubAuthorAssociation,
} from "@codeden/contracts";
import { hasEarnedAutoMerge } from "./earned-auto-merge";

/**
 * Who the factory works for (§10.1). On a public repository anyone can open an issue, so the
 * factory only takes on issues from trusted authors by itself: the logins in `trustedAuthors`
 * and the account CodeDen uses on GitHub. Everything else is listed as ignored until a person
 * lets it in, and work let in that way is never merged automatically. Labels are no signal
 * of trust: issue templates can apply them for anyone.
 */

/** Trusted logins, lower-cased (GitHub logins are case-insensitive). */
export function trustedLogins(
  limits: Pick<FactoryLimits, "trustedAuthors">,
  viewer: string | null,
): Set<string> {
  const logins = new Set(limits.trustedAuthors.map((l) => l.toLowerCase()));
  if (viewer) logins.add(viewer.toLowerCase());
  return logins;
}

/** Whether an issue's author is trusted. An unknown author never is. */
export function isTrustedAuthor(author: string | null, trusted: ReadonlySet<string>): boolean {
  if (!author) return false;
  return trusted.has(author.replace(/^@/, "").toLowerCase());
}

/** The repository's owner, members of the organization that owns it, and collaborators. */
const WRITE_ACCESS: ReadonlySet<GithubAuthorAssociation> = new Set([
  "owner",
  "member",
  "collaborator",
]);

/**
 * Whether an author's association with the repository (of an issue, a review or a comment)
 * gives them write access. Unknown (absent or null) never does.
 */
export function hasWriteAccess(association: GithubAuthorAssociation | null | undefined): boolean {
  return association != null && WRITE_ACCESS.has(association);
}

/**
 * Whether the factory may merge an item by itself: auto-merge is on and the work is trusted.
 * With earned auto-merge on (`tuning.earnedAutoMerge`), auto-merge is determined per kind of work
 * (docs, bug, feature), and an earned kind merges only after its last N scorecard items passed
 * first time with no spot-check problems and no reverts.
 * Work from an untrusted author that a person (or the PM) let in always waits for a human.
 */
export function mayAutoMerge(
  item: Pick<FactoryItem, "trust"> & Partial<Pick<FactoryItem, "type" | "source">>,
  limits: Pick<FactoryLimits, "autoMerge">,
  tuning?: Pick<FactoryTuning, "earnedAutoMerge" | "autoMergeKinds" | "earnedStreak"> | null,
  items?: FactoryItem[],
): boolean {
  if (!limits.autoMerge || item.trust !== "trusted") return false;
  // A revert repairs the default branch: it merges automatically when auto-merge is on.
  if (item.source === "revert") return true;
  if (!tuning?.earnedAutoMerge) return true;
  if (!item.type) return false;

  const mode = tuning.autoMergeKinds?.[item.type] ?? (item.type === "feature" ? "off" : "earned");
  if (mode === "off") return false;
  if (mode === "always") return true;
  if (mode === "earned") {
    if (!items) return false;
    return hasEarnedAutoMerge(item.type, items, tuning.earnedStreak ?? 5);
  }
  return false;
}
