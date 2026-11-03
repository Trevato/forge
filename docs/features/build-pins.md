# Build pins

A writer marks a commit as a build worth keeping: an annotated tag at
`refs/builds/<label>` holding the commit, who pinned it, a note and an
optional `Parent:`/`Source:`. Git holds all of it; pinning runs no check and
wakes no agent. Ported from Jay Moran's developer-forge work ; `git/builds.ts`
is trimmed to what main calls).

- Page: `/<owner>/<name>/builds` lists pins; `/builds/new` is the form (Branches has a Pin button per branch and a Builds link); Preview serves a pinned commit (`build_preview`); Delete is behind `/-/confirm`.
- API: `GET/POST /api/v1/repos/:owner/:name/builds`, `PATCH`/`DELETE …/builds/:label` (rw scope, a person who writes; agents are refused).
- Terminal: on a repository, the palette's `<owner>/<name> — Builds` (`src/tui/screens/builds.ts`) lists the pins to anyone who may read it; a person who writes (never an agent) presses `p` to pin (prefilled with the next label and the default branch's tip), `n` to note, `d` to delete.
- Notes are an append-only list on `refs/forge/notes`. `FORGE_NOTES_INTENT=<file>` copies each person's note once into that file under `## Iterator notes`.
- Left out: demos and displays, screenshots, the Iterations graph, the lineage on Branches.
