# Cloning over git

The forge speaks git's smart HTTP (`https://<forge>/<owner>/<name>.git`) and
git over SSH (`ssh://<forge>:<port>/<owner>/<name>.git`), protocol v0 and v2,
with stock git and no extension. `src/git/smart-http.ts` and
`src/git/smart-ssh.ts` spawn `git upload-pack` and `git receive-pack` and pipe
bytes. Who may read or write is decided before git starts (`canRead`,
`canWrite`), the same way on both transports.

## A big repository

A repository with large files (CAD models, datasets, media) clones in full:

```sh
git clone https://<forge>/<owner>/<name>.git
```

To skip the big files up front, ask for a partial clone. The commits and
trees arrive at once. A file's contents are fetched the first time git needs
them: at checkout, and later when you switch to a commit that has a file
you have not fetched yet.

```sh
git clone --filter=blob:none https://<forge>/<owner>/<name>.git     # no file contents until needed
git clone --filter=blob:limit=1m https://<forge>/<owner>/<name>.git # files over 1 MiB until needed
```

Add `--no-checkout` to fetch nothing but history. `git checkout <branch>`
then fetches only that branch's files. The same flags work over SSH.

The forge runs `upload-pack` with `uploadpack.allowFilter` and
`uploadpack.allowAnySHA1InWant` (as `-c` options, so server-side git still
reads no global or system config). A later fetch of a missing file is an
ordinary upload-pack request for an object id, and it passes the same read
check as a clone. Without read access to the repository you cannot fetch any
of its objects, by name or by id (`test/big-clone.test.ts`,
`test/git-ssh.test.ts`).

## When a clone ends

A clone ends when it stops moving, not on a clock (`src/git/progress.ts`). If
fewer than 16 KiB reach the client in 30 seconds, the forge ends the
transfer: git is killed and the response is cut, so a client that stopped
reading frees both its transfer permit and what the forge had buffered for
it. A clone that keeps moving runs for up to two hours. Git's own keep-alive,
sent every 5 seconds while it is still preparing the pack, counts as moving.
A push ends after ten minutes. Once its pack has arrived, the forge runs
index-pack and the hooks with nothing to send, and that quiet is not a stall.

Signed-in clones and anonymous ones end by the same rule. Anonymous ones
still take a share of the transfer pool first (`src/http/strangers.ts`: four
at once per address, half the pool for every stranger together), and a
negotiation whose request body stops arriving for 30 seconds still ends.
