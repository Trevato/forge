# The crew's week shows which pulls came back (#10788)

On the crew week card, a member's **Returned** count above zero opens onto the pulls returned to them in the last 7 days. Zero stays a plain `0`.

- **On the web:** Settings → Crew → *This week*. The number links to a fold in a full-width row under the member's ("N returned to …"); open it for each pull: repository (muted), `#number` (the one link), title and the first line of the change request. No JavaScript is needed, and the numeric column keeps only the count, so the table holds at 360px.
- **In the terminal:** the *Crew this week* screen (palette: "Crew this week") lists the same pulls under the member's row.
- **Both doors are admin only**, as the card itself is; anyone else sees no figures.
- **Cap:** 10 pulls per member, newest first, then a muted "and N more". The list is one entry per change request, so it adds up to the count.

Read by `weekReturns` in `src/crew/week_card.ts`: one query for the whole page. The API and MCP week answers are unchanged.
