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
| A crew run leaves its worktree or its network allowlist | bwrap in `src/crew/sandbox.ts` | `test/crew-sandbox.test.ts`; the escape attempts under `procMount: Unmasked` are still open |
| Note or issue text steers a crew brief | `untrusted` marking in briefs | still open: needs a wider test than #10365 |

## Not done here

- **Pod security enforced on all nine namespaces.** The namespace labels live
  in the cluster's GitOps source, which is not in this repository. That work
  happens there.
- **The live run inside the pod and the sandbox escape attempts**: #10450.
- **Wider prompt-injection tests**: #10451.
- **A security page under ops** with one line per control: #10452.
