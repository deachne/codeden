# Vision

CodeDen is a local-first app for running coding agents, from one session up to a self-running factory. Use this to settle choices the issue leaves open, not to add extra work.

## Users
- The owner is not an engineer: anything they read (notes, inbox cards, approvals, errors) uses plain words and says how to check the result.
- Developers use it too: keep detail available, not in the way.

## Principles
- Traceability: people can always see what an agent did, why, and what it cost.
- Honest capabilities: show only what a provider really does.
- Scales with the user: sessions, PMs, orchestrator and factories all keep working.
- No wasted space: clean up worktrees, temp files and branches; no data that grows without limit.
- Small changes that are easy to review and undo.

## Scout only
- Builders and reviewers skip this. The scout may file gaps where CodeDen trails current agentic coding tools, if they fit the principles.

## Protected areas
- `packages/providers/src/policy/**`
- `packages/providers/src/*/policy.ts`
- `packages/providers/src/claude/tools.ts`
- `apps/server/src/security.ts`
- `apps/server/src/content-security.ts`
- `apps/server/src/token.ts`
