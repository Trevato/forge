# Refused first asks (#11586)

`/forges/refused` lists the last 20 first asks a stranger made and the forge refused, newest first, with the refusal's words and when it happened. Only a site admin sees it; anyone else gets the same not-found page as any unknown path.

- **Read:** one `listRefusals` call (`core/first_ask_refusals.ts`); nothing is written by the page.
- **Escaped:** the ask is a stranger's text and is escaped on output. The rows hold no email or claim code, so none is shown.
- **Empty:** says "No first ask has been refused."
- **Door:** a link on `/system` and a terminal palette entry ("Refused first asks", `src/tui/screens/refused.ts`), both gated by `mayReadRefusals` (an admin who is a person), as the page is; `/forges` gets its own link in #11587.
