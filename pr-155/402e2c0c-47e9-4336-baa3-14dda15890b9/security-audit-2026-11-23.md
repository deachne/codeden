## Audit commands

```
$ pnpm audit --prod
No known vulnerabilities found

$ pnpm audit
│                     │ lib>minimatch                                          │
├─────────────────────┼────────────────────────────────────────────────────────┤
│ More info           │ https://github.com/advisories/GHSA-g3hv-75wg-m249      │
└─────────────────────┴────────────────────────────────────────────────────────┘
2 vulnerabilities found
Severity: 2 moderate
```

The two moderate advisories are in `electron-builder`'s build-only `minimatch` (desktop packaging, never shipped in the app or the server), so they don't affect a running install.

## Classifier evidence (before the fix)

```
$ classifyCommand("docker run --rm -v /:/host alpine chroot /host sh")      -> SAFE
$ classifyCommand("docker run --privileged -v /home/me:/h alpine sh")       -> SAFE
$ classifyCommand("docker run -v /var/run/docker.sock:/var/run/docker.sock alpine sh") -> SAFE
$ classifyCommand("podman run --privileged -v /:/host alpine sh")           -> SAFE
$ classifyCommand("docker compose run --rm -v /:/host alpine sh")           -> SAFE
```

```
$ GET //evil.example/x?token=<valid token>  ->  302 Location: //evil.example/x
$ GET /\evil.example?token=<valid token>    ->  302 Location: //evil.example
```

## After the fix

```
$ pnpm exec vitest run packages/providers/test/containers.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)

$ pnpm exec vitest run apps/server/test/server.test.ts
 Test Files  1 passed (1)
      Tests  17 passed (17)

$ pnpm test
 Test Files  2 failed | 624 passed | 12 skipped (638)
      Tests  1 failed | 4869 passed | 45 skipped (4915)
```

Both failures reproduce with this branch's changes stashed: `mcp-token-argv.test.ts` needs the optional `@anthropic-ai/claude-agent-sdk` (not installed here), and `runner-link.test.ts` is a 40 s socket timeout.
