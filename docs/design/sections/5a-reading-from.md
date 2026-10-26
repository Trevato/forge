### 5a. Saying where you are reading from

Every repository page in the product carries the **where strip**, and it says
the same three things in the same order however you got there:

```
● codeberg.org · ○ workbench · ○ this machine        browsing live, read-only
● codeberg.org · ● workbench (synced 3m ago) · ◆ this machine    a mirror you keep
● workbench · ○ this machine                          a repository born here
```

- **Filled `●` means present, hollow `○` means absent, `◆` means kept on this
  machine.** The dot carries the colour; the word never does, so a strip reads
  as one fact rather than three competing badges.
- **Accent marks the place these bytes came from.** That is the page's own
  subject, which is the one thing accent is allowed to be besides interaction
  (§1.2). Exactly one place per strip wears it.
- **Every place is a link where one exists**: the origin goes to the repository
  on that forge, the workbench to the mirror here, and "this machine" submits
  the pin toggle.
- A repository that is **your fork of** another one says so in the strip, as
  the origin place's aside: `● codeberg.org (fork of octo/widgets)`. The About
  rail carries the same fact as a linked `Fork of` row — the strip is for
  orienting, the rail is for going there.
- A live browse also carries `.live-note` above the content, saying it is
  read-only and what to do about that. There is no second way to find out: a
  live page renders no composer, no state form, no labels form, no merge box
  and no settings tab, because `RepoSource` has no mutation on it to submit to.
  The three forms it does carry — Mirror, Fork, Propose a change — create
  something **for you**: a copy here, a fork of your own there, a proposal on
  it. None of them changes the repository being read.

The strip is the visible half of `RepoScope` (`src/web/scope.ts`); the pages it
sits on are the same renderers for both sides of the world, and a divergence
between a live browse and the repository we hold would be a bug you could see.
