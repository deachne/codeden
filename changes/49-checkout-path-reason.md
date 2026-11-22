---
section: fixed
---

- **Approval cards explain `git checkout` of paths.** `git checkout .`, `git checkout ./src` and `git checkout HEAD src/a.ts` now count as discarding unsaved edits, so they are no longer shown as undoable, and the card says why next to "No, it can't be undone". A lone name such as `git checkout main` or `git checkout src/a.ts` can be a branch or a file, so it is shown as not undoable without a specific reason.
