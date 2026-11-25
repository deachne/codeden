---
section: security
---

- **Scripts and programs outside the worktree now ask first.** Running a script file outside the worktree (`source`, `.`, `bash <file>`, `bash < <file>`, `$SHELL <file>`, `bash --rcfile <file>`, `~/…` and `$HOME/…` paths included) or a program by a path outside it (directly, through `find -exec`, or as `rg`'s `--pre` helper) shows an approval prompt instead of running silently. Installed tools (Homebrew, `/usr`, `/Applications`, nvm, Bun, pnpm, Conda, `~/.local/bin`, `~/.cargo/bin`), the shell's start-up files and tools' set-up files still run freely, and so does a `--pre` helper inside the worktree, whose contents aren't read.
- **Scripts inside the worktree run with `bash <file>` or `source` are read first**, and ask when a command in them would. A script that only works in its own project runs freely, whatever its folder is called; one that is too large or too nested to check, or a sourced one that can't be read, asks.
- **A file read on the input no longer hides the command after it.** `<README.md rm -rf ~/x` is judged as the delete it is.
