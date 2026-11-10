# A mistyped repository address offers close ones (#10969)

Open `/trevato/forg` and the 404 keeps its words, then adds one line under them: *Did you mean trevato/forge?* with up to three links.

- **What is suggested:** repositories whose `owner/name` is within edit distance 2 of what was typed (case ignored, a trailing `.git` dropped), closest first, at most three.
- **Only what you can read.** The listing is filtered by the viewer's visibility before anything is compared, so a private repository is suggested to who may read it and to no one else. An anonymous viewer is offered public repositories only. Nothing is said when nothing is close, and the status stays 404.
- **What is not suggested:** users, organisations, issues, files or branches (only the `owner/name` of a repository), anything on a non-GET request, and anything on an API answer.
- **The 500 cap:** only the first 500 repositories visible to the viewer are compared (in pages of 200), so the cost of a miss is bounded on a large forge. A close repository beyond the 500th is not offered.
- **404 only.** The lookup runs when an address has already missed, never on a page that was found: a found repository's request makes the same statements as before (`test/did-you-mean.test.ts` pins the count). A miss costs up to three listing queries.
- **The terminal** has the same line. The command palette's `owner/name` prompt answers `not found — did you mean a/b, c/d?` on a miss that has close, readable repositories, and plain `not found` otherwise. Both doors share `src/core/near_repos.ts`.
