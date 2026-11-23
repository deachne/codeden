---
section: security
---

- **Containers that reach the host now ask first.** At Auto, `docker`, `podman` and `nerdctl` commands that give a container the host's filesystem or power (a mount from outside the worktree, the Docker socket, `--privileged`, `--cap-add`, `--device`, `--pid=host` and the like, or running as root) now show an approval card instead of running silently. Ordinary container work (`docker ps`, `docker build`, a plain `docker run`) still runs freely, and Full autonomy is unchanged.
- **The sign-in redirect stays on CodeDen.** Opening CodeDen's sign-in link with a path like `//another.site/x` no longer redirects the browser to that other site after signing in.
