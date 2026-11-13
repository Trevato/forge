# Boards

## Held files card (`#board-holds`)

Drawn from existing components only: `card` with an icon head, `row` per hold
(path, repository, who and when, a ghost Release button in the trail), and a
`field` form to hold another path. No new class. It lists the holds of the
repositories the viewer administers and shows when there are none, because it
holds the form. A person who administers a repository but is not a forge
admin sees `/boards` as this card alone.

## Pulls on a held issue (`.held-pulls`)

In the held card, a hot-file hold lists the open pulls on that file after its
sentence. `.held-pulls` is a wrapping flex line; each `<a>` is a 44px-high tap
target with 8px of padding. Defined in `src/web/style/components.ts`.

## Verified after landing (#7786)

The card under the Pipeline table (`id="verified"`) adds no class: it is a `card()` with an `<h2>`, one `<p>` per repository in the default text colour, the repository and its run as plain `<a>` links, `small` for the run link. It is server-rendered, needs no JavaScript, and has no accent of its own.

## The boards page and a board (one system with the home)

`/boards` and `/boards/:slug` are the home's column (`.hf`, `.hf-head`, `.hf-title`), its figures (`.hf-figs`, drawn by `figure()` in `src/web/figure.ts`, which the home draws through too) and its tiles (`.tile`). `/boards` answers "is work moving, and where is it stuck" in its first screen: one sentence naming the bottleneck, only the lines that are true right now under it, five figures, then the pipeline; the boards are tiles under that, and everything else is a fold, closed, that says in one sentence how it stands. A board is its charts and nothing else until "Change this board" is opened. Styled in `src/web/style/components.ts`.

- `.bd-nav` — the two ways deeper in the head (Flow, Explore the data), 44px targets.
- `.bd-live` — the region that redraws as work moves (`data-live`, no address of its own, so the page is refetched for it at most once in 30 s): the sentence, the figures, the pipeline.
- `.bd-now`, `.bd-lead` — the bottleneck sentence at 16px and, under it in the muted colour, only the lines that hold right now (conflicted pulls, a held rebase lane, idle pulls).
- `.bd-block`, `.bd-head`, `.bd-sub` — a block of the page: its `<h2>`, one sentence of what it shows, and its quiet links.
- `.pl`, `.pl-cap`, `.pl-trend`, `.pl-spark` — the pipeline: §5's `.table` with every number right-aligned and tabular, a zero in the faint colour, the day's 24 hours as bars. On a phone each stage is a card: its name, then its five numbers in one row with their names over them.
- `.bd-boards` — the boards as tiles: two across on a phone, four from 720px. Each tile is a `data-nav` row for `j`/`k`.
- `.folds`, `.fold`, `.fold-title`, `.fold-state`, `.fold-body` — `fold()`: a `disclosure` whose summary is the section's name and one sentence of how it stands now ("nothing queued; 26 landed in the last hour"); the detail is inside. Hairlines between, no card.
- `.held-n` — one count of the held table ("2 running"), never broken inside.
- `.bgrid`, `.bp`, `.bp-w2`, `.bp-w3`, `.bp-h2`, `.bp-h3` — a board's panels: a panel is a third, two thirds or all of a row at least and grows into what is left, so a row is never part empty; one under the other on a phone.
- `.bp-head`, `.bp-now`, `.bp-body`, `.bp-foot` — a panel: its title, the latest value of a single series beside it, the chart, and under it Explore, JSON and CSV as 44px links.

## Explore the data (`/boards/data`)

One question, one answer. The page is the home's column and head, then the question (`.bd-ask`: the sentence box and Show, with the ready questions under it as the home table's chips, `.tb-chip`), then the answer as a `.bd-block` whose `<h2>` is the question said back in words ("Count of runs per day."): four of the home's figures naming what stands out (the latest, the highest, the lowest, the total; each links to the rows behind it), and the one chart in a card. Everything else is a fold: the points as a table (times as words, exact values, right-aligned), "Change the question" (the query form, open when the answer is empty or refused), "Pin this to a board", and "What you can ask about" (the sources and the columns of the one in use).

- `.bd-query` — the query's fields (and a panel's, under a board) on a grid: four across, two on a phone, every label on one line and every box on the next, the button at the foot of its cell.
- `.bd-ask` — the question's form: the box grows to 480px, the box and the button are 44px high and share a baseline.

## The list and a board's management (#9815)

`boardsList` is a `bd-block` "Your boards" with one tile per board (title, charts, range), or one plain sentence when there are none; the make-a-board form is a closed `disclosure` under it. Under a board, Panels, Add a panel and Board are folds. The panels in the grid keep their `card` shape.
