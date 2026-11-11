# Who can see it, in one line

Every repository starts private: a new repository, a new app and its
repository, a fork of a private repository (whatever the fork asks for) and the
preview of a private app's pull. Each surface then says who can see it in the
same words, all read from `audienceFor` in `src/core/audience.ts`:

```json
"audience": { "level": "private", "who": "owner", "sentence": "Private: only you and the crew." }
```

- **`who`** is one word a client can branch on: `owner` (a person's private
  repository: its owner and their crew), `members` (an organization's private
  repository) or `anyone` (public). The `sentence` says the same for a person.
  It is named `audience`, not `visibility`, because `visibility` is already the
  `"public" | "private"` string clients read.
- **Web**: the repository head shows the sentence beside the Private/Public badge.
- **API**: `GET /api/v1/repos/:owner/:name` carries it, and a `PATCH` that
  changes `visibility` returns the new line in the same answer (the change is
  receipted as `repo.settings_updated`).
- **MCP**: the `repo` tool carries it; `here` carries it on a repository page
  and on an app's link. On an app's link it is there only for someone who may
  read the repository: a public app can sit on a private repository, and its
  visitors are told nothing about that repository, nor its counts.
- **Terminal**: the About card (`I`) prints the sentence. `who` is not printed
  on its own there: the sentence already opens with it, and the terminal is
  read by people, not branched on.

A stranger asking about a private repository gets exactly the answer a missing
one gives, on the API and through `here`.

Tried by `test/visibility-line.test.ts`.
