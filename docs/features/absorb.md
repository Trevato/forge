# Absorb: an app becomes one of the forge's features

This page is for site admins and app authors. An app can declare a `feature` in its `forge.json`. A site admin can then absorb it. The app gets a place in the forge's user menu, and the forge keeps the app's typed settings. None of the app's code runs in the forge. The app keeps its repository, data and deploys, and it runs as an ordinary app with an ordinary app's access.

## Declare a feature

Add a `feature` block to `forge.json`:

```json
"feature": {
  "name": "Radar",
  "summary": "What the platform runs against what exists",
  "page": "/",
  "settings": {
    "runDays": { "type": "days", "default": ["mon", "thu"], "label": "Run on" },
    "runHourUtc": { "type": "int", "default": 13, "min": 0, "max": 23, "label": "Hour (UTC)" },
    "scout": { "type": "bool", "default": true, "label": "Search the web for ideas" }
  }
}
```

- `name` is the menu label, 1 to 40 characters.
- `page` is a path on the app. It starts with `/`.
- A setting's type is `bool`, `int` (with `min` and `max`), `string`, `choice` (with `choices`), `days` (`mon` to `sun`) or `list`. A setting has a `label` and may have `help` and a `default`.
- A block may hold at most 24 settings. A `string` setting holds at most 500 characters.

The parser rejects a wrong block and names the field (`src/apps/feature.ts`). A declaration does nothing alone: an app cannot absorb itself.

## Absorb an app

Only a site admin absorbs an app, un-absorbs it or changes its settings. A repository's own admin is refused, and an agent account is refused. An admin uses one of three doors:

- **Settings > Features** (`/settings/features`).
- The API: `PUT /api/v1/features/:slug` to absorb and `DELETE /api/v1/features/:slug` to un-absorb. Both need an `admin`-scope token.
- The `features` MCP tool. It is on the ask-first list: it shows a plan, and it applies only with `dryRun: false` and an `admin`-scope token.

Each act records an event: `app.absorbed`, `app.unabsorbed` or `app.feature_settings`. The settings event names the keys that changed, never the values.

Un-absorbing makes the app an ordinary app again. The forge keeps its settings for the next absorb.

## What an absorbed app gets

- **A menu entry.** The app's `name` appears in the user menu of each person who can read its repository. The entry opens `page` through `/apps/open`, which checks access as any app link does. Absorbing grants no one new access.
- **Settings.** `/settings/features/:slug` shows a form field per setting, and `PATCH /api/v1/features/:slug/settings` takes `{ "settings": { "runHourUtc": 9 } }`. A value that does not fit is refused with the setting named, and no value changes.
- **Environment variables.** The app's process starts with `FORGE_FEATURE=1` and one `FORGE_SETTING_<NAME>` per setting. For example, `runHourUtc` becomes `FORGE_SETTING_RUN_HOUR_UTC`. The forge passes only names of that form, so a feature cannot set a variable the forge owns. A change to a setting redeploys the app, as a change to an app variable does.

## What previews get

The forge reads the declaration from the commit it starts. A preview of a pull that adds a setting starts with that setting.

- A preview of a guest's pull that no writer has approved gets no `FORGE_SETTING_*` and no `FORGE_FEATURE`, in the same way it gets no secrets.
- Only a production start updates the menu's name and page. A pull's `forge.json` cannot relabel the forge's menu.

## Without the crew

Absorbing, settings, the menu entry and the page use no model and start no agent run. They work with the crew off and no model credential on the forge. `test/apps-features.test.ts` runs the whole flow that way. The forge never hands an app the crew's credential. A feature's schedule is the app's own: the app reads `FORGE_SETTING_*` and runs its own timer. An app that wants a model's judgment on top, such as an issue written from what it found, must do its work without one and treat the model as optional.

## Settings are not secrets

Settings are stored as plain values. Anyone who can read the app's repository can read them through `GET /api/v1/features/:slug`, and each preview of the app is given them. Put keys and passwords in the app's secrets (`/settings/secrets` or the app's variables), not in a setting.

## Review

See `docs/features/absorb-review.md` for the findings of #9441.

## Code and tests

- Code: `src/apps/feature.ts` (the declaration), `src/core/features.ts` (storage), `src/actions/features.ts` (the rules), `src/apps/feature_env.ts` (the environment), `src/web/pages/features.ts`, `src/http/api/features.ts`, `src/http/mcp/tools/features.ts`.
- Tests: `test/features.test.ts` holds the rules. `test/apps-features.test.ts` runs a real app: it absorbs the app, changes a setting and reads the variables back from the running process.

## Not done yet

The forge does not yet fire a feature's schedule, show its feed items, serve its MCP tools inside the forge's `/mcp`, keep `secret` settings or show its health on `/system`.

## Findings

Absorb was built by Ben (benjivers). The review of #9441 found:

- **Security:** a push to the production branch can relabel an entry in every reader's menu (#9541).
- **Without the crew:** it works with the crew off and no model credential, as `test/apps-features.test.ts` shows (#9441).
- **Experience:** an admin has little to find Absorb by and no preview before it acts (#9544).
- **Product:** a pack cannot say "absorb this app", so each needs a click-through (#9545).
- **Speed:** the Features list reads git for every app on every request (#9543).

This section is ready for the owner to share with Ben.

## Finding it, and what the switch does

A site admin (a person, not an agent) sees a "Features" link on the app strip of any app whose default branch declares a feature, absorbed or not, and of any absorbed app; nobody else does. The strip is on the app's code page, not its other tabs. The declaration is read from git once per commit and cached, so later page views cost no git read. The Settings → Features page lists the same apps, and its empty state links this guide. The same list, switch and settings are in the terminal: the "Features" palette entry. Beside Absorb or Un-absorb, a line says what restarts and whose menu gains or loses the entry. A refused settings save re-draws the form with what was typed and marks the refused field.

## The menu entry is the admin's, not the deploy's

The name and page in the menu are the ones the admin saw when absorbing. If the production
`forge.json` later declares others, the menu keeps serving the absorbed ones and Settings ›
Features shows "declaration changed: review" with the new values; an admin accepts them
(`POST /settings/features/:slug/accept` with the reviewed `name` and `page`; refused with a re-review flash when the app declares something else by now; event `app.feature_declared`). Feature entries sit under
their own "Features from apps" heading. The declared `summary` is the entry's `title` (shortened at a word to 200 characters). It is copied, like the name and page, when an admin absorbs and when one accepts; a changed summary alone also shows "declaration changed: review". Apps absorbed before the summary was kept show no title, and appear to review once if they declare a summary, until an admin accepts. The title is a tooltip: a pointer's, not a keyboard's or a touch screen's. A name equal to a built-in menu label is refused.

### Accepting in the terminal

Open the palette and choose "Menu entries to review" (site admins who are people only). It lists the
absorbed apps whose declaration changed; `j`/`k` move, `a` accepts the selected row. The accept posts the
name and page the screen showed, so one that changed since is refused ("review it again"), as on the page.
