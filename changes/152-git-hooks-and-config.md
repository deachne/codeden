---
section: security
---

- **Git hooks and repository git config now ask before changing.** Writing `.git/config` or files under `.git/hooks/` (through shell commands or file tools), setting repo-local git config keys outside harmless identity and formatting options, or passing `-c` overrides for hooks, pagers, editors, filters or shell aliases now shows an approval prompt instead of running silently. Normal git usage (`git status`, `git log`, `git config --get`, `git config user.name`) still runs freely.
