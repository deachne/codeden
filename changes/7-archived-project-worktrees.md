---
section: fixed
---

- **Worktrees of an archived project are retried every hour, as the inbox says.** When archiving a project couldn't remove a session's worktree (a file in use, the runner away, or the session still working at that moment), nothing tried again, so the folder could stay on disk for good. The hourly cleanup now treats every session of an archived project like an archived session: its worktree goes as soon as the session isn't working, even with automatic cleanup off. A worktree with uncommitted changes is still kept.
