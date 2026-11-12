# Threats

Who would attack this forge, what each wants, and what stands in the way.
Every protection is one bullet ending in a `Test:` line that names the test
file proving it, or says `none yet` plainly. `test/threats-doc.test.ts` checks
that every cited file exists and prints how many gaps remain. A protection
with no test is a gap, not a secret: the count is the to-do list.

## A snooper on the network

Wants: session cookies, tokens and pushed code in transit, or to learn who
talks to whom.

- Sessions are HttpOnly cookies, `Secure` when the request came over https, so
  script cannot read one and a plain-http hop does not carry it.
  Test: `test/own-session.test.ts`
- Tokens are shown once; the database keeps only their sha256, so a copy of the
  index does not replay as a login.
  Test: `test/tokens.test.ts`
- TLS is terminated by the edge in front of the forge, and certificates are
  issued only for names the forge vouches for (`on_demand_tls` ask).
  Test: none yet
- Between the edge and the forge process, and between forge and cell, traffic is
  plain HTTP on one machine or a pod network. Nothing encrypts it.
  Test: none yet

## A stolen token

Wants: to act as the person or agent it was issued to, for as long as it works.

- Tokens carry a scope and an optional expiry; a narrower token cannot do what a
  wider one can.
  Test: `test/tokens.test.ts`
- A crew run's secrets are named in the brief, opened per run, redacted from the
  log, and released when the run ends.
  Test: `test/run-secrets.test.ts`
- A passport (`fp1.…`) is bound to one audience and scope set and dies in
  minutes, so a copy lifted from a run is useful to one door briefly.
  Test: `test/passport.test.ts`
- Sign-in attempts are throttled per client, with a whole-forge cap beside it.
  Test: `test/signin-throttle.test.ts`
- Stored provider tokens (origins) are sealed under a key in `secret.key`, never
  returned by any route.
  Test: `test/origins-security-auth.test.ts`
- The SSH host key and the database files are created 0600; a host key group-
  or world-readable is refused, and a database file found too open is a
  degraded finding naming the chmod, never a silent change and never a stop.
  Test: `test/file-modes.test.ts`
- Revoking every token of one account at once, and telling its owner a token was
  used from somewhere new.
  Test: none yet

## A compromised vendor

Wants: to run its code on the forge or in an app through something the forge
trusts: a package, a model provider, a hosting provider, an origin it syncs from.

- The forge has no runtime dependencies, so there is no package to poison in the
  forge itself.
  Test: `test/deps.test.ts`
- An app's code runs in a cell: read-only machine, empty data directory and
  home, own pid and network namespaces, memory, CPU and disk watched. A
  dependency an app pulls in gets no more than the app does.
  Test: `test/contain.test.ts`
- The only way out of a cell is the egress proxy, which reaches the hosts the
  repository declared and refuses names that resolve to private, loopback or
  metadata addresses.
  Test: `test/apps-adversarial.test.ts`
- A connected origin's replies are validated at the boundary and not trusted for
  identity.
  Test: `test/origins-security-provider.test.ts`
- Pushes from an origin cannot rewrite what the forge protects.
  Test: `test/origins-security-push.test.ts`
- Backups are encrypted before they leave the machine.
  Test: `test/snapshot-store.test.ts`
- A review of lockfile changes (`bun.lock`) before they reach an app's cell.
  Test: none yet

## A hostile agent inside a run

Wants: to read what it was not given, reach what it may not, or land code no
person approved.

- The agent's shell may reach only the forge, the package registry and its
  own repository's app (production and each open pull's preview), by exact
  host, and never another repository's app. The
  forge's repositories, index, key and every other agent's clone are denied by
  name and by allow-list, and a listing that fails refuses the run.
  Test: `test/crew-sandbox.test.ts`
- The one place a run writes beside its clone and temp directory is its
  repository's bun install cache (`crew/.cache/<repo id>/bun`), which every
  run on that repository can write: a run can poison what the next run on the
  same repository installs. It is per repository: the cache root is denied whole
  and only this repository's directory re-allowed, so a cache made later is
  denied too, and deleting the repository removes it.
  Test: `test/crew-install-cache.test.ts`
- A check's cell reads its repository's shared bun cache
  (`check-install/<repo id>/bun`) through a read-only bind and cannot write
  it, so one pull cannot plant a package the gate on main installs. The
  forge fills it on the host with `--ignore-scripts`, and reads no
  `bunfig.toml` or `.npmrc` of the pull's.
  Test: `test/check-install.test.ts`
- An app environment's cell reads that same cache read-only and
  copies from it, so a preview cannot plant a package production installs;
  the forge fills it through the same lockfile rule as a check's.
  Test: `test/app-install-cache.test.ts`
- The forge fills that cache only from a lockfile whose every package is a
  registry `name@version` with a sha512 integrity (`checks/fillable.ts`):
  the host never fetches a URL a pull chose and reads no file, link or
  workspace a pull points at, an override's or resolution's included.
  Test: `test/check-fillable.test.ts`
- The same policy holds against a real bubblewrap, not only as a string.
  Test: `test/crew-sandbox-real.test.ts`
- An agent cannot push to the default branch or merge; a person merges.
  Test: `test/protection.test.ts`
- An outside agent that drives a person's account cannot push past the pulls
  either: a protected default takes a push from its admins only, so every
  other writer lands through a pull, its gate and its review.
  Test: `test/protected-default-push.test.ts`
- Merge gates (checks, review) are enforced in the merge path, not by convention.
  Test: `test/security-merge.test.ts`
- Spend, time and turns per run are limited.
  Test: `test/crew-limits.test.ts`
