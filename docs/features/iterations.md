# Iterations

A fork family's build pins, drawn as a tree of runs. Read-only: pinning, notes and deletes stay on Builds.

## On the web

Open `/:owner/:name/iterations`, or the **Iterations** button on a repository's Builds page (shown once it holds a pin). The page is not found when neither the repository nor any fork you may read holds a pin, and it is a 404 for a private repository you may not read.

- A **run** is a card: the fork's name, then one row per pin (label, date, first line of its note). A pin continues its repository's run, oldest first, unless it names a parent (`--parent`), in which case it hangs under that pin; a parent in another fork (`owner/name:label`) draws a dashed concept line.
- A fork carries its parent's pins; each is drawn once, in the parent.
- The family is the root you may read, and every fork below it you may read, at most 40 repositories. A private fork is simply absent for anyone who may not read it.
- With JavaScript: runs are placed under the build they grew from and joined by lines; **Collapse forks** / **Expand forks** fold every fork to its name; the fork name folds one fork, **fold run** folds a run to one node; **−**, **100%**, **+** and **Fit** zoom (Ctrl/⌘ + wheel too). Folds and zoom are remembered in this browser only. Without JavaScript the runs stand side by side and no button is shown.
- Pins are read from git and kept for 5 seconds per repository, so a new pin may take that long to appear.

## In the terminal

Open a repository, then the palette (`ctrl+k`) and **Iterations**. The family's runs are an indented list, a run under the build it grew from, its builds beneath; `j`/`k` move, `esc` goes back. It shows exactly what the page shows for the same viewer.

## Over the API

`GET /api/v1/repos/:owner/:name/iterations` answers `{ forks, lanes }` for the viewer: the same forks (each with its pins: label, sha as `oid`, date as `at`, first line of `note`, `parent`), and the same runs the page draws, at most 40 repositories, sharing the 5-second pins cache. A private repository you may not read is a 404; a private fork you may not read is absent; a family with no pin answers 200 with empty lists.
