# Brief: celld (research for #483)

Everything below was read on 2026-10-02, from the celld repository at `v0.6.1` and from this repository at `922e84b`. Each claim cites its source. Nothing was run. Where a sentence is an inference, it says **inference**. The paths into this repository were checked against `main` when the brief landed (#489); the places where the first draft differed are listed at the end.

## 0. Which "celld"
Only one project of that name exists. The candidates are below, and the brief covers the first:
- **`denoland/celld`**, "self-hosted, distributed Durable Objects" [[repo]](https://github.com/denoland/celld). It matches "cells/sandboxes for compute".
- Packages *built on* it, not separate projects: `@ewhauser/world-celld` (a Vercel Workflow backend) [[npm]](https://www.npmjs.com/package/@ewhauser/world-celld), `effect-durable-agent-celld`, `@criblio/cell-workspace` ("cells (server-side agents on celld)"), `@agentback/actors-do`, `@softwaiz/recell` [[npm search "celld"]](https://www.npmjs.com/search?q=celld).
- `@distilled.cloud/celld` is a name placeholder ("Placeholder package for initial npm registration") [[npm]](https://www.npmjs.com/package/@distilled.cloud/celld).

## 1. What it is
- **Source and owner:** github.com/denoland/celld, written in Rust. It was created on 2025-04-25 and last pushed on 2026-10-01. It has about 4.9k stars and 203 forks [[GitHub API]](https://api.github.com/repos/denoland/celld). Patches are emailed to ry@deno.com and assigned to Deno Land Inc. Pull requests are disabled: "Coding agents make it too easy to send a large, low-context change" [[README §Contributions]](https://github.com/denoland/celld#contributions).
- **License:** Apache-2.0 [[LICENSE]](https://github.com/denoland/celld/blob/main/LICENSE).
- **Maturity:** "celld v0.6.1 is a beta release" [[limitations]](https://github.com/denoland/celld/blob/main/docs/limitations.md). Releases ship roughly weekly: v0.2.1 on 2026-08-14 through v0.6.1 on 2026-10-01 [[releases]](https://github.com/denoland/celld/releases). Upgrades are not rolling: "Mixed versions cannot share a serving fleet" [[README]](https://github.com/denoland/celld#run-it). Security fixes go to the latest release only [[security]](https://github.com/denoland/celld/blob/main/docs/security.md).

## 2. Architecture and primitives
- **What it runs:** "an open-source daemon that runs a Cloudflare Workers application on your own machines: Workers, Durable Objects, KV, Queues, D1, R2, Workflows, Cron Triggers, and static assets, deployed from the `wrangler.json` that you already have" [[README]](https://github.com/denoland/celld#celld).
- **The cell:** "Each object is a cell: a named server with its own SQLite database." KV namespaces, queues, D1 databases and Workflows are each a cell too, with the same lease, replication and failover [[README §What runs]](https://github.com/denoland/celld#what-runs-on-celld).
- **Node and fleet:** a node is one `celld` process per machine, and it embeds V8. The nodes that share one bucket (S3, GCS or Azure) form a fleet. The bucket holds the deployments, the cell state and the ownership records. There is "no membership protocol, failure detector, or consensus service" [[README §How it works]](https://github.com/denoland/celld#how-it-works).
- **Ownership:** "A conditional bucket write gives a node the ownership of a cell, so exactly one node owns a cell at a time", fenced by an epoch [[README]](https://github.com/denoland/celld#how-it-works), [[security §ownership]](https://github.com/denoland/celld/blob/main/docs/security.md).
- **Durability:** each committed SQLite write is captured as LTX. On a single node, the write is durable once it is uploaded to the bucket. In a fleet of two or more, it is durable once one or two peers hold it on disk, and the bucket upload follows [[README]](https://github.com/denoland/celld#how-it-works), [[guarantees]](https://github.com/denoland/celld/blob/main/docs/guarantees.md).
- **One app per fleet:** "A fleet runs one application. celld has no account service, multi-tenant scheduler, or managed ingress" [[limitations]](https://github.com/denoland/celld/blob/main/docs/limitations.md).
- **Local mode:** `celld dev` runs one node with a local SQLite object store. It needs no Docker or bucket, serves on `127.0.0.1:9876`, and keeps its state in `.celld/dev` [[README §Run it]](https://github.com/denoland/celld#run-it).
- **Distribution:** a static binary for Linux x86-64/ARM64 and Apple Silicon, plus the image `ghcr.io/denoland/celld`. Windows is not supported [[README §Install]](https://github.com/denoland/celld#install), [[limitations]](https://github.com/denoland/celld/blob/main/docs/limitations.md). `celld deploy` needs `esbuild` on `PATH` [[README]](https://github.com/denoland/celld#install).

## 3. Isolation and scheduling
- **JavaScript isolation:** each cell runs in a V8 isolate with a 128 MB heap by default, matching Cloudflare's Durable Object limit (`CELLD_V8_HEAP_LIMIT_MB`) [[README §Operate]](https://github.com/denoland/celld#operate-a-fleet). Host functions cannot be reached from the bundle [[security]](https://github.com/denoland/celld/blob/main/docs/security.md).
- **Trust boundary:** "It is not safe for hostile multi-tenant use … Do not run code from mutually distrusting tenants in one fleet" [[security]](https://github.com/denoland/celld/blob/main/docs/security.md).
- **Containers (experimental):** a Durable Object can supervise one container through `ctx.container`, driven by a Docker or Podman daemon on the node. All capabilities are dropped, `no-new-privileges` is set, and an nftables fence sits on the bridge. `CELLD_CONTAINER_RUNTIME=runsc` (gVisor) or `kata` gives each container its own kernel. "Under the default runtime, a container is a kernel namespace boundary and not a virtual machine. For code that you did not write, name a runtime that gives each container its own kernel" [[containers]](https://github.com/denoland/celld/blob/main/docs/services/containers.md). `@cloudflare/sandbox` runs "on a container per sandbox" [[README table]](https://github.com/denoland/celld#what-runs-on-celld).
- **Scheduling and placement:** no central scheduler. A request goes to the cell's owner. Balancing reads a shared fleet sample every 5 s and moves at most 32 *hibernated* cells per sample, weighted by CPU count (`CELLD_PLACEMENT_WEIGHT`). It "does not measure the CPU or memory that one cell uses" [[README §Operate]](https://github.com/denoland/celld#operate-a-fleet), [[limitations]](https://github.com/denoland/celld/blob/main/docs/limitations.md).
- **Pressure:** memory shedding starts at 80% of available memory, with a hard cap at 95% of the cgroup charge. Idle least-recently-used cells are replicated, fenced and released, and a cell with active work is never shed. `CELLD_MAX_RESIDENT_CELLS` caps how many cells stay resident [[README §Operate]](https://github.com/denoland/celld#operate-a-fleet).
- **Network:** celld terminates no TLS. Peer traffic is plaintext HTTP inside an HMAC-established tunnel, so the internal listener must sit on a private network or a WireGuard/Tailscale overlay. Anyone who holds the bucket credentials controls the fleet [[security]](https://github.com/denoland/celld/blob/main/docs/security.md).

## 4. Performance and cost
- **Write latency:** "A write to a region-local store takes about 90 ms." A loaded lab fleet measured about 600 ms against a store in another region, and about 25 ms once a second node held the write. A single node pays the full bucket round trip on every write, so "Run two or more nodes if write latency matters" [[README §Run it]](https://github.com/denoland/celld#run-it). These are celld's own figures; nobody here measured them.
- **Idle cost:** "An inactive cell costs almost nothing" [[README]](https://github.com/denoland/celld#celld). Hibernated cells release their storage cache from RSS [[README §Operate]](https://github.com/denoland/celld#operate-a-fleet).
- **Density:** about 50,000 hibernatable WebSockets per cell at the default heap [[README §Operate]](https://github.com/denoland/celld#operate-a-fleet).
- **Cost (inference):** the bill is your own machines plus bucket requests and storage. Each durable write on a single node is at least one PUT, so a write-heavy app on one node pays per write. Nothing published measures requests per second or cold-start time. The experiments below should measure those.

## 5. Compared with what the forge uses today
| | The forge today | celld |
|---|---|---|
| Hosted apps | One Bun child process per environment, started with `/bin/sh -c "exec …"` and an explicit env (`src/apps/process.ts`). State in `FORGE_APP_DATA` with bun:sqlite (`docs/APPS.md`). | One Workers bundle per fleet. State in Durable Object SQLite, replicated to a bucket. Not Bun, and no `bun:sqlite` [[compat]](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md). |
| Crew run sandbox | Claude Code's bubblewrap policy on Linux (seatbelt on macOS); the network is the forge and the registry (`src/crew/sandbox.ts`). When `bwrap --unshare-user` fails its probe the run is unsandboxed. | A container per sandbox; a separate kernel only with gVisor or Kata [[containers]](https://github.com/denoland/celld/blob/main/docs/services/containers.md). Needs a Docker or Podman daemon. |
| Cluster | A Helm chart, `charts/app` (`Chart.yaml`, templates for a deployment, a volume claim, a service, ssh and apps). It deploys the forge itself; the repository does not name k3s. | No orchestrator. The bucket is the control plane. Runs as a container or a bare binary [[README §Container]](https://github.com/denoland/celld#container). |
| Spawned bodies (#339) | A Cloudflare Worker + Durable Object front door (`infra/forge-cloudflare/worker.js`), written and tested but not applied, with a Container or Fly body behind it. Firecracker on metal is the third option, not built (`docs/SPIKE-CLOUDFLARE.md`). | Runs that same Worker + Durable Object shape on our own machines. It cannot run the forge itself, which is a Bun process with git and ssh. |
| Isolation | bubblewrap namespaces, one machine. | V8 isolates (trusted code only) and optional gVisor/Kata containers. |

The forge is a Bun process with SQLite on local disk. celld is a Workers runtime with SQLite in a bucket. The two are complementary, not interchangeable (**inference**).

## 6. Three ways the forge could use it
### A. A self-hostable front door for spawned forges (#389, #427)
The spike's front door is already a Worker with a Durable Object (`infra/forge-cloudflare/worker.js`). celld runs that shape from `wrangler.json` on our own machines, so a child forge could get the same front door without a Cloudflare account.
- **Risks:** beta and weekly breaking upgrades. One fleet per app, so one fleet per front door unless a single front door routes every child. The front door's DNS and TLS still need an ingress, because celld does no TLS.
- **Smallest experiment:** put a `wrangler.json` next to `worker.js`, start it under `celld dev`, and run a test that goes through it to a stub body. Record the latency and the cold start.

### B. A "worker" app kind for hosted apps
An app that ships a `wrangler.json` would run under `celld dev --port $PORT` in place of `bun run`. It would get alarms, queues, cron and hibernating WebSockets, and it would scale to near zero when idle.
- **Risks:** a second app runtime to maintain beside Bun. The app's state moves out of `FORGE_APP_DATA` into `.celld/dev`, so the root must be pointed inside it. celld has no multi-tenant boundary, but a celld per app keeps today's per-process boundary. The binary is about 25 MB per host [[release v0.6.1]](https://github.com/denoland/celld/releases/tag/v0.6.1).
- **Smallest experiment:** add an example app with a `wrangler.json` and a counter Durable Object. A script fetches the pinned release, starts `celld dev` on a port and checks that `/` answers and the counter survives a restart. Measure first-request and p50 latency against a Bun hello app.

### C. Crew run sandboxes with a kernel boundary
celld's `@cloudflare/sandbox` support with `CELLD_CONTAINER_RUNTIME=runsc` would give each crew run its own gVisor kernel. A Durable Object would supervise the run, and the forge would talk to it over HTTP. That is stronger than bubblewrap's shared kernel.
- **Risks:** Containers are "experimental … the security boundary can change without notice" [[containers]](https://github.com/denoland/celld/blob/main/docs/services/containers.md). Every node needs Docker or Podman plus gVisor. `hardTimeout` is ignored, so the forge must enforce the run's time limit itself [[containers]](https://github.com/denoland/celld/blob/main/docs/services/containers.md). This also overlaps with the microVM sandbox `docs/EXTRACT.md` (_What is given up_) names for apps, and with the Firecracker option in `docs/SPIKE-CLOUDFLARE.md`.
- **Smallest experiment:** on a host with Docker and runsc (not the crew sandbox, which has neither), run celld's `examples/sandbox`, `exec` a `git clone` of a forge repo and time the container start. This needs a person and a machine, so no issue is opened for it yet.

**Recommendation:** try A and B. They run with `celld dev` alone, no Docker and no bucket, and either can be dropped without touching the forge's core. Leave C until someone decides on hardware for #339's Firecracker option.

## Checked against `main` (#489)
- `src/apps/process.ts`, `src/crew/sandbox.ts`, `infra/forge-cloudflare/worker.js`, `docs/APPS.md` match the table, with two additions made above: the sandbox policy is Linux bubblewrap or macOS seatbelt and falls back to unsandboxed, and the app command runs as `/bin/sh -c "exec …"`.
- `charts/app` is a Helm chart that deploys the forge. The first draft called it a "k3s chart"; nothing in the repository names k3s, so the row says Helm.
- `docs/SPIKE-CLOUDFLARE.md` says the front door is tested and nothing is applied, and that the bodies behind it are a Container or Fly, with Firecracker only a verdict. The first draft listed all three as behind it.
- `docs/EXTRACT.md` does not mention Firecracker. It says apps need a bubblewrap or microVM sandbox before friends share a box. The first draft cited it for what Firecracker would give crew runs; the sentence now says what it does say.
