import { randomUUID } from "node:crypto";
import {
  cleanIdeaText,
  IDEAS_LABEL,
  IDEAS_SOMEDAY_LABEL,
  ideasIssueBody,
  PARKED_IDEA_DETAILS_MAX,
  PARKED_IDEA_REASON_MAX,
  PARKED_IDEA_TITLE_MAX,
  type ParkedIdea,
  type ParkIdeaRequest,
  parkedIdeaKey,
  parkedIdeaShown,
  parkedIdeasCard,
  parkedIdeasInboxId,
  type Session,
} from "@codeden/contracts";
import { badRequest, conflict, errorMessage, notFound } from "../errors";
import { TYPE_LABEL } from "./classify";
import type { FactoryContext } from "./context";
import { FACTORY_LABEL } from "./intake";

/**
 * Parked ideas (§10.1): what the scout liked but did not file this round. Each is saved in the
 * project's list at once (the event log), then copied to an issue in the owner's Ideas
 * repository. The copy is best effort: when GitHub can't be reached the list still works and the
 * copy is retried on later ticks (`syncParkedIdeas`); nothing here ever blocks a factory round.
 * An idea is never deleted: "Not now" and the 60-day tidy-up (`parkedIdeaShown`) only hide it.
 */

/** Ideas being copied right now, so a tick and the scout's call never create the issue twice. */
const syncing = new Set<string>();

/** `factory_park_idea`: the scout parks one idea; parking the same idea again changes nothing. */
export function parkIdea(
  ctx: FactoryContext,
  session: Session,
  req: ParkIdeaRequest,
): { id: string; duplicate: boolean; message: string } {
  if (!session.projectId) throw badRequest("Only a project's scout can do this", "not_the_scout");
  const projectId = session.projectId;
  const loop = ctx.store.loopOrNew(projectId, ctx.now());
  if (loop.scout.sessionId !== session.id) {
    throw badRequest("Only the project's factory scout can do this", "not_the_scout");
  }
  const title = cleanIdeaText(req.title, PARKED_IDEA_TITLE_MAX);
  const whyLiked = cleanIdeaText(req.whyLiked, PARKED_IDEA_REASON_MAX);
  const whyParked = cleanIdeaText(req.whyParked, PARKED_IDEA_REASON_MAX);
  if (!title || !whyLiked || !whyParked) {
    throw badRequest(
      "A parked idea needs a title, why you liked it and why it is parked, in plain words",
      "missing_reason",
    );
  }
  const key = parkedIdeaKey(title);
  const known = ctx.store.parkedIdeaByKey(projectId, key);
  if (known) {
    return { id: known.id, duplicate: true, message: "Already parked; nothing changed." };
  }
  const at = ctx.now().toISOString();
  const idea = ctx.store.saveParkedIdea({
    id: randomUUID(),
    projectId,
    title,
    key,
    whyLiked,
    whyParked,
    details: req.details ? cleanIdeaText(req.details, PARKED_IDEA_DETAILS_MAX) : null,
    status: "parked",
    createdAt: at,
    updatedAt: at,
    ideasIssue: null,
    pendingLabels: [],
    pendingComment: null,
    builtIssue: null,
  });
  settleParkedIdeasCard(ctx, projectId, idea);
  syncInBackground(ctx);
  return { id: idea.id, duplicate: false, message: "Parked. The owner sees it in Parked ideas." };
}

/**
 * The project's one "new parked ideas" Inbox card (§11.1), after the scout parked `idea`. An open
 * card is updated in place: its title and bullets list every idea parked since the card opened.
 * With none open (never raised, or dismissed) a new card starts with this idea, so a round is one
 * card, not one per idea. Dismissing a card only closes it; the ideas stay in the list.
 */
export function settleParkedIdeasCard(ctx: FactoryContext, projectId: string, idea: ParkedIdea) {
  const id = parkedIdeasInboxId(projectId);
  const existing = ctx.inbox.find(id);
  const open = existing?.status === "open" ? existing : undefined;
  const since = open?.createdAt ?? idea.createdAt;
  const titles = ctx.store
    .parkedIdeas(projectId)
    .filter((i) => i.status === "parked" && i.createdAt >= since)
    .reverse()
    .map((i) => i.title);
  const now = ctx.now().toISOString();
  ctx.inbox.put({
    ...parkedIdeasCard(titles),
    id,
    kind: "parked_ideas",
    status: "open",
    priority: "low",
    notify: "factory",
    projectId,
    sessionId: null,
    threadId: null,
    itemId: null,
    requestId: null,
    issue: null,
    pr: null,
    automationRunId: null,
    createdAt: open?.createdAt ?? idea.createdAt,
    updatedAt: now,
    resolvedAt: null,
    resolution: null,
  });
}

/** The ideas the list shows: still `parked` and not older than 60 days, newest first. */
export function shownParkedIdeas(ctx: FactoryContext, projectId: string): ParkedIdea[] {
  const now = ctx.now();
  return ctx.store.parkedIdeas(projectId).filter((i) => parkedIdeaShown(i, now));
}

function ideaOf(ctx: FactoryContext, projectId: string, id: string): ParkedIdea {
  const idea = ctx.store.parkedIdeas(projectId).find((i) => i.id === id);
  if (!idea) throw notFound(`No parked idea ${id}`, "parked_idea_not_found");
  return idea;
}

