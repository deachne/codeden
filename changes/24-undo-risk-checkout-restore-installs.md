---
section: fixed
---

- **Explained approvals no longer say checking out paths or package installs can be undone.** Approvals for `git checkout -- <path>` and `git restore <path>` are now marked not undoable because they discard unsaved working tree changes that turn checkpoints cannot bring back. Package installs (`npm install`, `pnpm install`, `yarn add`, `bun install`) are also marked not undoable because they write to git-ignored `node_modules` folders that checkpoints do not restore.
