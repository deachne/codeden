# Vision

CodeDen is Darcy's one place to run AI agents across all his projects. He describes what he wants in plain words, often from his phone, and it gets planned, built and checked safely without him reading code. Darcy stays the owner: he sets the direction, approves plans and does the final checks.

## Goals
- Every new project starts with a vision, a spec and owner checks, written with Darcy by the Planner, before anything is built.
- Everything Darcy reads is plain words: change notes, approval cards, inbox items, errors. Deleting goes to the Trash so it can be undone.
- Darcy can check finished work himself with owner checks and a working link, from his phone.
- Darcy can see what each project and each kind of job costs, and the cheapest model that does the job well is used.
- This copy stays easy to update from Leon's version: few clashes, and general improvements are offered back to him.
- Later, not now: trust levels per kind of work, and release mode.

## Target users
- Darcy: a farmer who builds software with AI and can't read code. Everything he sees is in plain words and says how to check the result.
- Other people only benefit indirectly: general improvements go back to Leon, and the CodeDen Skool community may see what Darcy learns. This copy is never a separate product for others to install.

## Principles
- Traceability: Darcy can always see what an agent did, why, and what it cost.
- Honest capabilities: show only what a provider really does.
- Scales with the user: sessions, PMs, orchestrator and factories all keep working.
- No wasted space: clean up worktrees, temp files and branches; no data that grows without limit.
- Small changes that are easy to review and undo.
- Keep changes general, not Darcy-only, so they can go back to Leon.

## Out of scope
- Big rewrites of Leon's core code. If something there is wrong, fix it small and offer it back to him.
- Features for teams or other users: accounts, sharing, multi-user.
- Running on more than one computer (Mac mini, remote workers), for now.
- Phone alerts (Telegram) and uncensored models, both parked for now.
- Opening CodeDen to the internet beyond Tailscale.

## Quality bar
- Every change says in plain words what changed and how Darcy can check it himself.
- Tests, lint and the build pass, and the app still starts and works afterwards.
- Anything visible on screen comes with a screenshot or a working link.
- One job per pull request, small and easy to undo.
- Updating from Leon's version still works after the change.
- Nothing is deleted for good without going to the Trash first.

## Scout only
- Builders and reviewers skip this. The scout may file gaps where CodeDen trails current agentic coding tools, if they fit the goals and principles.

## Protected areas
- `packages/providers/src/policy/**`
- `packages/providers/src/*/policy.ts`
- `packages/providers/src/claude/tools.ts`
- `apps/server/src/security.ts`
- `apps/server/src/content-security.ts`
- `apps/server/src/token.ts`
- `apps/server/src/services/secrets.ts`
- `apps/server/src/services/secret-files.ts`
- `apps/server/drizzle/**`
- `.github/workflows/**`
- payments
- billing
- subscription
- API key
- password
- licensing
