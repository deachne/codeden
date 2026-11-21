---
section: added
---

- **Release in batches.** A middle step between merging every pull request yourself and auto-merge: turn it on in the factory settings and approved work merges into a release branch instead of the default branch. You try the whole batch once, on that branch, then release it into the default branch with one approval. Off by default, so merging works exactly as before until you turn it on. Needs auto-merge on: with auto-merge off, release mode stays off. A pull request still aimed at the default branch is moved onto the release branch and isn't merged until it targets it. A red default branch holds the release, and after the release the factory watches the release merge's CI on the default branch, reverting it on red like any regression.
