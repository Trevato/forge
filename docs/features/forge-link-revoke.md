# End a forge link, and undo it

A forge you sent carries a claim link that works once and for a day. Its sender (any site admin) can end it sooner, and bring it back for a minute.

- **Page.** On `/forges`, a forge with an open link shows *Link open* and **Revoke**. After a revoke the page returns to the row with a one-line receipt, and the row shows **Undo** for the next minute, whether or not you stay on the page. Once the minute is over, or the link was used or ran out its day, there is no button.
- **Terminal.** Open *Forges you sent* from the palette (admins only). `l` picks a forge whose link is open and ends it; `u` picks one whose link ended in the last minute and brings it back. Each row says `link open` or `link ended, undo with u`.
- **MCP.** `claim_link` with `{ name, action: "revoke" }` or `{ name, action: "undo" }`. Without `action`, it still re-issues, and only with `reveal: true`.

What the client sees: an ended link answers a plain 410 ("This link has ended") and sets no session. A used link cannot be revoked; an expired or used link cannot be undone; an undo after 60 s is refused.

Every change is an admin's, same-origin, and writes `forge.claim_revoked` or `forge.claim_restored`. The link's secret is in no event. The state shown on `/forges` is what the child last said to the parent's probe (no extra database open on the list); a revoke or undo forgets it, so the next list asks again.
