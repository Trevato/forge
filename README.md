# forge

A software forge you can read in an afternoon and mold by hand.

Git hosting, code browsing, and a JSON API in one fast Bun process, with
**zero runtime dependencies** — the `package.json` dependency list is empty and
stays that way. Everything worth having is written here: the Result type, the
router, the SSR templates, the design system, the markdown renderer. The only
thing forge asks of the host is a `git` binary.

Forgejo is the reference for what a forge should _feel_ like. This is that
feeling on a foundation sized for one person.

## Run it

```sh
bun install          # dev-only: types + tsc, no runtime deps
bun run src/main.ts  # forge is up on http://localhost:3000
```

The first account you create becomes the admin. Then:

```sh
# mint a token, create a repo, push to it
curl -sX POST localhost:3000/api/v1/users \
  -d '{"username":"you","email":"you@forge.dev","password":"a-good-passphrase"}'

TOKEN=$(curl -sX POST localhost:3000/api/v1/tokens \
  -d '{"username":"you","password":"a-good-passphrase","name":"cli","scope":"rw"}' \
  | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

curl -sX POST localhost:3000/api/v1/repos -H "authorization: Bearer $TOKEN" \
  -d '{"name":"hello","visibility":"public"}'

git clone "http://you:$TOKEN@localhost:3000/you/hello.git"
```

Configuration is two environment variables: `FORGE_DATA` (default `data/`) and
`PORT` (default `3000`). Everything a forge instance _is_ lives under the data
directory — the SQLite index and the bare repos, in plain layout. Tar it up and
it moves.

## Develop

```sh
bun test              # protocol-level + adversarial suite
bun x tsc --noEmit    # zero type errors is the standard
```

## Shape

```
src/
  main.ts     boot
  app.ts      composition root (one data dir = one forge)
  kernel/     zero-dep primitives: result, error, id, log, db, hash
  git/        bare repos, smart HTTP v2, cat-file readers, hooks, guards
  core/       domain: users, sessions, tokens, repos, events, schema
  http/       router, request context, the server
  web/        SSR: html tag, design tokens, markdown, pages
```

Read `docs/ARCHITECTURE.md` for the principles and the reasoning behind them.

## What works today

Register and sign in, personal access tokens with coarse scopes, create public
and private repositories, push and pull over HTTPS, browse code (tree, blob with
line anchors, commit history) with README rendering, protected default branches
(force-push and deletion refused, honest fast-forwards allowed), a durable event
outbox, and a JSON API covering everything the UI can do. Pages render without a
line of JavaScript and are designed thumb-first.

Not yet: SSH transport, pull requests, issues, forks, webhooks delivery, CI.
The event outbox and API surface are shaped so these arrive as additions, not
rewrites.
