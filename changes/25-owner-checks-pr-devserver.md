---
section: fixed
---

- **Owner checks on pull requests that add or change the dev server.** The factory now reads `.codeden/project.json` from the pull request head (or its tryout worktree) instead of only the main checkout. Pull requests that add a dev server are no longer skipped, and tryout agents run with the pull request's updated dev server command.
