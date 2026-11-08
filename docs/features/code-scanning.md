# Code scanning

Every push to a repository is scanned (`src/checks/scan.ts`, run from the
post-receive hook, off git's answer):

- **Secrets** in the files the push changed: AWS, GitHub, Slack and Stripe
  live keys, and private key blocks. High, except in tests and fixtures
  (`test/`, `*.test.ts`, `fixtures/`), which quote fakes on purpose: medium there.
- **Advisories** in each changed `package.json`: a pin whose lowest admitted
  version is below the fix of an advisory the forge keeps
  (`ADVISORIES` in `src/checks/scan_rules.ts`, read without the network).

Each night (an hourly tick picks repositories whose last pass is a day old)
the default branch's whole tree gets both, plus **static analysis**: `eval`,
`new Function`, shell commands built from templates, and HTML written from a
value, in source files outside tests. Static findings are medium.

A finding is recorded once per fingerprint (rule, path and a hash of the
match). The matched text is never stored or shown: pages, logs and comments
name the rule, the file and the line.

A pass is bounded: at most 5 000 files, each at most 512 KiB, read in one
`git cat-file --batch` (a push of many refs costs one `diff-tree` and one
`cat-file`; a new branch is compared with the default branch's tip). A file
whose name holds a newline is never asked for, since it would shift every
later reply onto the wrong file. What a pass could not read is counted, and
the findings page says so: "partial: N files not read".

## Where it shows

- `/:owner/:name/findings`: every finding, open high first.
- The flows view (`/:owner/:name/flows`): a "Code scanning" line with the
  open count, linking to the findings.
- The terminal: the palette's **Findings in a repository** (`owner/name`,
  `src/tui/screens/findings.ts`) lists the same findings from the same reads.
  On an open finding, `a` asks why it may stand and accepts it through the
  same action as the page's form (`src/actions/scan_accept.ts`): a reader,
  an agent or a guest is refused, a guest sees nothing of a private
  repository, and an acceptance made there shows on the web page.

## Holding a release

When a landed tree of the forge's own repository (`FORGE_REPO`) would be
swapped in (`cut` in `src/checks/landing.ts`), an open high finding still in
that tree holds it: the landed pull is told why and where to accept. Each
open high finding's file is read at the landed commit and scanned again
(`presentAt`), so a secret on a branch that never landed holds nothing, and
one removed from the tree stops holding without an acceptance. If the tree
cannot be read, every open high finding holds. A person with write access (never an agent) accepts each
finding on the findings page or in the terminal with a reason of 3 to 500 characters; who, why
and when are recorded on the finding. Once none is open, the next landing
releases.
