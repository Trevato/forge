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
- The `features` MCP tool. It is on the ask-first list: it shows a plan, and absorbing and settings apply only with `dryRun: false` and an `admin`-scope token; calling a declared tool is described under MCP tools below.

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

## Its feed items

What the feed holds about an app's repository (runs, pulls, issues, looks) shows on its page, Settings › Features › the app, under "In the feed". The same items are `GET /api/v1/features/:slug/feed` and the `features` MCP tool with `slug` and `feed: true`. They are the viewer's own feed items for that repository, so nobody sees an item they could not see in the feed; a muted app still shows its items here. In the terminal, "Feature feeds" in the palette lists the absorbed apps you may read; `enter` opens one's items. Nothing is added to the feed: an app does not post items of its own.

## Without the crew

Absorbing, settings, the menu entry and the page use no model and start no agent run. They work with the crew off and no model credential on the forge. `test/apps-features.test.ts` runs the whole flow that way. The forge never hands an app the crew's credential. An app that wants a model's judgment on top, such as an issue written from what it found, must do its work without one and treat the model as optional.

## Settings are not secrets, except `secret`

A setting of type `secret` is kept sealed (AES-GCM, bound to the app and the name), handed to the app as `FORGE_SETTING_*` and never shown again: pages, the API and the MCP say only whether one is kept. It has no default (forge.json is not a place for one); a blank in the page's form or the terminal's prompt keeps what is kept, while a blank sent through the API or MCP clears it (it then reads as not set). The terminal masks what is typed and shows `kept` or `not set`. Sealed is not hidden from the app: a secret reaches every preview of the app that gets settings, as a plain setting does, so code in a pull can read it. Keep one only for an app whose previews you trust. The page shows `Kept` or `Not set` as text tied to the field and says that clearing is the API's or the MCP's. Every other type is stored as a plain value.

Other settings are stored as plain values. Anyone who can read the app's repository can read them through `GET /api/v1/features/:slug`, and each preview of the app is given them. Put keys and passwords in the app's secrets (`/settings/secrets` or the app's variables), not in a setting.

## Review

See `docs/features/absorb-review.md` for the findings of #9441.

## Code and tests

- Code: `src/apps/feature.ts` (the declaration), `src/core/features.ts` (storage), `src/actions/features.ts` (the rules), `src/apps/feature_env.ts` (the environment), `src/web/pages/features.ts`, `src/http/api/features.ts`, `src/http/mcp/tools/features.ts`.
- Tests: `test/features.test.ts` holds the rules. `test/apps-features.test.ts` runs a real app: it absorbs the app, changes a setting and reads the variables back from the running process.

## Packs

A pack's app may carry `"absorb": true` (a boolean, nothing else). `pack deploy` then absorbs it as the deploying admin's act, with the `app.absorbed` event, after the app is made and followed. The app must declare a `feature` in its `forge.json`: if it does not, the step is reported as failed and the app stays made. A pack still carries no setting values.

Settings stay behind on a fork. A fork of another forge's app carries its `feature` block, which declares and does nothing; the new forge has its own settings (the declared defaults until an admin changes them) and its own admin decides on the absorb.

## Schedule

A feature may declare `"schedule": [{ "tool": "scan", "every": "1h" }]`: at most 4 entries, each naming one of the feature's own `tools` and an `every` of `15m`, `1h`, `6h` or `1d`. Anything else is refused with the field and the entry named. The forge keeps it as `schedule` (`tool`, `everyMs`) on the parsed feature. The forge calls it on that interval while the app is absorbed and running, and remembers how it went.

Settings › Features › the app, the `features` tool and the terminal's feed screen each show one line per entry: when it last ran, how it went and when it runs next. What each door shows, and the data behind it, is in [feature-schedule.md](feature-schedule.md).

## MCP tools

A feature may declare `"tools": { "scan": { "description": "Run a scan now", "writes": true } }` (at most 12; `writes` is true unless it says `false`). The forge adds no tool to `/mcp` for them: the `features` tool lists them as `tools` with a `slug`, and `{ slug, tool, args }` calls one of an absorbed app. The forge POSTs `{ "args": … }` to the app's `/forge/tools/<name>` over loopback and returns its JSON (at most 64 KB, 10 seconds). A read tool answers at once for anyone who can read the app; a write tool is for someone who can write it, needs an `rw` token and plans first (`dryRun: false` does it). The plan of a write is told only once the call could be made (allowed, absorbed, running). These tools are MCP-only on purpose: they are an agent's door to the app, and the app's own page is the person's, so the terminal has no entry for them (a person reaches the app itself there). Code: `src/apps/feature_tools.ts`, `src/actions/feature_tools.ts`; tests: `test/feature-tools.test.ts`, `test/features.test.ts`.

## Health on /system

The owner's `/system` page has a "Features from apps" list: for each absorbed app, production's state (`running`, `deploying`, `failed`, `asleep`, `stopped`, or `none` when the runtime holds nothing for it), the commit serving, since when, and why it is down or why a newer deploy failed. A newer failed deploy counts as unhealthy though the old one still serves. Unhealthy rows come first. The `system` MCP tool returns the same rows as `features`; an agent granted `telemetry:read` sees only apps with a public repository. It reads the runtime's state: no git read, no model. The terminal's `/system` screen draws them for the owner too (`featuresLines`). Code: `src/system/feature_health.ts`; test: `test/system-feature-health.test.ts`.

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

## Where an app comes from

Beside each app on Settings › Features, on its own page, and in the terminal's "Menu entries to review", two facts may show (the repository is already in the title):

- **Fork of**: the repository the app's repository was forked from. It shows only to someone who may read that repository, so a fork of a private repository does not name it to anyone else.
- **Last changed by**: the author and date of the latest commit on the default branch that touched `forge.json`. The author is the name the commit carries, not a verified identity: anyone who can push can write any name.

Nothing shows when there is nothing to say. The last change is read from git once per tip and kept.
