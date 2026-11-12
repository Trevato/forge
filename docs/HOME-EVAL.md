# Scoring the owner's home

The owner's words, from #5735 (2026-10-25): "it's still kinda hard for me to catch up with what was done… the widgets and graphs are nice… but when I scroll down the 'what you asked for' is just not helpful, and the pull requests/decisions, crew words, releases, and the agents buttons do nothing. This was supposed to be like an X feed… iterate heavily, and the validation should be sending an agent with no context to read the feed, then produce a summary in its own words. That must align and get closer over time while also getting more concise and direct. Measure the real time it takes to produce, so that we can target fast comprehension."

## The method

1. Fetch `/` as the owner and convert it to text: what the eye sees, with scripts and styles stripped (`bun scripts/home-read.ts <url>`, #5765).
2. A fresh agent with no context reads only that text and answers, in at most 150 words: what got done, what needs me and what I'd do about it, what's worrying, and its confidence. The steward runs this step.
3. Score it against ground truth on three numbers: **coverage** of the 5 things that truly mattered, **errors** (claims the page made wrong), and **seconds** to produce.
4. Repeat after every feed change. The target: coverage ≥ 4 of 5, 0 errors, under 15 s, and falling words.

## The deterministic half

`bun scripts/home-eval.ts <forge-url>` does step 1 and scores the page itself, so the crew can run it on every feed change. Set `FORGE_COOKIE` (the owner's session) and/or `FORGE_TOKEN` (a `ro` bearer token); neither is printed. It prints each fact as `stated`, `missing` or `wrong` with the page's words beside what the forge says, then `coverage N of 5 · errors N · chars N · fetched in N ms`.

The five facts, and where the truth comes from:

| Fact | Truth | `stated` when the page says | `wrong` when |
| --- | --- | --- | --- |
| landed and released | `GET /api/v1/telemetry/home`: landings in 24 h, the live version (the running commit; `main` and `behind` beside it) | `N changes in 24 h` and the live short sha | N differs |
| waiting on the owner | the same: the home's own ask list | `N waiting on you` (or nothing at zero) | N differs, or a line at zero |
| builders idle and why | the same: running of slots, and the reason (ceiling reached, no slots, no ready work) | the right `N of M` and the reason | `N of M` differs |
| spend against the forge cap | the same: spent today and the daily ceiling | `$X of $Y` | X or Y differs, or `no ceiling` while one is set |
| repositories with no commit in 3 days | `GET /api/v1/repos` then each repository's newest commit | every quiet repository named on a line with `no commit`, `quiet`, `stalled` or `silent` | such a line names a repository that is not quiet |

Limits: the window is the last 24 hours, the one `/api/v1/telemetry/home` reads; landings are counted, not named. A fact the page may rightly leave out (nothing waiting, no quiet repository) scores `stated` when the page does not claim otherwise. The cold-read agent of step 2 stays the steward's.

## The two scripts

**Reading the home as the eye does (#5735, step 1).** `bun scripts/home-read.ts <url>` fetches a page and prints its visible text, then one line: `chars N · words N · fetched in N ms`. Set `FORGE_COOKIE` (for example `forge_session=…; forge_mode=studio`) to read it as the owner; the cookie is sent and never printed. It exits non-zero on any status but 200. The conversion is `pageText` in `src/web/page_text.ts`: scripts, styles, templates, the head and anything `hidden` or `aria-hidden="true"` are dropped, link text stays, blocks sit on their own lines, entities are decoded. The method then continues: (2) a fresh agent with no context reads only that text and answers in at most 150 words, (3) the steward scores it against ground truth on coverage of the 5 things that mattered, errors, and seconds, (4) repeat after every feed change. The steward runs steps 2–4 and logs them on #5735.

**Scoring the home (#5805).** `bun scripts/home-eval.ts <url>` is the deterministic half of that loop: it reads `/` with the same text conversion, builds ground truth from the forge's own API (`GET /api/v1/telemetry/home` for landings, the live version, builders and why idle, spend against the ceiling and what waits on the owner; the repository list and each newest commit for repositories quiet 3 days), and prints each of the five facts as `stated`, `missing` or `wrong` with the page's words, then coverage, errors, characters and fetch time. No dependency was added.

## Results

One row per feed pull, newest last. Coverage is out of 5; `agent s` is the cold read's seconds (steward), `script` is the fetch time of `home-eval.ts`.

| Date | Pull | Coverage | Errors | Chars | agent s | script ms | Note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-25 | baseline (#5735) | ~1.5 | 2 | 7,333 | 21.8 | — | ceiling shown as `no ceiling`; "5 waiting" listed 3 |
