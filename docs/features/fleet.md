# Fleet rows

Before a fleet operation acts, see the rows its query line selects. There are two doors, and both show the same rows.

**On the web:** `GET /fleet?q=<query line>&sort=<column>` (`src/web/pages/fleet.ts`), linked from the fleet graph as "Rows".

- The page shows a row count and a table.
- Click a column header to sort by it, and click again to reverse. This works through `?sort=<column>` and `?sort=-<column>` links, so no JavaScript is needed.
- A line that does not parse shows its reason beside the field, with status 200, and selects nothing.

**Acting on the rows (web):** under the table, a signed-in person picks a verb for the kind and a value, and chooses Preview (`src/web/pages/fleet-ops.ts`, `src/web/fleet-act.ts`).

- Preview is a same-origin `POST /fleet` with `step=preview`. It shows each row's change, and which rows are unchanged or refused, each with its sentence in a muted line. Nothing is written.
- Apply is `POST /fleet` with `step=apply`. It carries a digest of the rows the preview showed (`src/fleet/digest.ts`) and runs `applyPreviewed`: if the rows now plan differently, nothing is written and a muted line asks for a new preview. Otherwise it lands on `GET /fleet/ops/:id`, the result.
- The result has Undo, `POST /fleet/ops/:id/undo`, which runs `undoFleetOp` while the operation is within `UNDO_WINDOW_MS` (a day) and not yet undone.
- No JavaScript is needed. A cross-origin POST is refused with 403. A signed-out visitor and an agent are not offered the form.
- A value reads as a flag (`true`, `false`), a number, or text, whichever the verb accepts. Leave it empty for a verb that takes none.

**In the terminal:** "Fleet rows" in the palette (`src/tui/screens/fleet.ts`).

- It asks for the query line and shows the same table.
- `/` writes a new line. `s` sorts by the next column and `r` reverses the sort. `j` and `k` scroll, and `esc` goes back.
- A line that does not parse keeps the prompt open with its reason.
- Signed in as a person (a guest or an agent is not offered these): `v` asks for a verb and its value (`label urgent`), then shows each row's change in a dialog. Apply writes through `applyPreviewed` with the digest of what the dialog showed. `u` undoes the last result. Same operations and refusals as the page (`src/tui/screens/fleet.ts`).

**In the API:** `GET /api/v1/fleet/rows?q=<query line>&sort=<column>` answers `{ kind, columns, items }`: the same rows `/fleet` shows, for the caller, public repositories only when signed out.

- `sort` is a column key, `-` leading to reverse; an unknown one is `invalid_sort` (422).
- A line that does not parse, an empty `q`, or a `q` over 500 characters is `invalid_query` (422) with the reason.

**The query line:** a kind, then `field:value` terms that must all hold. Both doors show the same grammar under the line: one sentence, then each kind with its fields (`GRAMMAR` and `fieldsOf` in `src/fleet/selection.ts`).

- A value starting with `!` negates its term: `repo:!trevato/forge`.
- A comma means any of: `state:queued,running`.
- `cost` and `number` take a number, and may compare it with `>`, `<`, `>=` or `<=`: `cost:>0.5`.
- `created` and `updated` take an age: a whole number of minutes, hours, days or weeks (`30m`, `12h`, `7d`, `2w`). `created:<7d` is younger than seven days, `created:>7d` older, and a bare `created:7d` means within seven days.
- A term that does not fit its field is refused, naming the field and what it wanted: "cost wants a number", "created wants an age like 30m, 12h, 7d or 2w", "state takes no comparison; only a value or values". Nothing is selected.
- `issue number:` now refuses text it used to accept. `number:abc` once selected nothing without a word, and now it says "number wants a number".

| Kind | Fields | Columns |
| --- | --- | --- |
| `repo` | `owner`, `name`, `repo`, `autonomy`, `visibility`, `created` | repository, autonomy, visibility, app |
| `run` | `state`, `kind`, `agent`, `issue`, `repo`, `cost`, `created` | started, repository, kind, agent, state, cost |
| `issue` | `number`, `state`, `assignee` (`none` for unassigned), `label`, `limb`, `repo`, `created`, `updated` | repository, #, title, state, assignee |

Every kind also has `id`, and all three share `owner` and `name`. Some examples:

- `repo autonomy:autonomous`
- `run state:queued,running cost:>0.5 repo:!trevato/forge`
- `issue repo:engine label:bug assignee:none created:<7d`

**Shared code and rules:**

- The grammar, and the rule that only rows the viewer may read appear, are `src/fleet/selection.ts`'s. A signed-out visitor sees public repositories only.
- Both doors read through `viewFleet` in `src/fleet/rows.ts`.
- Both use the columns and sort in `src/fleet/columns.ts`.
- A selection of more than 500 rows is refused, with a request to narrow the query, rather than cut short. Nothing is paged.
