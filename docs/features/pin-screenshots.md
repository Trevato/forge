# Pin screenshots

A build pin can keep curated screenshots: PNG, JPEG or WebP pictures, in order, each with a one-line caption, kept in git as a tree under `refs/shots/<label>` (`git/shots.ts`). They go with the pin: deleting the pin deletes them, and a label pinned again starts bare.

- **Who.** Anyone who reads the repository lists and fetches them. Changing them needs the `rw` scope and a person who writes the repository: an agent is refused (403), a mirror's builds are its origin's (409).
- **Limits.** 2 MB a picture, 12 a pin, a caption of one line at most 140 characters. A picture is typed by its first bytes, never its name.
- **API.**
  - `GET /api/v1/repos/:owner/:name/builds/:label/shots` lists `{ items, next_cursor, tree }`; each item has `file`, `caption`, `type`, `size` and a `url`.
  - `POST …/shots` uploads one: multipart with the picture as `shot`, optional `caption` and `at`.
  - `GET …/shots/looks` lists the pictures the forge took of the pin's commit that you may fetch; `POST …/shots/looks` with `{ "looks": [id, …] }` copies them in, in that order. Picking publishes them to everyone who reads the repository.
  - `POST …/shots/:file` takes `{ caption }` and/or `{ move: "up" | "down" }`; `DELETE …/shots/:file` removes one.
  - Every write may carry `at`, the `tree` it was read from (the `at` query parameter on DELETE); a list changed since answers 409 `moved`. Two writers racing without `at` still cannot both win: the loser gets `moved`.
  - `GET /:owner/:name/builds/:label/shots/:file` serves the picture (immutable when `?v=` matches).
- **Terminal.** **Builds** → `s` on a pin lists its screenshots; a writer has `p` pick from the forge's pictures of that commit, `c` caption, `u`/`d` move, `x` remove. Upload is the API's: a terminal has no file of yours to send.
- **Live.** Every change emits `build.shots` (`added`, `picked`, `moved`, `captioned`, `removed`), read by the repository's readers.

Left out: a gallery page, the demo/arcade side of Jay Moran's port, copying `refs/shots` into forks, activity wording for `build.shots`.
