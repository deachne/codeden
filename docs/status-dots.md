# Status dots and check marks

One rule for every seat: the orchestrator, each project's PM, builders and helpers (reviews,
scout, area reviewers, automation runs). The rule is `sessionTone` in `apps/web/src/lib/format.ts`.

| State | Indicator |
|---|---|
| Starting or running a turn | Blue dot ("Working") |
| Asking a question or waiting for approval | Amber dot ("Needs you") |
| Last turn finished, waiting for the next message (or completed) | Green check mark ("Done") |
| Last turn failed (or the session failed) | Red dot ("Failed") |
| Stopped after a finished job (builders and helpers only) | Green check ("Done"), or red if that job failed |
| Never ran, queued, interrupted (for example after a restart), or a PM or orchestrator that was stopped | Grey dot |

Which session a seat shows: the orchestrator and PM show the live session (the server's
`roleSessions`, else the newest), never an archived one left over after "Start fresh".

Project header: a green "All quiet" check mark shows only when the project has at least one
builder or helper and none is working, needs you or failed. The PM is not counted. The header's
"working" and "needs you" counts use the same rule as the dots. All of it updates live from the
snapshot and its events, with no reload.
