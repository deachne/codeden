---
section: added
---

- **Owner checks.** Write what your app must do in plain words on the project page ("I paste a YouTube link and get a condensed version with timestamps"). Before a factory pull request merges, a separate tryout agent starts the app, uses it in the browser and records pass or fail for each one with a screenshot; a new `owner_checks` merge check waits for all of them to pass. The builders and reviewers never see your wording: a failure goes back as "owner check 2 failed" with what the tryout saw. Each check shows when it last passed and on which pull request, and **Run owner checks** on a session or factory item tries them by hand. Projects without owner checks or a `devServer` skip it; switch it off with **Try owner checks before merging**.
