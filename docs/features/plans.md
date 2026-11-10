# Plans

Free, small, medium and large are a setting, never a constant (`src/settings/plans.ts`). Each plan has a key, a name, one line of words, the forge size (`src/spawn/sizes.ts`), a price in USD a month (0 is free), a crew credit in USD a month and how many forges one person may hold on it.

| plan | size | price / month | crew credit / month |
|---|---|---|---|
| free | small | $0 | $0 (bring your own model key) |
| small | small | $19 | $5 |
| medium | medium | $49 | $15 |
| large | large | $149 | $50 |

These are the defaults. A forge admin who is a person edits them:

- on `/admin/limits`, the Plans form;
- `PUT /api/v1/admin/plans` with `{ "plans": [...] }` (admin scope);
- the MCP `limits` tool with `plans` (dry run first, validated the same as the real change);
- the terminal: the Plans screen, `e` on a plan, `<field> <value>`, then a confirm.

`GET /api/v1/plans` is public and answers the plans, no secrets. It is revalidated by ETag, so an edit shows at once.

## What a spawn gets

`POST /api/v1/forges` (and the MCP `spawn`) takes `plan`. The forge's size comes from the plan (a `size` that disagrees is refused), and its credit cap is the plan's `creditUsd`, lent as a monthly cap through `src/spawn/credit.ts`: the spend is counted again each UTC calendar month. Plans are read at spawn time, so an edit governs the next spawn; forges already made keep the credit they were given.

The free plan keeps today's visitor and per-person limits (`src/spawn/rate.ts`, `forges.per_person`, `forges.storage_mb`); its `forges` figure is shown for the page and the API, and `forges.per_person` is what is enforced. A paid plan is held only to its own `forges` count, counted among the person's forges on that plan. A stranger and any person who is not a forge admin may take the free plan only: a paid plan lends crew credit from the forge's own model credential and no payment is taken yet, so the door, the API and the MCP all refuse it with one sentence until billing exists. A forge admin is never limited.
