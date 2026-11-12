# The queue (#11618)

Every open issue, in the order the dispatcher will start them. The `/next` page, the terminal Next screen, the API and the `next_up` tool all read the one list in `src/core/next_up.ts` (`nextUp`); none keeps an order of its own.

Order: what a person sent from an app, then the ranked issues by place (a ranked issue that cannot start sits at its place; the dispatcher passes it), then the ready ones nobody ranked, then the unranked open issues that cannot start, by number. Work behind the Later gate is not in it; it is counted as `notNow`.

Each row has a `state`, derived from the dependency graph and not from the wording of `why`:

- `ready`: a builder starts it in its turn.
- `blocked`: open work stands in front of it.
- `held`: anything else that passes it over (a blocker closed as dropped, a hot file, an open pull, a reader's issue nobody adopted).

## API

`GET /api/v1/repos/<owner>/<name>/queue` (anonymous for a public repository; a private one is 404 to a guest).

- `limit` (1 to 200, default 100) and `offset` (default 0) page through it.
- Answers `{ queue: [{ position, number, title, onIt, state, why }], total, limit, offset, notNow }`.
- A bad `limit` or `offset` is 422 `bad_page`.

## The `next_up` tool

`next_up` with `app` lists the top ten; `all: true` lists them all. `more` counts what is not in `next`. Each row carries `state` and `why`.

## Bounds

One list carries at most 200 unranked rows that cannot start (`REST_MAX`); the rest is `unlisted`, said on the page and in `more`. The ready and ranked rows are not capped: they are what the dispatcher works through.
