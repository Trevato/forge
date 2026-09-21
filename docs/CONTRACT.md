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

### When, and what comes of it

`src/contract/probes.ts` is the service: after every production deploy of
an app with a contract, once a night (09:00 UTC), and on demand — the audit
page's **Knock now** for whoever can write the app, and the `probe` MCP
tool. Every result is a row (`probe`: app, commit, verdict, the sentences,
every knock), so the page shows what the app said last and when, and the
history is there for the third lens. A mismatch opens **one** issue on the
app, "The app does not obey its contract", with the sentences, as the app's
owner — never one per cell, never doubled — and the first clean probe after
closes it. The forge never changes a contract to match an app: the table is
the policy, and the issue is the work.

### What it never does

It never writes through a door on purpose: `create` sends `{}`, which no
real resource accepts, and `update`/`delete` use an id no row has (`0`).
An app that accepts `{}` as a note has a validation bug the probe will
reveal by leaving one note; that is the app's bug and the probe reports the 201. It never probes an app whose contract is unsound or missing. It never
probes previews.

## The wall

A change to a contract is a change of policy, and one kind needs a person:
a cell **loosened** — something an identity could not do before that it
can after (`src/contract/policy.ts`). Against a contract that was there,
every identity counts: a decided cell that opens is a decision undone.
Where there was no contract, only the floor counts: what a stranger may do
is the one thing nobody decided yet. Tightening needs nobody.

A pull whose head loosens its base's contract is at the wall: its page
says so, with one sentence per cell ("note.create as anon: was no, now
yes"), and the crew never lands it on its own, however green — it stays
open on the studio's cards until a person lands it. A head whose contract
does not read is at the wall too. `test/policy.test.ts` proves the crew
stops there and lands a tightening pull in the same breath.

The crossing is a ledger row (`land`, answered `wall`, by `wall`) written
once per head, which is what puts the pull on the studio as a card of its
own: "it changes the policy: one door opens wider", with **Read the cells**,
**Land it** and **Not like this**. The decider is never asked which way; a
wall is a person's alone.

## The third lens: what changed

Policy is decided up front and left to hold, so a review asks what moved
since the last look. The audit page's **What changed** (`src/contract/
changes.ts`) is read from what already exists: the commits on each app's
default branch that touched `contract.json`, each with the cells it opened
wider or closed narrower; every pull still waiting at the wall, from the
ledger; and every knock whose verdict differed from the one before it.
Nothing is kept in step, so nothing can be forgotten.

## The policy, carried

Two more places the table reaches, so it is never only a page:

- **The builder's brief.** A run on an app with a contract is told the
  policy in force before it starts (`policyLines` in `src/crew/brief.ts`,
  from `policyBrief`): one line per resource, the identities the forge
  signs, that every door asks `permit`, and what the wall is. An app whose
  contract does not read is told to fix that first.
- **The table file.** `GET /audit.csv` is the audit as a spreadsheet: one
  row per app, resource, verb and identity, with the answer and what the
  door said when last knocked on. The viewer's apps only.

## What is not here yet

- The weekly policy review as a routine: the same three lists, once a week,
  as one issue for a person to sit down with.
- `sync`, `limits` and events as contract fields. They join the table when
  something enforces them, not before.
- Identities beyond `user` and `admin`. The forge signs one role today; the
  evaluator already takes a list.
