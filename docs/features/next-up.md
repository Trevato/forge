# Next up

`/:owner/:name/next` is the one ranked list the crew builds from (#8694). It shows the top ten in rank order with who is on each and, in one line, why a row cannot start yet; the rest is one line that opens `?all=1`, with the "Not now" work behind the Later gate below it.

- **Role:** each row is tagged *Blocker* (it holds other open work up: "finishing it frees N") or *Enabler* (it holds nothing up; its line says what it serves, else that the owner ranked it). The tag is a label only: it never changes the order the picker takes work in.
- **Move:** `Top` (`t`), `Up` (`u`), `Down` (`d`) and `Not now` (`n`) are forms on each row, with the key shown beside each; `j`/`k` choose the row, and a row can be dragged. Each is one `POST /:owner/:name/next` (`number`, `to` = `top`, `not-now` or `after:<number>`) and saves at once. Writers only; the same-origin check applies.
- **Top lifts the gate:** `Top` on a deferred issue removes its `wait_for` edge to the Later gate (and the Later umbrella's edge to it) in the same action. Work that only deferred work needs stays deferred, and the refusal says so.
- **Not now** links the issue to wait for the open Later gate and drops its rank.
- **The picker** takes the highest ranked startable issue before anything else, small work included (`readyNow`, `slotOrder`). A ranked issue something still blocks is skipped, never waited on. Same state, same pick.
- **MCP:** `next_up { app, issue?, to?, all? }` reads the list, or moves one issue with the same words.
- A rank is cleared when the issue closes. Dependencies order within the list and are shown, never edited here.

**Terminal:** the palette's "Next up in a repository" opens the same list; `t`, `u`, `d` and `n` are Top, Up, Down and Not now on the row under the cursor, through the same action as the page and MCP. A reader sees the order and the keys do nothing; a move made anywhere reorders an open screen live. At most 200 issues are ranked; a move past that is refused and says so.
