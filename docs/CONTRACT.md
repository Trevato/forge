# The contract — who may do what, as a table

An app's permissions are data. `contract.json`, at the root of the app's
repository, declares its roles and, for every resource, the least role each
of the five verbs needs. One evaluator reads it (`src/contract/can.ts`), and
that one file is carried verbatim into every app the forge scaffolds
(`src/can.ts` there), so the forge can say what an app allows by reading a
file in git, with exactly the code the app decides with, and without running
the app.

```json
{
  "roles": {
    "anon": { "above": [], "held": { "by": "everyone" } },
    "user": { "above": ["anon"], "held": { "by": "identity", "role": "user" } },
    "author": {
      "above": ["user"],
      "held": { "by": "row", "column": "author_id" }
    },
    "admin": {
      "above": ["author"],
      "held": { "by": "identity", "role": "admin" }
    }
  },
  "resources": {
    "note": {
      "can": {
        "create": "user",
        "read": "anon",
        "update": "author",
        "delete": "author",
        "list": "anon"
      }
    }
  }
}
```

## Roles are an order, and how a role is held is a value

`above` names the roles directly below a role; a role may do whatever
anything below it may. A role is **held** one of three ways:

- `everyone` — the floor. A contract has exactly one, and every role stands
  on it.
- `identity` — the forge signed the request as carrying this role
  (`src/who.ts` in an app: `user`, `admin`; more as the forge learns to sign
  more).
- `row` — the row's column holds the actor's id. `author` is not someone you
  are; it is what you are _to a row_.

Nothing here is a function, so a contract can be read, compared, exported
and ported. The evaluator is the same size for three roles or three hundred:
adding a kind of person adds a line to the contract. Roles grow downward — a
new role goes under an existing one — and the tests prove that doing so
changes no cell that was already there.

## The answer

`decide(contract, resource, verb, actor, row?)` is `"yes"`, `"no"`, or, for a
verb with no row in hand, `{ where: [columns] }`: the actor may have exactly
the rows whose columns name them. A `list` that the table gives to `author`
is a filter, not a refusal and not a leak. Only `list` becomes a filter;
`create` can never need a role a row holds, and the contract is refused if
it says so.

Everything fails closed. An undeclared resource, verb or role is `"no"`;
`nobody` is the cell that lets no one in; a name that only exists on
`Object.prototype` is not a role. A contract that does not read stops the
app at boot (`src/contract.ts` in the scaffold): a bad policy is not a
warning.

## The table, and the proof

`table(contract)` answers every resource × verb × **identity** with `yes`,
`own` or `no`. Identities are the roles someone can _be_ (`identities`); a
role a row holds shows up as `own`. `actingAs(contract, identity)` gives the
facts that make someone that identity and nothing more, with a row that names
them and one that names someone else. That is the policy as a person reads
it, the export, and what the audit will probe a running app against.

`test/contract.test.ts` proves the evaluator by exhaustion against an oracle
that shares no code with it: three hundred generated contracts, every
resource × verb × identity, on their own row, on someone else's and on none,
checked against the role order computed a second way. Four planted bugs
(the order reversed, the anonymous matching a row, a filter from any rowless
verb, a walk that stops early on a diamond) each fail it.

In an app, `src/contract.test.ts` closes the other gap: it acts as every
identity at every real door and fails when a door and the table disagree. A
rule written by hand in an action fails it; a changed cell does not, because
the doors obey the table.

## The audit's first lens

`GET /audit` is who can do what, across every app the viewer can read, read
from git (`src/contract/audit.ts`, `src/web/pages/audit.ts`): each app's
`contract.json` at the tip of its default branch, through this evaluator.
Nothing is run and nothing is asked of the app, so the page says what the
policy _is_. An app's standing is one of three: **sound**, shown as its
table with the doors open to the floor counted; **unsound**, shown with
every problem, because an app built on it does not boot; **unread**, an app
with no contract, whose doors are hand-written. Unread apps are listed, not
skipped: an audit that leaves out what it cannot read reads as a clean bill.

## The second lens: is it so

The table says what the policy is. The probe says whether the running app
obeys it, by knocking on every door as every identity and comparing the
answer with the cell. It is the audit's "trusting trust": the contract is
read from git, the evaluator is the app's own, and the probe trusts neither
— it asks the process.

### What a door is

A resource may name the collection path of its JSON API:

```json
"note": { "api": "/api/notes", "can": { … } }
```

Five doors follow by convention, and nothing else is declared:

| verb   | request                  |
| ------ | ------------------------ |
| list   | `GET    <api>`           |
| create | `POST   <api>` with `{}` |
| read   | `GET    <api>/<id>`      |
| update | `PATCH  <api>/<id>`      |
| delete | `DELETE <api>/<id>`      |

A resource without `api` has no doors the probe can find; its cells are
**unprobed**. A door that is not a route at all answers the router's 404,
which is not JSON; a JSON 404 is the action saying "no such row", which is
past the door. The probe tells them apart by the content type.

### What "admitted" means

The probe cannot send a valid body for every app's every resource, and does
not try. A door is a permission check that runs before anything else, so the
only two answers that mean "refused at the door" are **401** (not signed in)
and **403** (signed in, may not). Any other status — 200, 201, 400, 404,
422 — means the request got past the door; what happened next is the
app's business. Sending `{}` to `create` as a signed-in user should come back
400, and that is a pass: the door opened.

### Acting as each identity

The forge signs `x-forge-identity` for an app exactly as it does when it
proxies a visitor (`identityHeaders`), so the probe is the same person the
app would see at the same door: nobody, a user, an admin. Whoever runs the
probe names the account it knocks as (`who`); the nightly run will use one
the forge keeps for it, so an app that stores author ids sees one that
names no row.

Cells answered `own` need a row that names the actor, which the probe cannot
make without a valid body, so they are not asked; the identities above the
row role have `yes` cells, which are. Whether the row role itself is honored
is the app's own `contract.test.ts`, which acts with real rows.

### The verdict

Per app: `ok` when every probed cell answered as the table says; `mismatch`
with the cells that did not, each as a sentence ("note.delete as anon: the
table says no, the app said 404"); `unprobed` when no cell could be asked;
and `down` when the app was not running to be asked. `src/contract/probe.ts`
is the knocking; `test/probe.test.ts` proves it on a scaffolded app, then on
the same app with a hand-written rule in its delete door and its tests
dropped, which is the only way such a change deploys: the deploy runs the
app's tests first.

### Not built yet

The nightly run, the page's second lens (red cells, one issue per app —
never one per cell — closed by the next clean probe), on demand from the
page and a `probe` MCP tool, and after every production deploy. Results as
rows `(app, commit, when, verdict, cells)` for the third lens. The forge
never changes a contract to match an app: the table is the policy.

### What it never does

It never writes through a door on purpose: `create` sends `{}`, which no
real resource accepts, and `update`/`delete` use an id no row has (`0`).
An app that accepts `{}` as a note has a validation bug the probe will
reveal by leaving one note; that is the app's bug and the probe reports the 201. It never probes an app whose contract is unsound or missing. It never
probes previews.

## What is not here yet

- A changed cell as a policy proposal that blocks the work that needs it,
  and the wall: a cell loosened toward the floor is a person's decision.
- `sync`, `limits` and events as contract fields. They join the table when
  something enforces them, not before.
- Identities beyond `user` and `admin`. The forge signs one role today; the
  evaluator already takes a list.
