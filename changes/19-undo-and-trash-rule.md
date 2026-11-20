---
section: fixed
---

- **Explained approvals say "can be undone" when it can.** An edit inside a session's own worktree, or a command CodeDen knows stays there (file edits, local git, running tests, builds and installs), now shows "Yes" under **Can it be undone**, since the turn checkpoints can put it back. Deletions, pushes, deploys, cloud and database tools, unknown programs and anything outside the worktree still show "No".
- **The Trash rule only goes where there is a Trash.** With **Delete to the Trash** on, agents on a Mac are told to use the Trash; agents on Linux, Windows, in Docker or a cloud sandbox no longer get a rule they can't follow. Settings says so.