/**
 * **Build it**: file the idea as a normal factory issue in this project (a feature, queued for an
 * agent), mark the card `building` and leave a comment with the link on the Ideas issue.
 */
export async function buildParkedIdea(
  ctx: FactoryContext,
  projectId: string,
  id: string,
): Promise<ParkedIdea> {
  const idea = ideaOf(ctx, projectId, id);
  if (idea.status === "building" && idea.builtIssue) return idea;
  const issue = await ctx.github.createIssue(projectId, {
    title: idea.title,
    body: [
      idea.whyLiked,
      "",
      `_Parked idea ${idea.createdAt.slice(0, 10)}, built at the owner's request._`,
    ].join("\n"),
    labels: [FACTORY_LABEL, TYPE_LABEL.feature],
  });
  const at = ctx.now().toISOString();
  ctx.store.createItem({
    projectId,
    workKey: `issue:${issue.number}`,
    title: idea.title,
    summary: `${idea.whyLiked}${idea.details ? `\n\n${idea.details}` : ""}`,
    source: "discovery",
    acceptanceCriteria: [],
    stage: "backlog",
    type: "feature",
    classification: {
      type: "feature",
      confidence: "high",
      rationale: "A parked idea the owner chose to build",
      by: "user",
      at,
    },
    score: 0.6,
    issue,
  });
  const saved = ctx.store.saveParkedIdea({
    ...idea,
    status: "building",
    updatedAt: at,
    builtIssue: { number: issue.number, url: issue.url },
    pendingComment: `Building this now: ${issue.url}`,
  });
  syncInBackground(ctx);
  return saved;
}

/** **Not now**: hide the idea (never delete it) and label its Ideas issue `someday`. */
export function setParkedIdeaAside(ctx: FactoryContext, projectId: string, id: string): ParkedIdea {
  const idea = ideaOf(ctx, projectId, id);
  if (idea.status === "building") {
    throw conflict("This idea is already being built", "parked_idea_building");
  }
  if (idea.status === "not_now") return idea;
  const saved = ctx.store.saveParkedIdea({
    ...idea,
    status: "not_now",
    updatedAt: ctx.now().toISOString(),
    pendingLabels: [...new Set([...idea.pendingLabels, IDEAS_SOMEDAY_LABEL])],
  });
  syncInBackground(ctx);
  return saved;
}

function syncInBackground(ctx: FactoryContext): void {
  void syncParkedIdeas(ctx).catch((error: unknown) =>
    ctx.log?.(`factory: parked ideas sync: ${errorMessage(error)}`),
  );
}

/**
 * Copy parked ideas to the Ideas repository and bring their issues up to date: create the missing
 * issue (labelled `codeden`), add labels, write comments. Each step is saved when it worked, so a
 * failure (GitHub down) leaves the rest for the next call; the first failure of an idea is logged
 * and the others go on. Never throws.
 */
export async function syncParkedIdeas(ctx: FactoryContext): Promise<void> {
  try {
    const repo = ctx.settings.get().factory.ideasRepo;
    for (const todo of ctx.store.parkedIdeasToSync()) {
      if (syncing.has(todo.id)) continue;
      syncing.add(todo.id);
      try {
        await syncOne(ctx, repo, todo.projectId, todo.id);
      } catch (error) {
        ctx.log?.(`factory: parked idea "${todo.title}": ${errorMessage(error)}`);
      } finally {
        syncing.delete(todo.id);
      }
    }
  } catch (error) {
    ctx.log?.(`factory: parked ideas: ${errorMessage(error)}`);
  }
}

/** Always works on the latest saved copy, since the owner may have clicked while GitHub answered. */
async function syncOne(
  ctx: FactoryContext,
  repo: string,
  projectId: string,
  id: string,
): Promise<void> {
  const latest = () => ideaOf(ctx, projectId, id);
  let idea = latest();
  if (!idea.ideasIssue) {
    const labels = [
      IDEAS_LABEL,
      ...(idea.status === "not_now" || idea.pendingLabels.includes(IDEAS_SOMEDAY_LABEL)
        ? [IDEAS_SOMEDAY_LABEL]
        : []),
    ];
    const created = await ctx.github.createIdeasIssue(repo, {
      title: idea.title,
      body: ideasIssueBody(idea),
      labels,
    });
    idea = ctx.store.saveParkedIdea({
      ...latest(),
      ideasIssue: created,
      pendingLabels: latest().pendingLabels.filter((l) => !labels.includes(l)),
    });
  }
  const issue = idea.ideasIssue;
  if (!issue) return;
  if (idea.pendingLabels.length > 0) {
    const sent = idea.pendingLabels;
    await ctx.github.labelIdeasIssue(repo, issue.number, sent);
    idea = ctx.store.saveParkedIdea({
      ...latest(),
      pendingLabels: latest().pendingLabels.filter((l) => !sent.includes(l)),
    });
  }
  if (idea.pendingComment) {
    const sent = idea.pendingComment;
    await ctx.github.commentIdeasIssue(repo, issue.number, sent);
    ctx.store.saveParkedIdea({
      ...latest(),
      pendingComment: latest().pendingComment === sent ? null : latest().pendingComment,
    });
  }
}
