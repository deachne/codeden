---
section: fixed
---

- **A brand-new empty repository can start a session.** "Plan with me" and every other first session on a repository with no commits (every repository made by the create-repo tool starts that way) used to stop with "git worktree failed (128): fatal: invalid reference: main". The session now gets a fresh branch with no history, and its first commit becomes the repository's first. If git is too old for that, the message says the repository is empty and what to do.
