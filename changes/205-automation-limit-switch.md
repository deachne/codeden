---
section: fixed
---

- **Automation runs keep going when a provider hits its usage limit.** When an automation's session is moved to another provider automatically, its run stays running instead of being marked failed, follows the new session, and the new session's cost is still counted for that automation. A failed context compaction, or a repeated failure report, no longer starts a second switch.