- Rendered output escapes everything an agent wrote.
  Test: `test/security-xss.test.ts`

## An automated attacker at scale

Wants: accounts, spam, resources, or a way to exhaust the forge.

- Request bodies are capped at the boundary.
  Test: `test/body-limits.test.ts`
- Parsers survive generated hostile input.
  Test: `test/fuzz-parsers.test.ts`
- Anonymous spawn is rate limited per client address.
  Test: `test/spawn-anon.test.ts`
- Every door a stranger can reach that costs (API reads, clones, code
  search on the page, the API and the terminal's guest palette, event
  streams, spawn plans) is limited per address and for every stranger
  together (`src/http/strangers.ts`, docs/ARCHITECTURE.md, concurrency
  invariant 7); a signed-in push keeps its share of the pool.
  Test: `test/strangers.test.ts`
- The client address is the socket's peer unless that peer is a configured
  trusted proxy; `X-Forwarded-For` is read from the right, past trusted hops.
  Test: `test/client-address.test.ts`
- A new-account guard can refuse repository creation and forks for young
  accounts.
  Test: `test/guard-new-accounts.test.ts`
- Sign-up has a ceiling per address and for the whole forge, per minute and per
  hour, and an admin can close it at once.
  Test: `test/guest-contribute.test.ts`
- A guest owns only a contribution fork of a public repository. It holds no
  settings, secrets or app, nothing runs for it, and its storage, forks and
  pulls are limited (`docs/ROLES.md`).
  Test: `test/guest-contribute.test.ts`
- A guest's pull runs nothing until a person who can write the repository
  approves that exact head, and the crew never lands it.
  Test: `test/guest-contribute.test.ts`
- Every limit is a setting with its reason, changed by an admin only.
  Test: `test/limits.test.ts`
- Distributed attacks across many addresses: only the whole-forge caps stand
  here.
  Test: none yet

## Internal calls

`FORGE_SELF_SWAP=1` binds the web port with SO_REUSEPORT so a release can share
it, which also lets any process running as the forge's user join the listener
and take a share of its connections, login posts included. It assumes nothing
else runs as that user on the host network (agents and apps are sandboxed or in
cells). Only one swap is made per process, so two landings never leave two
releases serving. The swap is refused unless `net.ipv4.tcp_migrate_req=1`, for
without it the old listener closing resets queued connections.
Test: `test/release-swap.test.ts`

How each part proves itself to the next, today.

| Call | Authenticated by | Test |
| --- | --- | --- |
| runner → forge | the run's scoped token (`FORGE_TOKEN`) and a few-minute passport (`FORGE_PASSPORT`) | `test/passport-edge.test.ts` |
| git hook → forge | per-boot secret in `x-forge-hook-secret` on the internal listener; a call without it is refused and counted | `test/crew-sandbox.test.ts` |
| cell → proxy | the proxy's Unix socket bound into the cell's own network namespace; no credential, the namespace is the identity | `test/contain.test.ts` |
| edge → pod | `X-Plat-Edge-Token` equal to `FORGE_EDGE_TOKEN`, compared as fixed-width digests; without it `X-Plat-User` is ignored; the `signin.edge` setting (admin, refused for an admin with no password or passkey) turns the edge's identity off on every door | `test/edge-auth.test.ts` |
| child → parent | none at call time: `parent.json` names the parent's address and the child pulls over public git; the claim link (sha256 kept, 24 hours, single use) hands the child to its person | `test/spawn-first-boot.test.ts` |

Gaps: edge → pod and runner → forge ride a shared secret, not a per-call
signature; child → parent has no credential.

## A child forge running its own code (#11144)

A cell child's owner may switch it from the parent's code to its own `<org>/forge` main (`spawn/own_code.ts`). The code is then the child's author's, so treat it as hostile code in a cell, the same as any app.

What it cannot reach: the cell's memory, CPU, disk and I/O limits, its sandbox and its egress list are the same as with the parent's code, and nothing in the child's repository is read to make them. The parent's data, home and temporary directory are hidden; only the parent's code and the one checkout (a tree, with no `.git`) are revealed, read-only. Its `forge.json` is not run by the parent: the parent refuses a repository or tree over 256 MB or 50,000 files and any symbolic link in the tree, checks that `src/main.ts` parses and `forge.json` is JSON, and never executes the child's code outside the cell. What the parent records about a failed start is fixed wording; no text from the child's files reaches the rollback row or the `forge.rolled_back` event.

What it can reach: everything a child forge can reach, no more: its own data directory, the parent's heartbeat door and public address, the hosts the admin allowed for models, registry and payment. It can lie in what it serves and in its heartbeat, and can break itself: a start that fails to answer within the deadline rolls back to the last commit that came up, then to the parent's code, and the owner's `/forges` page shows a Rolled back row saying so. A commit that failed is not tried again until main moves. A child that comes up and breaks later is not rolled back; the owner switches it off. Hosted children run inside the parent's process and cannot turn this on.

- The cell limits, sandbox, egress list and hidden parent paths are built by the
  parent from outside, never read from the child's repository, so a child's own
  code is held exactly like any app.
  Test: `test/own-code.test.ts`

## Honeypots (later)

A `kind: "honeypot"` app, a decoy that records what touches it, is not built.
`forge.json` accepts `web` and `service` only. Before one may exist:

- the cell must hold (above), since the point is to run hostile traffic next to
  real apps;
- its egress must be none, not declared hosts;
- it must carry no secret, no token and no data from any real app;
- what it records must be bounded and escaped like any other input.

Until then, nothing here claims one.
