# Where a sent forge link stands

This page is for the person who sends forges to clients and wants to know,
without asking, whether a client took the link. It extends
[client-forge.md](client-forge.md).

## The four states

`/forges`, the terminal's forges screen and MCP tool `forges` say the same
words for each forge sent, read from what is already kept:

- **Sent**: the link was made and not opened. The time is when it was sent.
- **Opened**: the link was spent, but nobody has signed in yet.
- **Signed in**: the client made an account. The time is when the link was
  spent; when the child did not say, no time is shown.
- **Last tell**: the client told the crew something. The time is the latest
  tell the child's heartbeat carries (it carries the latest, not the first).

## Resend

A link unopened for three days reads "Not opened in 3 days", and the page's
button says **Resend** (it posts to `/forges/<name>/claim-link`, the same as
"Send a fresh link": a new link, the old one stops working). In MCP, the row's
`stage.resend` is true; the action is MCP tool `claim_link` with the forge's
name. A claimed forge is never marked.

## Left out

- The first tell's time: the heartbeat carries only the latest tell.
- A one-call resend in MCP: `claim_link` is that call.
