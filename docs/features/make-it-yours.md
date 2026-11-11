# Make it yours

Every app row in the explorer (`/explore`) says **Make it yours**. Signed in, one tap forks the app into your
account as an app of your own, following the original; code and history are copied, data and secrets are not
(`makeItYours` in `src/actions/make_it_yours.ts`). A receipt in plain words follows, with **Undo**. Signed out, the
row sends you to sign in, then to a plan page where one tap confirms and lands on the same receipt.

## Undo

`undoMakeItYours` removes the copy this tap made, only while it has no commits of its own and no pull was sent from
it; nothing is switched off before that is known. The receipt of a copy that was already yours says so and offers
no Undo. The original is never touched.

## Terminal

On a repository you can see but not write, open the palette and choose **Make it yours** (or press `Y` on the
repository screen): a name, a visibility, the plan, then a confirm. Once you have a copy, **Undo make it yours**
appears in the same palette and asks to confirm. A copy with changes or a sent pull is kept, and the toast says why.

## MCP

```json
{ "name": "make_it_yours", "arguments": { "repo": "alice/garden", "dryRun": false } }
{ "name": "make_it_yours", "arguments": { "repo": "alice/garden", "undo": true } }
```

Undo answers `changed`, `unauthorized`, `failed` or `not_found`, each for its own cause.
