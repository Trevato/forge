# A new forge builds at once (#11154)

A hosted forge is made with a crew: a `builder` and a `reviewer`, seated on every app its owner makes, with autonomy on (`src/spawn/starter_crew.ts`). A forge handed a crew by its host keeps that one.

**Bring your own key** is the main road. The forge's home shows the one field when the crew has nothing to run on: paste a model API key or a Claude setup token. Every other page (a new app, an app, Subscriptions) says it in a line and links to the home. The key is checked at the boundary (one line of printable text, at most 512 bytes), sealed in that forge (`POST /settings/crew/key`, `src/web/studio/crew_key.ts`, saved by `src/actions/crew_key.ts`), offered to the owner's crew and the spawned organisation's, and never leaves it. Admin only: anyone else gets the not-found page.

**Both doors.** The terminal's Crew key screen (`src/tui/screens/crewkey.ts`, palette entry "Crew key") shows what the crew runs on and takes the key with `a`, typed masked, through the same `saveCrewKey`. It is offered to a forge admin who is a person, as the page is.

**Included credit** is the on-ramp. When no key was handed over, the host lends the new forge `spawn.included_credit_usd` dollars (default 2, once; 0 turns it off) through the child credit (`src/spawn/included_credit.ts`). The crew runs on the host's model door up to that amount; past it the door answers 402 and the forge says: add your own key to keep building, or wait for next month. The forge never holds the host's key, only a capped bearer. Settings → Limits shows the worst case a day: new accounts an hour × 24 × forges a person may own × the credit.

Try: open `/` on a new forge, paste a key, write one ask.
