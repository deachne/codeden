---
section: added
---

- **Agent sessions that hit a usage limit carry on by themselves.** When a builder or any other agent session runs out of usage, CodeDen moves its work to another ready tool, with a summary of what was done so nothing has to be explained again, and says so in the session and once in the inbox, with the time the limit resets when it is known. The new session keeps the same trust as the work it continues, and a factory builder's work item follows it without counting a failed attempt. It uses the same switch as the orchestrator and project managers (Settings > Providers, "Switch provider automatically when a limit is hit"); with it off, sessions wait for the reset as before. Reviewers and work that already has a pull request still wait for the reset, and the factory handles them.
