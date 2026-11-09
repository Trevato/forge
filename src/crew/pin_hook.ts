/**
 * The crew clone's `pre-push` hook (#6938): a push whose commits add or
 * change a file under `src/core/migrations/` runs
 * `bun scripts/pin-migrations.ts` first and commits the pin it writes, so a
 * builder cannot push a migration without its pin by forgetting a step.
 *
 * A hook cannot add a commit to the push already in flight, so when it
 * commits a pin it refuses this push and says to push again; the forge's
 * own push at the end of a run carries the pin commit if the agent stops
 * there. The hook runs inside the agent's sandbox, where `.git/hooks` is
 * read-only — the forge's own pushes skip it (`--no-verify`), so the
 * repository's script never runs outside the sandbox.
 *
 * A repository without `scripts/pin-migrations.ts` is not touched; a pin
 * script that fails (a pinned migration was edited) lets the push through,
 * and the check's gate names the fix.
 *
 * In a repository with `src/kernel/try_it.ts`, a push whose commits change a
 * reachable file (`src/actions|web|http|tui/**.ts`) with no `Try:` line in
 * any of their messages is refused with the line to add: the gate's rule,
 * asked in the run rather than after it (9 of 19 red checks on 11-09).
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PIN_HOOK = `#!/bin/sh
# Written by the forge for every crew clone (src/crew/pin_hook.ts, #6938).
refs=$(cat)
if [ -f src/kernel/try_it.ts ]; then
  echo "$refs" | while read -r local_ref local_oid remote_ref remote_oid; do
    case "$local_oid" in *[!0]*) ;; *) continue ;; esac
    base=$(git merge-base origin/HEAD "$local_oid" 2>/dev/null) || continue
    git diff --name-only --diff-filter=d "$base" "$local_oid" 2>/dev/null | grep -qE '^src/(actions|web|http|tui)/.+\\.ts$' || continue
    git log --format=%B "$base..$local_oid" 2>/dev/null | grep -qiE '^Try:[[:space:]]*[^[:space:]].{9,}' && continue
    echo "pre-push: this pull changes a page, route, tool or screen and no commit says how to try it." >&2
    echo "pre-push: add one, e.g. git commit --allow-empty -m 'Try: open /settings/tokens and make a token', then push again" >&2
    exit 1
  done || exit 1
fi
[ -f scripts/pin-migrations.ts ] || exit 0
changed=
while read -r local_ref local_oid remote_ref remote_oid; do
  case "$local_oid" in *[!0]*) ;; *) continue ;; esac
  case "$remote_oid" in
    *[!0]*) from=$remote_oid ;;
    *) from=$(git merge-base origin/HEAD "$local_oid" 2>/dev/null) ;;
  esac
  if [ -z "$from" ]; then changed=1; continue; fi
  git diff --quiet "$from" "$local_oid" -- src/core/migrations/ 2>/dev/null || changed=1
done <<EOF_REFS
$refs
EOF_REFS
[ -n "$changed" ] || exit 0
bun scripts/pin-migrations.ts >&2 || exit 0
git add -- src/core/migration-pins/ || exit 0
git diff --cached --quiet -- src/core/migration-pins/ && exit 0
git commit --quiet --no-verify -m "Pin the migration this pull adds" \\
  -m "bun scripts/pin-migrations.ts, run by the crew's pre-push hook." \\
  -- src/core/migration-pins/ || exit 0
echo "pre-push: this push adds a migration without its pin; the pin is committed now — run git push again" >&2
exit 1
`;

/** Install the hook in the clone at `dir`, replacing any earlier copy. */
export function installPinHook(dir: string): void {
  const hooks = join(dir, ".git", "hooks");
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "pre-push");
  writeFileSync(path, PIN_HOOK);
  chmodSync(path, 0o755);
}
