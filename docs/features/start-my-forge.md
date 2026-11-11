# Start my forge

A signed-out visitor starts their own forge from the home page, with no account first.

1. Open `/`. The first view has one sentence, a "Forge name" field and the button "Start my forge".
2. Type a name (lowercase letters, digits and dashes) and press Enter or the button.
   While you type, the field says "<name> is free" or "is taken" (it asks `GET /forges/<name>/ready`, where 404 means nothing by that name was made).
3. The form posts to `/forges/start` (`src/web/pages/start-forge.ts`), which calls the same `spawnDoor` as `/forges/new` and `/agents`: the free plan and the visitor rate limits apply, and a bad name comes back on the same page, worded by the door.
4. The answer says "Setting up <name>…" and polls `/forges/<name>/ready`; when it says yes the browser goes to the new forge's claim page (username and password) and lands signed in. No link is shown to copy; a plain "Open <name>" link holds the same address if scripts are off or the forge is slow.
5. A signed-in person posting the form is sent to `/forges/new`, with `?name=` only when the name is a valid forge name, which keeps its fuller form (what it is for, apps to fork, key, budget). The Free plan's "Get a forge" button on the home goes to this start form.

The field is a slug, so it turns off autocomplete and capitalisation on phones. The form is in `src/web/studio/home.ts`; its test is `test/home-start-forge.test.ts`.

In the terminal, a guest's "Start my forge" command (`src/tui/screens/startforge.ts`) asks for the name, goes through the same `spawnDoor` as a stranger (counted under the SSH client's address), shows a refusal in the same fixed sentences as the home page, and shows the claim link once. Signed in, "New forge" is the fuller form. Test: `test/tui-startforge.test.ts`.

## When the door refuses

The form carries `from=home`. If the door refuses a stranger's start (rate limit, name taken, bad or reserved name, no room), they get a 303 back to `/?start=<kind>&name=<name>` and the home page shows one fixed sentence (`src/web/start_refusal.ts`) above the field, with the name kept. Only a kind from a fixed list is read; the door's own message, codes and times are never shown. Tests: `test/home-start-forge.test.ts`.

## Three screens, no link to copy

When the door accepts a start from the home page (`from=home`, signed out), the browser is not shown the claim link. If the new forge already answers, it gets a 303 straight to its `/claim#<code>` form; if it is still booting, a "Making your forge" page polls `GET /forges/<name>/ready` and goes on by itself (`walkOn` in `src/web/pages/new-forge.ts`). On the claim form the person picks a username and password and lands signed in as the forge's admin. Screens: `/`, the claim form, the forge. Test: `test/stranger-three-screens.test.ts` (in the gate, which runs every test file).
