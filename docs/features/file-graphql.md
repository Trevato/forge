# A GraphQL schema opens as its types

`.graphql` and `.gql` files open as blocks instead of raw text. Source is one tap away (`?view=source`).

- **Blocks:** one per `type`, `input`, `interface` and `enum` (and `extend` forms); each field is a row with its arguments, type and directives. `Query`, `Mutation` and `Subscription` come first.
- **Anything else** (`union`, `scalar`, `schema`, `directive`, operations, a body the reader cannot parse) is one plain row with its text, never an error.
- **Fallback:** a file with no type, input, interface or enum shows as text with one line saying why.
- **Cap:** 500 blocks and 500 fields per block, then `more not shown`. Files over 1 MB open as text.
- Every name is escaped, drawn on the server; no script, no dependency.

Code: `src/web/render/graphql.ts`, `src/web/render/kinds.ts`. Test: `test/render-graphql.test.ts`.
