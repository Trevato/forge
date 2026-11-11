# Start my forge

A signed-out visitor starts their own forge from the home page, with no account first.

1. Open `/`. The first view has one sentence, a "Forge name" field and the button "Start my forge".
2. Type a name (lowercase letters, digits and dashes) and press Enter or the button.
3. The form posts to `/forges/new`, the same door `/agents` uses: the free plan and the visitor rate limits apply, and a bad name comes back worded by the door. There is no second spawn path.

The field is a slug, so it turns off autocomplete and capitalisation on phones. The form is in `src/web/studio/home.ts`; its test is `test/home-start-forge.test.ts`.

In the terminal, a guest's "Get your own forge" command prints the plans and the web address to start from; signed in, "New forge" spawns one.
