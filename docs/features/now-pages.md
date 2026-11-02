# Now pages and Repositories

- Account menu → **Repositories** opens `/repos`: the repositories you may write, newest first.
- Home's Now line (site admins) links each word to what it counts: `/now/check`, `/now/review`, `/now/land`, `/now/live`. The list is `readNowRows` (`src/flow/now_rows.ts`), the same predicates `pipeline.ts` tallies, so the length is the number on home. `test/now-links.test.ts` walks both.
