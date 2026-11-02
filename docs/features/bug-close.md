# A bug closes with a reason

An issue labelled `bug` cannot be closed by hand with nothing behind it. Unless
a merged pull closed it, commits on main already name it, or it was split into
other issues, the close needs a `note`: one sentence, at most 300 characters. It
is posted as a comment (`Closed as won't fix: …` when the reason is `dropped`,
`Closed: …` otherwise). A missing note is `reason_required`; a note that is too
long or not text is `invalid_note`.

- Page: the close form has a "why" field beside the reason select; it is
  optional for any issue that is not a bug.
- API: `PATCH …/issues/:number` with `{ state: "closed", note }`; without it on a bug, `422 reason_required`.
- MCP: `close` takes `note`; the same refusals.
- Terminal: `close <issue> "why"`. The reason is a note on every issue, bug or not.
  The issue screen's `x` has no field for one, so it refuses a bug and points to the page.

Exempt, because they say why themselves: the crew's live triage (`triage`), its
stale sweeps (`stale`), and the forge's own closes (`system`: the sentinel, the
superseded-pull sweep, the gate review, an app note withdrawn). Each is tested in
`test/bug-close-doors.test.ts`.

On a mirrored repository the close is forwarded to the origin, but the note is
kept as a comment on this forge only: the origin does not see why.
