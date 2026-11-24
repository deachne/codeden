---
section: security
---

- **External scripts, external binaries and ripgrep preprocessors now ask first.** Running a script file outside the worktree (`source`, `.`, `bash <file>`, `bash < <file>`), sourcing an unreadable local script, running a binary by path outside the worktree (directly or through `find -exec`), or passing `--pre` to `rg` with a risky or external program now shows an approval prompt instead of running silently. Normal searches (`find`, `rg`), inline `bash -c`, and safe scripts inside the worktree still run freely.
