# Red team: the forge from inside

What issue #10441 asked: can something running inside the forge pod get past
a door it should not? Each finding names the code that holds the door and the
test that fails if it reopens. This round reads the code paths. It was not a
live run in the pod (a crew sandbox can reach neither the pod nor the cluster),
so the live run is still open as its own issue.

## Findings, 2026-11-09

| Door | Holds | Kept by |
| --- | --- | --- |
| An app reads the forge's env (`FORGE_EDGE_TOKEN`, keys, the forge's own token) | `appEnv` builds the app's environment from an allowlist (`src/apps/process.ts`); the forge's environment is never copied in | `test/redteam-doors.test.ts` "app to forge" |
| An app reads the forge's data | `FORGE_APP_DATA` is the app's own directory, and the cell confines it (`src/apps/contain.ts`) | `test/redteam-doors.test.ts`, the cell suites (they run on the forge's check, not in a crew sandbox) |
| A visitor sends `x-forge-identity` / `x-forge-signature` that the app believes | The proxy deletes both and writes signed ones of its own (`IDENTITY_HEADERS`, `src/apps/proxy.ts`) | `test/apps-identity.test.ts`, `test/redteam-doors.test.ts` |
| An app learns the edge secret or a bearer token from a forwarded request | `stripForgeCredentials` drops every `x-plat-*` header, `authorization`, and the grant cookie | `test/redteam-doors.test.ts` "forged identity headers" |
| Someone outside claims a person with `x-plat-user` | `edgeIdentity` believes it only with the edge secret, compared as digests | `test/redteam-doors.test.ts`, `test/edge-auth.test.ts` |
| A crew run leaves its worktree or its network allowlist | bwrap in `src/crew/sandbox.ts` | `test/crew-sandbox.test.ts`; the escape attempts under `procMount: Unmasked` are below, in "The crew sandbox" |
| Note or issue text steers a crew brief | `untrusted` marking in briefs | still open: needs a wider test than #10365 |

## The crew sandbox, attempt by attempt

A real sandboxed shell (bwrap, made by `srt` from `claudeSettings`, the
settings a crew run hands Claude Code) with `/proc` unmasked, as the pod runs
it. Every row is a test in `test/crew-sandbox-escape.test.ts` that fails if
the attempt works; `<pid>` is a process outside the sandbox. Where no sandbox
can be made (inside a crew run, or user namespaces refused) the file is
skipped and prints `skipped: test/crew-sandbox-escape.test.ts: <reason>`; the
forge's check runs it.

| Attempt | Result | Test |
| --- | --- | --- |
| Read `forge.db`: by its path, `/proc/self/root`, `/proc/1/root`, `/proc/<pid>/root` | refused (no canary back) | "reads nothing from a denied data file, …" (one per route) |
| Read another crew's file, the same four routes | refused | "reads nothing from another crew's file, …" |
| Read a secret from `/proc/1/environ` | not there | "reads no secret from /proc/1/environ" |
| Read a secret from any `/proc/<pid>/environ` the shell lists | not there | "reads no secret from any /proc/<pid>/environ …" |
| Write into the data dir, the same four routes | refused with an error code the probe reports, and the file absent, checked from outside | "writes nothing into the data dir, …" |
| Write into another crew's dir, the same four routes | refused | "writes nothing into another crew's dir, …" |
| Connect to `127.0.0.1:<port off the allowlist>` directly, as raw TCP (no proxy setting can carry it) | refused (own network) | "cannot reach 127.0.0.1:<port off the allowlist>, directly" |
| The same through the sandbox's proxy | refused by the proxy | "… through the proxy" |
| Connect to `localhost:<port off the allowlist>`, directly and through the proxy | refused | "cannot reach localhost:<port off the allowlist>, …" |
| Controls: read and write the own worktree, read the own environ, reach a listener in the own network namespace directly, reach the forge's host:port through the proxy | works | the four "control:" tests |

The controls keep a probe that never ran, or a proxy that refuses
everything, from passing as "all refused". The probe makes its through-proxy
requests as raw requests to the proxy (with the credential `srt` puts in
`HTTP_PROXY`), not with `fetch`: `srt` puts `127.0.0.1` and `localhost` in
`NO_PROXY`, and a client that honours it goes direct and cannot connect, which
is what the allowed forge host:port did on the check host (#10602). `srt` itself
is launched without proxy variables, so it does not chain through the cell's
egress proxy. Nothing is skipped for the proxy any more; a failure prints the
proxy's own status line.

## Not done here

- **Pod security enforced on all nine namespaces.** The namespace labels live
  in the cluster's GitOps source, which is not in this repository. That work
  happens there.
- **The live run inside the pod**: #10450. The sandbox escape attempts are above.
- **Wider prompt-injection tests**: #10451.
- Done: the security controls page, `/settings/security/controls` (#10452); how it reads `security-report.json` is in `docs/features/security-controls.md`.
