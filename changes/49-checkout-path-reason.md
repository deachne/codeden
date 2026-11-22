---
section: fixed
---

- **Approval cards explain `git checkout` of paths.** `git checkout .` and `git checkout src/a.ts` (no `--`) now count as discarding unsaved edits, so they are no longer shown as undoable, and the card says why next to "No, it can't be undone".
