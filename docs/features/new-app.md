# New app, from the terminal

Open the palette in the forge's terminal and choose **New app** ("say what it
does in a sentence; the crew starts on it"). It is offered to signed-in people,
never to agents.

1. Type one sentence, e.g. `a shared shopping list for the flat`, and press
   Enter. The app is named from it (`shared-shopping`, then `-2`, `-3` if the
   owner already has that name) by `newAppFromSentence`, the same action the
   `/apps/new` form calls with its name left blank. A sentence with nothing to
   name from (empty, punctuation only) keeps the prompt open with the no-name
   words.
2. If you are in organizations, a second **Owner** prompt lists them with your
   own username (prefilled). An owner not on the list keeps the prompt open.
3. A working line ("Making your app…") shows while the starter is committed and
   production starts; other sessions are not blocked. On success the new
   repository's screen opens and a note names the app and its address.

Refusals are shown as a toast in the same words as the web form:
`NEW_APP_ERRORS` for the action's codes, and the repository, storage and app
limit sentences. Nothing is made and no screen is pushed.

Try it: `ssh` to the forge (`$FORGE_APP_SSH` on an app), press the palette key,
pick **New app**.

## From the API and the MCP

`POST /api/v1/apps` and the MCP `new_app` tool take a `sentence` with no
`name` and go through the same `newAppFromSentence`: the name is derived, a
repeat gets `-2`, and nothing to name from is `no_name` (422 on the API). When
both are given, `name` wins and `sentence` is ignored.
