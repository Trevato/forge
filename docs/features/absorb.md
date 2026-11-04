# Absorb: an app becomes a forge feature

An app can be taken in as one of the forge's own features without a line of its code moving into the forge. It keeps its repository, its cell, its data and its deploys. What changes is how a person meets it: it has a place in the forge's menu, and the forge keeps its settings, typed by what the app declares.

## Declaring

`forge.json` gains a `feature` block:

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

The types are `bool`, `int` (with `min`/`max`), `string`, `choice` (with `choices`), `days` (`mon`…`sun`) and `list`. The block is fail-closed, as the rest of `forge.json` is: a wrong one is refused with the field named (`src/apps/feature.ts`).

**Declaring is not absorbing.** A repository can't promote itself.

## Absorbing

A site admin absorbs an app from **Settings → Features** (`/settings/features`), `PUT /api/v1/features/:slug`, or the `features` MCP tool. Then:

- **Menu:** the app's name appears in the user menu for everyone who may read its repository, and opens its `page` through the forge's door (`/apps/open`), so a private feature opens without a second sign-in. Absorbing widens no access.
- **Settings:** `/settings/features/:slug` shows each setting as a form field typed by the declaration (`PATCH /api/v1/features/:slug/settings`). A value that doesn't fit is refused with the setting named, and nothing is kept.
- **The app:** its process starts with `FORGE_FEATURE=1` and `FORGE_SETTING_<NAME>` for each setting (`runHourUtc` → `FORGE_SETTING_RUN_HOUR_UTC`). A change restarts the app, as an env change does. The declaration is read from the commit being started, so a pull that adds a setting previews with it.

Un-absorbing (`DELETE /api/v1/features/:slug`) puts it back as an ordinary app. Its settings are kept for the next absorb.

Each act is an event: `app.absorbed`, `app.unabsorbed`, `app.feature_settings` (which names the keys, never the values).

## Not yet

The next slices: a schedule the forge fires instead of the app's own timer, feed items, the app's MCP tools inside the forge's `/mcp`, `secret` settings, and a health row on `/system`.
