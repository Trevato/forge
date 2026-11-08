# Load test (#9405)

`bench/load.ts` reads a copy of the forge the way strangers do: anonymous tree, blob and raw pages of commit-pinned links, asked at a fixed rate whether or not the forge keeps up. It prints rate served, refused, p50 and p95 as JSON.

```sh
bun bench/load.ts --url https://copy.example --repo owner/name --rate 500 --seconds 20 \
  --version 0.7.386 --out bench/results/0.7.386.json --compare bench/results/0.7.385.json
```

Run it from a machine that is not the one serving. `--compare` exits 1 when the served rate is more than 20% under the last kept result (`src/perf/load_verdict.ts`), so run it in the release step and keep each release's file in `bench/results/`.

What is kept after the first read (`web/pages/tree_cache.ts`): a stranger's tree and blob page of a public repository, and the bytes of a small `/raw` file, at a full commit id. A second read of any of them spawns no git (`test/anonymous-deep.test.ts`).

Media (`/media/…`, the route a PDF or image is drawn from) is **not covered**: it is not kept, each read spawns git. The pinned blob page that embeds it is kept.

The bypasses are tested (`test/anonymous-deep.test.ts`): a signed-in reader, a repository made private, `?fragment=1` and a branch-name ref never get a page kept for a stranger. `--compare` exiting 1 is tested (`test/load-bench.test.ts`).

**Release step:** `bun scripts/release-load.ts <version> --url <copy> --repo <owner/name>` writes `bench/results/<version>.json` and compares with the newest older kept file (`src/perf/baseline.ts`); exit 1 is the gate. With no older file it only writes the first; commit it. `scripts/cut-release.ts` prints this command as its last step; it does not run it (it needs a copy with data), and no baseline is kept yet — the first release run writes it.

No baseline is kept in `bench/results/` yet: the pull's preview holds no repository to read, and the load must not be aimed at production. The first file is written by the first run against a copy with data.

Follow-ups: profile #9503, baseline #9504 (the file itself, still to be written from a copy with data), media #9505.

Not done here: the profile of tree/blob/raw/media under production's shape, the p95 targets at 500/s. Those need a machine and data this run does not have.

## The per-phase profile (#9503)

`bench/code-phases.ts` holds the same open-loop rate and tallies each answer's `Server-Timing` by page kind (tree, blob, raw, media), printing p50/p95 of wall time and of every named phase as a table. `git`, `render`, `highlight` and `session` are always listed; n = 0 means that page never names the phase (today `/raw` and `/media` name none, so only their wall time is profiled).

```sh
bun bench/code-phases.ts --url https://copy.example --repo owner/name --rate 500 --seconds 20
```

The numbers themselves are **not attached**: this run's sandbox reaches no copy holding production's repositories, and the load must not be aimed at production. Run the command per repository on such a copy and post the tables on #9503.

Only 200 (and 206) answers are samples. A redirect, 401 or 404 is counted by status in the line printed under `answered N`, so a run that was all refusals says so. A private copy needs `--token` (or `FORGE_TOKEN`); the first pages answering non-200 stops the run with the status. Connection failures and requests the client itself could not send (2000 in flight) are counted, not hidden.

## Signed-in pages under a stranger flood (#9513)

Anonymous tree, blob, raw and media pages take a permit from `strangerCodeGate` (`src/http/stranger_code.ts`) before they do any work: at most half the plumbing pool (`gitGate`), `FORGE_STRANGER_CODE_CONCURRENCY` overrides, with at most 256 waiting before the next stranger gets 503 + `Retry-After`. Holding the permit, a page yields one turn of the event loop before it renders, so a queue of strangers' cached pages cannot run back to back while a person's request goes unread. A signed-in request never touches the gate. The admission limit in `strangers.ts` still answers 429 above its per-minute budget.

`bench/signed-in-under-load.ts` boots a throwaway forge in-process with the Shield `open` (so the whole flood reaches the code pages), seeds a repository and a session, and runs `bench/load.ts` against it with `FORGE_LOAD_COOKIE` set: anonymous code pages open-loop at `--rate`, and a signed-in `/` and repository home every 50 ms beside them. It prints both streams' p50/p95, the event loop's lag and the `gitGate` waits. On a sandbox at 500/s for 15 s: signed-in p95 91 ms with the yield, 22.5 s without it.

`bench/signed-in-under-load.ts` boots a throwaway forge in-process, floods it with anonymous code pages open-loop and times a signed-in `/` and repository home at the same time:

```sh
bun bench/signed-in-under-load.ts --rate 500 --seconds 15
```
