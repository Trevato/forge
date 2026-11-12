# Permissions: contract.json

Version: 1

An app's permissions are data: roles, and for each resource the least role each
verb needs. One evaluator decides; the file can be read, compared and ported
without running the app.

## Wire format

`contract.json` at the repository root.

```json
{
  "roles": {
    "anon":  { "above": [],       "held": { "by": "everyone" } },
    "user":  { "above": ["anon"], "held": { "by": "identity", "role": "user" } },
    "owner": { "above": ["user"], "held": { "by": "row", "column": "author_id" } }
  },
  "resources": {
    "note": { "can": { "create": "user", "read": "anon", "update": "owner", "delete": "owner", "list": "anon" } }
  }
}
```

- `roles.<name>.above`: the roles directly below it; a role may do whatever
  anything below it may. No cycles; every name declared.
- `held.by` is `everyone` (exactly one role in the contract), `identity` (with
  `role`, a signed identity role) or `row` (with `column`, the row's column
  holding the actor's id).
- `resources.<name>.can` maps each of `create`, `read`, `update`, `delete`,
  `list` to a declared role. `create` may not need a `row` role.

## Decisions

`decide(contract, resource, verb, actor, row?)` is `yes`, `no`, or, for `list`
with no row, a filter `{ where: [columns] }`. Everything fails closed: an
undeclared resource, verb or role is `no`.

## A forge must

- refuse (not warn about) a contract that does not read, and fail the app's
  boot rather than run with a bad policy;
- show what a contract allows by reading git, without running the app.

## An app must not

- make a decision a different rule from the table would make.

Suite: `standards/forge.test.ts` validates a committed `contract.json` against
the shape above (declared roles, one `everyone`, no cycles, closed verbs).
