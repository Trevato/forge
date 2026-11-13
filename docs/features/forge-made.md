# The page that answers "make me a forge"

What a person sees after pressing Start my forge (on `/`, `POST /forges/start`)
or Spawn on `/forges/new` (`POST /forges/new`): one page, `madeBody` in
`src/web/forge_made.ts`, in a `no-store` body. There is one answer, with or
without JavaScript.

- **It says what is happening.** One sentence, a live region, changes with the
  real step read from `GET /forges/<name>/ready` ([forge-ready](forge-ready.md)):
  "<name> is made and is starting. This usually takes about 15 seconds.", then
  "<name> is running. Checking that its address answers.", then "<name> is
  ready." Past a minute it says the start is taking longer than usual and keeps
  asking. The page asks again a quarter of a second after each answer, so the
  wait past the forge's own start is never seconds.
- **The answer does not wait on the reach proof.** `spawnDoor` is called with
  `page: true`: it answers as soon as the forge is made, and the proof of its
  public addresses (`src/spawn/reach.ts`) goes on behind it, an alarm if it
  never comes. `POST /api/v1/forges` and the MCP `spawn` still answer with the
  proof.
- **A person who made it for themselves** (not signed in) gets **Open <name>**,
  shown the moment the forge answers; on a phone the page opens it by itself.
  The link goes to the forge's `/welcome` ([welcome](welcome.md)).
- **A person who made it to send** (signed in) gets the link at once, with
  **Copy the link** as the one primary action.
- **Both get a QR code** a phone's camera opens (`qrEncode`, `qrSvg` in
  `src/design/qr.ts`), the link as text, and a way to copy it. The page says
  plainly that whoever holds the link owns the forge, once, for a day. The
  code is not drawn under 720px: the person is already on the phone.
- **From the terminal.** The door returns the link once and the terminal
  prints it, with its own QR code.

Tests: `test/stranger-three-screens.test.ts`, `test/new-forge-language.test.ts`.
