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

**Release step:** `bun scripts/release-load.ts <version> --url <copy> --repo <owner/name>` runs the load twice, through the edge and with it bypassed, at 500/s for 20 s after a 20 s warm-up, writes `bench/results/<version>.json` and `<version>.bypass.json` (`--results DIR` writes them elsewhere), and compares each with the newest older kept file of its kind (`src/perf/baseline.ts`); exit 1 from either is the gate. With no older file it only writes the first; commit it. `scripts/cut-release.ts` prints this command as its last step; it does not run it (it needs a copy with data). See [the person's run](#the-persons-release-run-9596) below for the steps.

No release baseline (`<version>.json`) is kept in `bench/results/` yet: the pull's preview holds no repository to read, and the load must not be aimed at production. The first files are written by the first run against a copy with data. The two `9514-*.json` files there are the in-process measurements below; `lastBaseline` ignores them. The crew writes no result file it did not measure.

Follow-ups: profile #9503, baseline #9504 (the file itself, still to be written from a copy with data), media #9505.

Not done here: the profile of tree/blob/raw/media under production's shape, the p95 targets at 500/s. Those need a machine and data this run does not have.

## The per-phase profile (#9503)

`bench/code-phases.ts` holds the same open-loop rate and tallies each answer's `Server-Timing` by page kind (tree, blob, raw, media), printing p50/p95 of wall time and of every named phase as a table. `git`, `render`, `highlight` and `session` are always listed; n = 0 means that page never names the phase (`/raw` names `session` and `git`; `/media` names `session`, `git` and, only when it opens a stream of a file over 1 MB, `stream`; a phase that did not run is not named, so it never skews a percentile).

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

## 500 anonymous code pages a second (#9514)

The goal: at 500 pages a second, no 429 or 5xx and p95 under 100 ms (`missed` in `src/perf/load_verdict.ts`; every run prints `target met` or what it missed), through the edge and with it bypassed.

`bench/load.ts` options added for it:

- `--bypass`: every request carries `Cookie: forge_load=bypass`. The edge must pass any request with a Cookie to the forge (`http/addressed.ts`), and the cookie names no one, so the forge answers every request as a stranger's page at the URL strangers ask. A unique query would bust the edge as well, but it lands in the page's sign-in link and makes every body different, which is a forge no stranger sees. The result says `"cache": "edge"` or `"bypass"`, and `--compare` refuses to judge one kind against the other.
- `--warm S`: asks at the same rate for S seconds first and counts none of it. Its per-second line is printed, so a cold start is visible, not hidden.
- `--crawl N`: walks pinned folders until N links are known, so the load spreads over a repository instead of its top folder.
- `--addresses N`: spreads requests over N made-up client addresses in X-Forwarded-For (198.18.0.0/15). A forge reads that only from a hop it trusts, which is this machine when in-process. Through a real edge the header is ignored, as it should be. One address at 500/s is refused by design: a stranger gets 30 deep pages a minute (`crawl.ts`).
- A per-second `served/refused` line.

`bench/code-pages-at-rate.ts` builds the copy. It boots a forge in-process with the Shield at its default (`ceiling`, every stranger budget in force), fetches this clone's whole history into a public `trevato/forge` (production's largest repository: 5,144 files), then runs the load with `--bypass` across 4,000 addresses. There is no edge in-process, so this is the bypassed run.

```sh
bun bench/code-pages-at-rate.ts --rate 500 --seconds 20 --warm 40 --crawl 3000 --out bench/results/9514-in-process-bypass.json
```

A written result carries `"verdict"`: `"target met"` (none refused, p95 under 100 ms), or what missed.

### Before and after (in-process, edge bypassed, 3,000 distinct pinned links, 500/s for 20 s after a warm-up)

The machine is an 80-thread shared host, with the load generator on the same machine. Numbers are requests a second and milliseconds.

| | served/s | refused (429) | p50 | p95 |
| --- | ---: | ---: | ---: | ---: |
| main at 13060e85, 20 s warm (`9514-main-in-process-bypass.json`) | 103.5 | 7,930 | 314 | 457.5 |
| this change, 20 s warm, earlier runs | 500 / 491.8 | 0 / 163 | 3.8 / 4.4 | 21.9 / 41.2 |
| this change, 20 s warm, at 704ac702 (machine load ~43) | 471.2 | 575 | 8.5 | 229.7 |
| this change, 40 s warm, at 704ac702 (`9514-in-process-bypass.json`, `target met`) | 500 | 0 | 2.5 | 10.3 |

On a 300-link working set this change gives 500/s, 0 refused, p95 70.4 ms.

**The cold window is not clean.** For the first ~20 s on the wide set, nothing is kept yet and roughly half of the requests are refused. A 20 s warm-up is sometimes not enough on a busy host, which is why the kept result warms for 40 s. In production, only the edge protects that window: its copies outlive a deploy, so pages it holds never reach the new process. A URL it does not hold gets 429 with Retry-After. #9566 is the work to close it.

What changed, each measured on its own:

