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

No baseline is kept in `bench/results/` yet: the pull's preview holds no repository to read, and the load must not be aimed at production. The first file is written by the first run against a copy with data.

Follow-ups: profile #9503, baseline and release wiring #9504, media #9505.

Not done here: the profile of tree/blob/raw/media under production's shape, the p95 targets at 500/s, and wiring the comparison into the release check. Those need a machine and data this run does not have.
