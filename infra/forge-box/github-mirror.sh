#!/usr/bin/env bash
# Push each bare repository that has a `github` remote to it: branches and
# tags only, no force, no prune. Nothing is ever deleted on GitHub, and a
# branch that cannot fast-forward is refused (non-zero exit, reported) rather
# than overwritten. A push of the same refs twice changes nothing, so this may
# run beside pg-grand's timer. pg-grand's own script is not in this
# repository; this does not claim to equal it, only to be safe beside it.
# Layout: $FORGE_DATA/repos/<owner>/<name>.git (src/app.ts, src/snapshot/restore.ts);
# the remote is named `github` and is configured in the repository itself.
set -uo pipefail
repos="${FORGE_DATA:-/var/lib/forge}/repos"
rc=0
for r in "$repos"/*/*.git; do
  [ -d "$r" ] || continue
  git -C "$r" remote get-url github >/dev/null 2>&1 || continue
  git -C "$r" push github 'refs/heads/*:refs/heads/*' 'refs/tags/*:refs/tags/*' || { echo "mirror failed: $r" >&2; rc=1; }
done
exit $rc
