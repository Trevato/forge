# Send a change without a forge of your own

This page is for an agent or a person who wants to change a forge's code and has only a short-lived sandbox: no inbound connections, maybe no git credential, maybe no outbound network. The path costs the host no forge: `spawn` with `purpose: "contribute"` makes nothing and answers these steps; `/llms.txt`, `/agents`, the welcome answer and the terminal's *Send a change* screen say them too.

The steps:

```sh
# 1. fork (MCP `fork`, or POST /api/v1/repos/{owner}/{name}/forks): the fork is yours, public, and bounded by the guest limits
# 2. the source at a commit, no git credential, plain HTTPS (a full 40-hex commit id never changes and is cached forever)
mkdir work && curl -fL https://<forge>/<owner>/<name>/archive/<branch-or-commit>.tar.gz | tar xz -C work --strip-components=1
cd work
# 3. nothing to install: the forge has no dependencies beyond Bun
bun scripts/gate.ts && bun x tsc --noEmit        # `bun install` first only if typecheck lacks types
files=$(bun scripts/fast.ts) && bun test $files  # the tests the change touches
# 4. see it work, for your own use: loopback only, data in a temp directory, no crew
FORGE_DATA=$(mktemp -d) FORGE_APP_ENV=preview FORGE_HOST=127.0.0.1 FORGE_SSH_PORT=0 PORT=3000 bun src/main.ts &
curl -s http://127.0.0.1:3000/
```

`FORGE_APP_ENV=preview` holds the crew off, so nothing there spends a model's
budget; `FORGE_HOST=127.0.0.1` keeps it off the network.

**A sandbox with no outbound network.** Read the source through the MCP
instead: the resource `forge://source/{owner}/{name}@{ref}` returns the
archive (`?path=src/dir` for part of it), base64 in the resource's `blob`;
decode it into the sandbox's files and carry on from step 3. A sandbox with
neither can still change the code by reading files with the MCP's
`read_file` and proposing by hand: the forge's own check is the one that runs.

**Sending the work back, without git.** MCP `open_pull` with `title`,
`head` (the branch to make on your fork, optional) and either `patch` (a
unified diff of text files, at most 256 KiB) or `files` (`[{ path, content }]`,
`content: null` deletes). It commits to a branch on your fork with you as
author and opens the pull. Say what you ran in `checks` (`{ name, result:
pass|fail|skipped, detail? }`, at most ten): they are shown on the pull as
what you claim; the forge runs its own once a person approves the head.

**A forge to keep** is another matter, and `spawn` says what each costs whom:
*hosted here* (the host pays a cell), *on your machine* (`bun src/main.ts`,
your hardware), *on a cloud account* (your operator's account, from the forge's
Cloud page).

## Limits

The archive route (`/:owner/:name/archive/<ref>.tar.gz`) is open to anyone who may read the repository, so it is bounded: a few builds a minute per source address, a few at once on the forge, and 16 MiB of gzip. A larger tree goes by git or `?path=` for one directory.
