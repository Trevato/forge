# Iterations

A fork family's build pins, after Jay Moran's design: fork cards in columns, or a downward tree of runs, with a player and an info panel under the graph. Pinning and deleting stay on Builds; notes can be added from the panel.

## On the web

Open `/:owner/:name/iterations`, or the **Iterations** button on Builds (shown once the repository holds a pin). It is not found when neither the repository nor any fork you may read holds a pin, and for a private repository you may not read.

- **Columns** (default): a card per fork, in a column by fork depth. **Tree** (`?layout=tree`): a card per run, each hung under the build it grew from, joined by lines.
- A pin hangs under the parent it names (`--parent`; `owner/name:label` for a concept edge, a dashed line), else the nearest pin in its history, else it continues its repository's run. A fork carries its parent's pins; each is drawn once, in the parent. The family is the root you may read and every fork below it you may read.
- **Tree**: drag a run anywhere; **Align** keeps the order you dragged and snaps columns and spacing to a grid; **Reset** puts every run back. Positions are kept in this browser only.
- **−**, **100%**, **+**, **Fit** zoom (Ctrl/⌘ + wheel too). **Collapse forks** / **Expand forks** fold every fork to its name; the fork name folds one fork, **fold run** folds a run. Folds and zoom are per browser; a fork that gained or lost a pin since it was folded opens again.
- **Notes** hides the note lines. Click a build: its info panel (pin, commit, branch, lineage, notes, actions: copy link, clone, fork, delete pin for a writer) and its player. The player opens a build preview for an app; a repository that is no app plays nothing. `?build=owner/name:label` links to one.
- A writer adds a note in the panel (`POST /:owner/:name/builds/:label/note`); it is saved to `refs/forge/notes`.

Not here yet, as they wait for displays and the arcade: the Showcased / display picker, Edit display selections, captured pages (Build and play, Download) and screenshots.

## In the terminal

Open a repository, then the palette (`ctrl+k`) and **Iterations**. The family's runs are an indented list; `j`/`k` move, `esc` goes back.

## Builds

`/:owner/:name/builds` is Jay's lineage too: the family's pins as one list, each indented under the pin it grew from (the parent its person named, else the nearest pin in its history), a pin from another repository marked `owner/name:` with a dotted concept edge. The Pin a build form suggests a label (`iter-N` for an iteration branch or a fork's first pin) and offers every pin of the family as **Parent**; a pin made there lands on Iterations with it picked. The demo options wait for demos.

## Over the API

`GET /api/v1/repos/:owner/:name/iterations` answers `{ forks, lanes }` for the viewer: the same forks (each with its pins: label, sha as `oid`, date as `at`, first line of `note`, `parent`), and the same runs the page draws, at most 40 repositories, sharing the 5-second pins cache. A private repository you may not read is a 404; a private fork you may not read is absent; a family with no pin answers 200 with empty lists.

## Over MCP

The `iterations` tool takes `{ owner, name }` and answers the same `{ forks, lanes }` as the route, through the same module and for the same caller: `not_found` for a private repository the caller may not read, empty lists for a family with no pin. It is read-only.
