# Mirror credit

A mirror's repo page carries one quiet sentence under its header: `Mirrored from <upstream> · <licence> · by <authors>`. A fork of a mirror says `Forked from a mirror of <upstream> · …`. A native repository carries none.

- Upstream: the origin's page (`repo.origin`, or what a detached mirror kept). It is a link only when it is an http(s) address; anything else is plain text.
- Licence: the root `LICENSE`/`COPYING`/`UNLICENSE` file at the viewed ref, named when it is a common licence (MIT, Apache-2.0, GPL, BSD…), else by file name; "no licence file" when absent.
- Authors: the three names behind the most commits among the newest 500 (`git log`), for the viewed ref whether it is a branch, a tag or a commit id. Bounded: git gets 1.5 s; past that the authors are left out (the page is not held) and nothing is kept, so the next view tries again.
- A fork shows the sentence found by walking `forkParentId` through repositories the viewer may read; a parent the viewer cannot read shows no line.

Two doors, one reading: `core/credit.ts` (`creditOf`, `creditText`) is shared by the web page (`src/web/credit_line.ts`, a `small muted` paragraph, no new class) and the terminal, where the workspace's status line (`src/tui/screens/workspace.ts`) carries the same sentence beside the ref.

Tests: `test/mirror-credit.test.ts`, `test/tui-mirror-credit.test.ts`.