1. **Prepared statements** (`kernel/db.ts`): Bun keeps only the first 20 statements a connection prepares and prepares any later one again on every call. A code page asks about 30, so ~1.4 ms of a cached page's ~4 ms went to preparing. The cap is now 4,096, enough for every fixed query text.
2. **Encoded bodies** (`http/compress.ts`, `encodeRecent`): brotli of a 60–150 KB page took ~30% of the main thread at 300/s. The same bytes are now encoded once. Entries are keyed by a hash and checked byte for byte; the cache holds 48 MB / 1,024 entries. Hot set: p50 86 ms → 3.3 ms.
3. **Queued means waiting** (`http/crawl.ts`): 32 strangers' pages in flight counted as "behind" and cut every stranger to 60 a minute. At 500/s that is 64 ms each, a healthy forge, so a short collector pause refused hundreds. The forge is now behind only when 32 are in flight *and* the oldest has waited 250 ms.
4. **Folders and ref names** (`web/pages/tree_cache.ts`): a cold file page read git five times (blob, branches, tags, one tree per folder on its path). A folder at a full commit never changes and is now kept for 10 minutes. The ref names are kept for the minute the kept pages already allow their switcher. Cold blob page p50: 26 → 13.5 ms.
5. **Finished pages, encoded** (`web/pages/kept_page.ts`): a kept page's columns average ~150 KB of markup, so the 32 MB column cache held ~220 pages, and a crawl over a whole repository missed most of the time. The bytes that went out are now kept brotli'd (~15 KB each, 64 MB / 8,192 entries, one minute), keyed on the URL, sign-in link, identity headers present, encoding, and the commit a branch named. They are served only after the route has loaded the repository and checked that the reader may read it. A session, a theme or flash cookie, a conditional or ranged GET, or a HEAD never shares one. A kept page carries only the headers that say what the page is (`KEPT_HEADERS`: type, policy, caching, validators, preloads). A request id, timing, a date or a cookie from the first answer never reaches the next reader. Wide set: 199 → 500 served/s.

`compress()` keeps an encoding in item 2's cache only for a body no identity shaped (`sharedBody`). Requests with a cookie, Authorization or an edge identity, and answers that set a cookie or are `private`/`no-store`, are encoded per response. A signed-in reader's markup carries their form tokens and is never asked for again byte for byte. The kept pages encode through the cache directly.

What the caches hold (entries, bytes beside the cap, hits and misses) is on `/system` under **Code page caches**, for the owner. Kept pages, encoded bodies, and folders and refs are new here; at most they hold 64 + 48 + 16 = 128 MB.

A bigger git pool (`FORGE_GIT_CONCURRENCY=32`) changed nothing before item 5: the main thread was the limit, not git.

### The run through the edge, on a copy with production's data (#9565, #9596)

A crew sandbox reaches no copy holding production's repositories and no edge in front of one, so the numbers above are the best case: one repository, no edge, the client on the same machine, a warm start. They are not the `Done` of #9514. The run below is a person's, from a machine that is not the server.

## The person's release run (#9596)

**Never at production.** `scripts/release-load.ts` and `bench/load.ts` both refuse, with exit 2 and before any request goes out, a `--url` whose host is production's (`forge.open-platform.sh`), any name under it, or an address production's name resolves to (`src/perf/production_guard.ts`). A different name on the same edge (a hosted child, `<name>--forge.open-platform.sh`) is a different forge and is not refused. Load it only if it is yours.

1. **Restore a copy of production's data** on a box that is not production: `bun scripts/restore-drill.ts /srv/forge-copy` restores the newest snapshot into that empty directory (the `S3_*` variables, or `FORGE_SNAPSHOT_DIR`, and `FORGE_SNAPSHOT_PASSPHRASE`, as on the restore card), boots it once on a side port and checks it against production's public counts. The directory stays.
2. **Boot the copy as a forge**: `FORGE_DATA=/srv/forge-copy PORT=3100 bun run src/main.ts` from a clone at the release's tag. It runs the code you are releasing on production's repositories.
3. **Put the edge in front of it**, the same way production has it: a Cloudflare tunnel (or the cluster ingress) to `localhost:3100` under a name of your own, with the cache rule production has: cache HTML that is `public` and `s-maxage`, **bypass any request with a Cookie or Authorization header** (`src/http/addressed.ts`). Without that rule, the bypass pass reads cached pages and the two files show the same thing. Behind the tunnel, set `FORGE_TRUSTED_PROXIES` and `FORGE_CLIENT_IP_HEADER=cf-connecting-ip` ([OPERATING](../OPERATING.md)) so strangers are counted per address, not as one.
4. **Check the copy answers** at its name: `curl -sI https://<copy>/trevato/forge` is 200.
5. **Run it from a third machine** (not the copy's box, not production):

   ```sh
   bun install
   bun scripts/release-load.ts <version> --url https://<copy> --repo trevato/forge
   ```

   It takes about 80 s: per pass, a 20 s warm-up that is not counted (its per-second `served/refused` line is printed), then 20 s at 500/s. Add `--crawl 3000` to spread the load over the repository rather than its top folder.
6. **Read the verdicts.** It ends with one line per file. Each of `bench/results/<version>.json` (through the edge) and `bench/results/<version>.bypass.json` (past it) holds `asked` (the rate), `servedPerSecond`, `refused` and `refusedBy`, `p50` and `p95` in ms, `warm` (`seconds`, `served`, `refused`), `target` (`{"rate": 500, "refused": 0, "p95UnderMs": 100}`) and `verdict`: `"target met"`, or how far it missed, e.g. `"12 refused of 10000; p95 131.4 ms, 31.4 ms over the 100 ms target"` or `"served 400/s, 100/s under the 500/s target"`. A missed target is written, not an error; exit 1 means the served rate fell more than 20% from the last kept file of the same kind.
7. **Post both files** as a comment on #9514, with the version, the machine the load ran from and the copy's box, and commit them in a pull to `bench/results/`. They become the first baseline the next release compares with.

Tests: `test/release-load-run.test.ts` runs the whole command against a local fake forge, one that keeps up (both files `"target met"`) and one that answers in 150 ms (both files say how far p95 missed), and checks that production is refused by name and by address before any request.

