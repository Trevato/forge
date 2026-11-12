# Claim redirect

What a stranger sees after pressing Start my forge (on `/`, `POST /forges/start`)
or Spawn on `/forges/new` (`POST /forges/new`). Both forms carry `data-js`, and
one script (`JS_FLAG_JS`, in `src/web/claim_code.ts`) adds `js=1` to them.

- **With JavaScript.** The answer is a 303 to `/forges/<name>/waiting#<code>`
  (`no-store`, its address carries the code). The waiting page is static and
  never holds the code: a few lines of script read the fragment, clear it from
  the address bar, poll `/forges/<name>/ready` (at most 120 tries), then go to
  the child's `/claim#<code>`. No code to copy.
- **Without JavaScript, from `/`.** No `js` field: the answer is a page, "Setting
  up <name>", with one link to the claim form (`no-store`).
- **Without JavaScript, from `/forges/new`.** The answer is a 201 page that shows
  the claim link once (`no-store`), to send or open.
- **From the terminal.** Unchanged: the door returns the claim link once and
  the terminal prints it.

A signed-in person never gets the redirect. A claim code that is not well formed
is never put in an address: the link page shows it instead.
