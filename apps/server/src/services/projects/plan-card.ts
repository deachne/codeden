import {
  type InboxItem,
  type NewEvent,
  type Project,
  planProjectCard,
  planProjectInboxId,
} from "@codeden/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { rowToInbox } from "../../db/rows";
import { inboxItems } from "../../db/schema";
import { closedItem } from "../inbox-service";
import { planApproved } from "./plan-approval";

/**
 * The "Plan this project?" Inbox card (§8.5): one per project whose plan isn't approved, with
 * Plan with me. `ProjectService` keeps it in step with the project in the same append as the
 * project's own event, so every way a plan is proposed or approved moves the card too.
 */

/** The card's item for the project; `open` keeps when the card was first raised. */
export function planProjectItem(project: Project, now: string, open?: InboxItem): InboxItem {
  return {
    ...planProjectCard(project.name, project.planStatus === "awaiting_approval"),
    id: planProjectInboxId(project.id),
    kind: "plan_project",
    status: "open",
    priority: "normal",
    notify: "needs_you",
    projectId: project.id,
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: open?.createdAt ?? now,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  };
}

/**
 * The events that bring the project's card in line with the project as it is now (`project`, not
 * yet saved). An approved plan or an archived project resolves an open card. Otherwise an open
 * card takes the project's current words (its name, and whether a plan waits for the owner), and
 * `raise` (the project was just added or restored) raises one when none is open. Without `raise`,
 * a card the owner dismissed stays dismissed.
 */
export function planCardEvents(
  db: Db,
  project: Project,
  now: string,
  opts: { raise?: boolean } = {},
): NewEvent[] {
  const row = db
    .select()
    .from(inboxItems)
    .where(eq(inboxItems.id, planProjectInboxId(project.id)))
    .get();
  const card = row ? rowToInbox(row) : undefined;
  const open = card?.status === "open" ? card : undefined;
  let item: InboxItem;
  if (planApproved(project) || project.archivedAt !== null) {
    if (!open) return [];
    const note = planApproved(project) ? "Plan approved" : "Project archived";
    item = closedItem(open, "resolved", { by: "codeden", note }, now);
  } else if (open || opts.raise) {
    item = planProjectItem(project, now, open);
    // Nothing to say when an open card already has the project's words.
    if (open && open.title === item.title && open.body === item.body) return [];
  } else {
    return [];
  }
  return [{ type: card ? "inbox.updated" : "inbox.created", sessionId: null, payload: { item } }];
}
