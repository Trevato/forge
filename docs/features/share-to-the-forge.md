# Share to the forge from a phone

Install the forge as an app (browser menu → Add to Home screen). It then
appears in the phone's share sheet. Share a page or some text to it and the
forge opens with the title, text and link joined into one draft in the tell
box — nothing is sent yet. Press Tell (or Enter) and the draft is queued as a
thought, or as a tell to the app you pick.

- Signed out? You are taken to sign in and brought back to the same draft.
- Sent twice (a double tap, a reload and resubmit)? It is told once; the second
  answers "Already sent." A post that fails (empty, too long) can be retried.
- The same draft works on `/` (tell box) and `/feed` (composer).

The field names (`title`, `text`, `url`; `text`, `app`, `back`, `once`) live in
`src/web/share_target.ts`; the manifest and both composers import them.
