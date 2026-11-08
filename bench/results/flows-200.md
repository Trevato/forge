# `/:owner/:name/flows` at 200 lines, warm, as admin (#9670)

Measured with `bun run bench/flows-200.ts` on main at b4137c8c, in the sandbox: one repository, 100 followed sources flowing in and 100 forks (half taking updates) flowing out — 200 lines on the page, counted from the response. One discarded warm-up request, then 200 requests as the admin over loopback. Budget: 50 ms.

| measure | p50 ms | p95 ms |
| ------- | -----: | -----: |
| whole request (client) | 19.6 | 25.8 |
| Server-Timing `app` | 14.9 | 20.1 |
| Server-Timing `session` | 0.1 | 0.2 |
| Server-Timing `render` | 12.7 | 17.4 |

**Verdict: within budget.** p95 is 26 ms against 50 ms for the whole request. The slowest phase is `render` (~13 ms p50, ~17 ms p95 — it includes `readFlows` and the radar read, then building ~200 rows); `session` is 0.1 ms. The rest of `app` is routing and the security floor. The client time includes the loopback fetch and reading the ~body, which is why it is a few ms above `app`.

Nothing in src/ changed; every phase the page spends time in (`session`, `render`, `app`) is already named in Server-Timing. #9658's test still bounds the view's SQL statements.

Not measured: a cold first request, a non-admin viewer (fewer actions per row, so lighter), and more than 200 lines. If the page ever needs to go faster, the idea (not built) is to cap each side to a first screenful with a "show all" link, since `render` grows with rows.
