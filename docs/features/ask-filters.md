# Ask filters (#11820)

An owner sets what hides from what asks them, once, and it holds: on the page, in the MCP, in the terminal, on home and in the phone's notifier. Rows live in `ask_filter` (per person, in the forge's database; no cookie). Logic: `src/core/ask_filters.ts`; the one action all three surfaces call: `src/actions/ask_filter.ts`.

- A filter only decides whether an ask shows. The ask is never changed, declined or lost; it returns when a day's hide ends or on **Show all**.
- A trust alarm (a security ask, score 100) is never hidden by any filter.
- The dispatcher's order is untouched: hiding removes rows, it does not reorder the rest.
- A filtered list says `N hidden by your filters` once, with one tap to clear.
- Deleting an app deletes its filters (`forgetAppFilters`).

Where the inbox is: `/asks` (and home's "on you" region, the same section). `/:owner/:name/next` is a repository's planning page, not the inbox, and carries no filter.

## Page

`/asks` has one **Filter** disclosure above the list: pick an app and tap **Hide app for a day**, or pick a kind and tap **Hide kind**. When something is hidden the line `N hidden by your filters` and **Show all** lead the list. `POST /asks/filter` takes `do`, with `repo` (id) or `kind`; same-origin, signed in.

## MCP

`asks` with `filter`: `hide_app_day` (**Hide app for a day**), `hide_app` and `show_app` with `app`; `hide_kind` (**Hide kind**) and `show_kind` with `kind`; `clear` (**Show all**). The answer carries `filters: { hidden, line }` while any is set. See `docs/MCP.md`.

## Terminal

On the On you list: `H` hides the app under the cursor for a day; `F` shows all. The footer says `N hidden by your filters · F show all`.

## Words

One set, in `ask_filters.ts`: `hiddenLine`, `HIDE_APP_DAY_WORDS`, `HIDE_KIND_WORDS`, `SHOW_ALL_WORDS`; the terminal lowercases them. `test/ask-filters.test.ts` holds that the terminal and tool use them.
