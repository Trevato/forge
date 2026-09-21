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

## What is not here yet

- The forge reading `contract.json` from an app's default branch, and the
  audit screen's first lens (who can do what, across every app).
- The nightly probe of running apps as each identity (is it so).
- A changed cell as a policy proposal that blocks the work that needs it,
  and the wall: a cell loosened toward the floor is a person's decision.
- `sync`, `limits` and events as contract fields. They join the table when
  something enforces them, not before.
- Identities beyond `user` and `admin`. The forge signs one role today; the
  evaluator already takes a list.
