# Forge standards

The forge is not this codebase; it is the contracts an app, a crew member, an
origin and a person can rely on. Two forges in different languages should host
the same app, run the same crew and talk to each other. Each page here is one
of those contracts: what it promises, the wire format, its version, and what a
conforming forge or app **must** and **must not** do.

These pages write down what the forge does today. They add no behaviour; a gap
the conformance suite finds becomes its own issue.

| standard | version | page |
| --- | --- | --- |
| App manifest: `forge.json` and its life cycle | 1 | [app-manifest.md](app-manifest.md) |
| Identity: the signed headers an app verifies | 1 | [identity.md](identity.md) |
| Permissions: `contract.json` | 1 | [permissions.md](permissions.md) |
| Feedback: app notes and reports become issues | 1 | [feedback.md](feedback.md) |
| Adapters: `POST /pull` | 1 | [adapters.md](adapters.md) |

The same list, machine-readable, is `GET /.well-known/forge` on every forge:

```json
{
  "forge": { "name": "forge", "version": "0.7.300" },
  "standards": [
    { "id": "identity", "version": 1, "title": "…", "page": "docs/standards/identity.md" }
  ]
}
```

`page` is a path in the forge's repository. A forge lists a standard only if it
passes that version of the suite.

## Versioning

Each standard has one whole-number version, on its page (`Version: N`) and in
`src/core/standards_index.ts`. A change that would make an implementation which
passed version N fail is a new version N+1: the page says what changed, the
suite keeps testing every version a forge may still claim, and a forge lists
the versions it implements. Wording, examples and new optional fields do not
change the version. `test/standards-conformance.test.ts` fails when a page and
the index disagree.

## The conformance suite

`standards/` is black-box: it speaks HTTP to a URL and nothing else, so it
runs against any forge or app, in any language.

```sh
FORGE_URL=https://forge.example FORGE_TOKEN=<rw token> bun test ./standards/
APP_URL=https://notes.forge.example bun test ./standards/       # an app alone
```

| variable | meaning |
| --- | --- |
| `FORGE_URL` | a forge's origin. Without it the forge tests are skipped. |
| `FORGE_TOKEN` | an `rw` token. The suite creates one scratch public repository (`standards-<random>`) under that account and deletes it at the end. Without it only the token-free checks run. |
| `APP_URL` | an app's origin. Without it the app tests are skipped. |
| `APP_ADAPTER=1` | the app declares itself an adapter; adds the `POST /pull` checks. |

(`./` matters: the repository's `bunfig.toml` roots plain filters in `test/`.)

A failing check begins with `[<standard> v<N>: docs/standards/<page>]`, the page
it breaks. The forge's own check runs the suite against itself and against a
minimal reference app (`test/standards-conformance.test.ts`).
