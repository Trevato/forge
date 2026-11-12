/**
 * The contract evaluator: who may do what, decided from a table.
 *
 * The proof is by exhaustion against an oracle that shares no code with the
 * evaluator: for many generated contracts, every resource × verb × declared
 * role is asked, and the answer must be what the role order says — computed
 * here a second way, as a transitive closure. The rest pins what the order
 * cannot say: rows, lists, strangers, growth, and that everything unknown
 * is "no".
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bakedFiles as scaffoldFiles } from "../src/apps/template.ts";
import { policyLines, taskPrompt } from "../src/crew/brief.ts";
import {
  NOBODY,
  VERBS,
  actingAs,
  atOrBelow,
  identities,
  check,
  decide,
  may,
  readContract,
  table,
  type Actor,
  type Contract,
  type Role,
  type Verb,
} from "../src/contract/can.ts";

/** Notes, as the scaffold declares them. */
const NOTES: Contract = {
  roles: {
    anon: { above: [], held: { by: "everyone" } },
    user: { above: ["anon"], held: { by: "identity", role: "user" } },
    author: { above: ["user"], held: { by: "row", column: "author_id" } },
    admin: { above: ["author"], held: { by: "identity", role: "admin" } },
  },
  resources: {
    note: {
      can: {
        create: "user",
        read: "anon",
        update: "author",
        delete: "author",
        list: "anon",
      },
    },
  },
};

const anon: Actor = { id: null, roles: [] };
const bob: Actor = { id: "bob", roles: ["user"] };
const carol: Actor = { id: "carol", roles: ["user"] };
const root: Actor = { id: "root", roles: ["admin"] };
const bobs = { id: 1, author_id: "bob" };

describe("notes, cell by cell", () => {
  test("anyone reads and lists; only the signed-in create", () => {
    expect(decide(NOTES, "note", "read", anon, bobs)).toBe("yes");
    expect(decide(NOTES, "note", "list", anon)).toBe("yes");
    expect(decide(NOTES, "note", "create", anon)).toBe("no");
    expect(decide(NOTES, "note", "create", bob)).toBe("yes");
  });

  test("the author and whoever is above the author may delete; nobody else", () => {
    expect(may(NOTES, "note", "delete", bob, bobs)).toBe(true);
    expect(may(NOTES, "note", "delete", root, bobs)).toBe(true);
    expect(may(NOTES, "note", "delete", carol, bobs)).toBe(false);
    expect(may(NOTES, "note", "delete", anon, bobs)).toBe(false);
  });

  test("an admin signed as admin alone still does what a user does", () => {
    expect(decide(NOTES, "note", "create", root)).toBe("yes");
  });

  test("an empty id is nobody, whatever a row holds", () => {
    const blank: Actor = { id: "", roles: ["user"] };
    expect(may(NOTES, "note", "delete", blank, { author_id: "" })).toBe(false);
    expect(decide(NOTES, "note", "create", blank)).toBe("yes");
  });

  test("a row that names nobody is nobody's", () => {
    expect(may(NOTES, "note", "delete", bob, { id: 2 })).toBe(false);
    expect(may(NOTES, "note", "delete", bob, { author_id: null })).toBe(false);
    // An anonymous actor never matches a row, even one that holds null.
    expect(may(NOTES, "note", "delete", anon, { author_id: null })).toBe(false);
  });

  test("a list a row decides is a filter, not a yes", () => {
    const mine: Contract = {
      ...NOTES,
      resources: {
        note: { can: { ...NOTES.resources["note"]!.can, list: "author" } },
      },
    };
    expect(decide(mine, "note", "list", anon)).toBe("no");
    expect(decide(mine, "note", "list", bob)).toEqual({ where: ["author_id"] });
    expect(decide(mine, "note", "list", root)).toBe("yes");
    // Only `list` turns a row into a filter: without a row, delete is no.
    expect(decide(mine, "note", "delete", bob)).toBe("no");
  });
});

describe("everything unknown is no", () => {
  test("an undeclared resource, verb or role; `nobody`", () => {
    expect(decide(NOTES, "invoice", "read", root)).toBe("no");
    expect(decide(NOTES, "note", "purge" as Verb, root)).toBe("no");
    const sealed: Contract = {
      ...NOTES,
      resources: {
        note: {
          can: {
            ...NOTES.resources["note"]!.can,
            delete: NOBODY,
            read: "ghost",
          },
        },
      },
    };
    expect(decide(sealed, "note", "delete", root, bobs)).toBe("no");
    expect(decide(sealed, "note", "read", root, bobs)).toBe("no");
  });

  test("a prototype's name is not a resource or a role", () => {
    for (const name of [
      "constructor",
      "toString",
      "__proto__",
      "hasOwnProperty",
    ]) {
      expect(decide(NOTES, name, "read", root, bobs)).toBe("no");
      expect(atOrBelow(NOTES, name, "admin")).toBe(false);
    }
  });
});

describe("reading a contract", () => {
  test("the notes contract reads back as itself", () => {
    const read = readContract(JSON.stringify(NOTES));
    expect(read).toEqual({ ok: true, contract: NOTES });
  });

  test("every problem is named, all at once", () => {
    const read = readContract(
      JSON.stringify({
        roles: {
          anon: { above: [], held: { by: "everyone" } },
          guest: { above: [], held: { by: "everyone" } },
          user: {
            above: ["anon", "ghost"],
            held: { by: "identity", role: "user" },
          },
          author: { above: ["user"], held: { by: "row", column: "author_id" } },
          nobody: { above: ["anon"], held: { by: "everyone" } },
          Loud: { above: [], held: { by: "everyone" } },
          odd: { above: ["anon"], held: { by: "magic" } },
        },
        resources: {
          note: {
            can: {
              create: "author",
              read: "anon",
              update: 7,
              list: "anon",
              purge: "anon",
            },
          },
        },
      }),
    );
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const all = read.problems.join("\n");
    expect(all).toContain("exactly one role is held by everyone");
    expect(all).toContain("`ghost`, which is not declared");
    expect(all).toContain("role `nobody`: not a usable name");
    expect(all).toContain("role `Loud`: not a usable name");
    expect(all).toContain("role `odd`: needs `held`");
    expect(all).toContain("note.update: every verb names a role");
    expect(all).toContain("note.delete: every verb names a role");
    // Said once, and never as a phantom role called `undefined`.
    expect(all).not.toContain("`undefined`");
    expect(read.problems.length).toBe(new Set(read.problems).size);
    expect(all).toContain("note.purge: not one of");
    expect(all).toContain("note.create needs `author`, which a row holds");
  });

  test("a cycle, and a role that does not stand on the floor", () => {
    const loop: Contract = {
      roles: {
        anon: { above: [], held: { by: "everyone" } },
        a: { above: ["b"], held: { by: "identity", role: "a" } },
        b: { above: ["a", "anon"], held: { by: "identity", role: "b" } },
        island: { above: [], held: { by: "identity", role: "island" } },
      },
      resources: {},
    };
    const problems = check(loop).join("\n");
    expect(problems).toContain("role `a` is both above and below `b`");
    expect(problems).toContain(
      "role `island` does not stand on the floor `anon`",
    );
  });

  test("two roles held by one identity are refused", () => {
    const twins: Contract = {
      roles: {
        anon: { above: [], held: { by: "everyone" } },
        a: { above: ["anon"], held: { by: "identity", role: "x" } },
        b: { above: ["anon"], held: { by: "identity", role: "x" } },
      },
      resources: {},
    };
    expect(check(twins)).toEqual([
      "roles `a` and `b` are both held by the identity `x`",
    ]);
  });

  test("text that is not a contract is refused, not thrown", () => {
    for (const text of ["", "[]", "null", '{"roles": []}', '{"roles": {}}'])
      expect(readContract(text).ok).toBe(false);
  });
});

describe("the table", () => {
  test("notes: what each identity may do, own told apart from yes", () => {
    const cell = (verb: Verb, as: string) =>
      table(NOTES).find((c) => c.verb === verb && c.as === as)!.answer;
    expect(identities(NOTES)).toEqual(["anon", "user", "admin"]);
    expect(cell("read", "anon")).toBe("yes");
    expect(cell("create", "anon")).toBe("no");
    expect(cell("delete", "anon")).toBe("no");
    expect(cell("create", "user")).toBe("yes");
    expect(cell("update", "user")).toBe("own");
    expect(cell("delete", "user")).toBe("own");
    expect(cell("delete", "admin")).toBe("yes");
    expect(table(NOTES)).toHaveLength(VERBS.length * 3);
  });

  test("a list a row decides is `own` for the signed-in and `no` for the rest", () => {
    const mine: Contract = {
      ...NOTES,
      resources: {
        note: { can: { ...NOTES.resources["note"]!.can, list: "author" } },
      },
    };
    const cell = (as: string) =>
      table(mine).find((c) => c.verb === "list" && c.as === as)!.answer;
    expect([cell("anon"), cell("user"), cell("admin")]).toEqual([
      "no",
      "own",
      "yes",
    ]);
  });

  test("what is not an identity acts as a stranger", () => {
    for (const name of ["author", "ghost", "constructor"])
      expect(actingAs(NOTES, name).actor).toEqual({ id: null, roles: [] });
  });
});

// ---- exhaustion against an independent oracle ----

/** A small deterministic generator, so a failure names its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A sound contract: a floor, then roles each above one or two earlier ones. */
function generate(seed: number): Contract {
  const next = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const roles: Record<string, Role> = {
    r0: { above: [], held: { by: "everyone" } },
  };
  const count = 2 + Math.floor(next() * 9);
  for (let i = 1; i <= count; i++) {
    const earlier = Object.keys(roles);
    const above = [...new Set([pick(earlier), pick(earlier)])];
    roles[`r${i}`] = {
      above,
      held:
        next() < 0.35
          ? { by: "row", column: `c${Math.floor(next() * 3)}` }
          : { by: "identity", role: `r${i}` },
    };
  }
  const names = Object.keys(roles);
  const rowless = names.filter((n) => roles[n]!.held.by !== "row");
  const resources: Contract["resources"] = Object.fromEntries(
    ["alpha", "beta", "gamma"].map((resource) => [
      resource,
      {
        can: Object.fromEntries(
          VERBS.map((verb) => [
            verb,
            next() < 0.1 ? NOBODY : pick(verb === "create" ? rowless : names),
          ]),
        ) as Record<Verb, string>,
      },
    ]),
  );
  return { roles, resources };
}

/** The role order a second way: Floyd–Warshall over the `above` edges. */
function closure(contract: Contract): (low: string, high: string) => boolean {
  const names = Object.keys(contract.roles);
  const reach = new Map(names.map((n) => [n, new Set([n])]));
  for (const n of names)
    for (const below of contract.roles[n]!.above) reach.get(n)!.add(below);
  for (const k of names)
    for (const i of names)
      if (reach.get(i)!.has(k))
        for (const j of reach.get(k)!) reach.get(i)!.add(j);
  return (low, high) => reach.get(high)?.has(low) ?? false;
}

describe("proof by exhaustion", () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

  test("a door answers in the time a lookup takes, on an order of hundreds", () => {
    // Every role above the six before it: a dense order, computed once.
    // "Once" is what is measured, by counting each time the order is
    // walked (a role asked what it stands above); a clock would measure the
    // machine instead.
    let walked = 0;
    const role = (above: string[], held: Role["held"]): Role => ({
      get above() {
        walked++;
        return above;
      },
      held,
    });
    const roles: Record<string, Role> = {
      r0: role([], { by: "everyone" }),
    };
    for (let i = 1; i < 300; i++)
      roles[`r${i}`] = role(
        Array.from({ length: Math.min(6, i) }, (_, k) => `r${i - 1 - k}`),
        { by: "identity", role: `r${i}` },
      );
    const contract: Contract = {
      roles,
      resources: {
        thing: {
          can: {
            create: "r150",
            read: "r0",
            update: "r299",
            delete: "r299",
            list: "r1",
          },
        },
      },
    };
    expect(check(contract)).toEqual([]);
    const actor: Actor = { id: "x", roles: ["r200"] };
    decide(contract, "thing", "create", actor);
    expect(walked).toBeGreaterThan(0);
    walked = 0;
    for (let i = 0; i < 1000; i++) decide(contract, "thing", "create", actor);
    // A thousand decisions later the order has not been walked again.
    expect(walked).toBe(0);
    expect(decide(contract, "thing", "create", actor)).toBe("yes");
    expect(decide(contract, "thing", "update", actor)).toBe("no");
  });

  test("generated contracts are sound", () => {
    for (const seed of SEEDS) expect(check(generate(seed))).toEqual([]);
  });

  test("every identity × verb × resource is what the order says", () => {
    let asked = 0;
    for (const seed of SEEDS) {
      const contract = generate(seed);
      const below = closure(contract);
      const rowRoles = Object.entries(contract.roles).flatMap(([n, r]) =>
        r.held.by === "row" ? [{ name: n, column: r.held.column }] : [],
      );
      for (const [resource, { can }] of Object.entries(contract.resources))
        for (const verb of VERBS)
          for (const as of identities(contract)) {
            const need = can[verb];
            const { actor, mine, theirs } = actingAs(contract, as);
            // What the order says, with no evaluator in sight. By identity:
            // the need is at or below who they are. By a row: they are
            // signed in, and some role a row holds is at or above the need.
            const byIdentity = need !== NOBODY && below(need, as);
            const columns = [
              ...new Set(
                rowRoles
                  .filter((r) => need !== NOBODY && below(need, r.name))
                  .map((r) => r.column),
              ),
            ];
            const byRow = actor.id !== null && columns.length > 0;
            const fail = (got: unknown, expected: unknown, on: string) => {
              throw new Error(
                `seed ${seed}: ${resource}.${verb} needs ${need}; as ${as} on ${on} got ${JSON.stringify(got)}, not ${JSON.stringify(expected)}`,
              );
            };
            asked++;
            if (verb === "create" || verb === "list") {
              const got = decide(contract, resource, verb, actor);
              const expected = byIdentity
                ? "yes"
                : verb === "list" && byRow
                  ? { where: columns }
                  : "no";
              if (typeof got === "object" && typeof expected === "object") {
                if (
                  JSON.stringify([...got.where].sort()) !==
                  JSON.stringify([...expected.where].sort())
                )
                  fail(got, expected, "no row");
              } else if (got !== expected) fail(got, expected, "no row");
              continue;
            }
            const onTheirs = decide(contract, resource, verb, actor, theirs);
            const onMine = decide(contract, resource, verb, actor, mine);
            if (onTheirs !== (byIdentity ? "yes" : "no"))
              fail(onTheirs, byIdentity, "their row");
            if (onMine !== (byIdentity || byRow ? "yes" : "no"))
              fail(onMine, byIdentity || byRow, "their own row");
          }
    }
    expect(asked).toBeGreaterThan(10_000);
  });

  test("the anonymous hold the floor and nothing else, whatever the row says", () => {
    for (const seed of SEEDS) {
      const contract = generate(seed);
      const below = closure(contract);
      const row = { c0: null, c1: null, c2: null };
      for (const [resource, { can }] of Object.entries(contract.resources))
        for (const verb of VERBS) {
          const expected = can[verb] !== NOBODY && below(can[verb], "r0");
          const got = decide(contract, resource, verb, anon, row);
          expect(got).toBe(expected ? "yes" : "no");
        }
    }
  });

  test("roles grow downstream: a new role under an old one changes no cell that was there", () => {
    for (const seed of SEEDS.slice(0, 100)) {
      const contract = generate(seed);
      const before = table(contract);
      const names = Object.keys(contract.roles);
      const parent = names[seed % names.length]!;
      // `fresh` sits between `parent` and everything `parent` was above:
      // under an existing role, as a scope adds them.
      const grown: Contract = {
        ...contract,
        roles: {
          ...contract.roles,
          fresh: {
            above: contract.roles[parent]!.above,
            held: { by: "identity", role: "fresh" },
          },
          [parent]: {
            ...contract.roles[parent]!,
            above:
              contract.roles[parent]!.held.by === "everyone" ? [] : ["fresh"],
          },
        },
      };
      if (check(grown).length > 0) continue;
      const after = table(grown).filter((c) => c.as !== "fresh");
      expect(after).toEqual(before);
    }
  });
});

describe("what a new app is born with", () => {
  const files = new Map(
    scaffoldFiles({ name: "notes", description: "" }).map((f) => [
      f.path,
      f.content,
    ]),
  );
  const source = readFileSync(
    new URL("../src/contract/can.ts", import.meta.url),
    "utf8",
  );

  test("the forge's evaluator, byte for byte", () => {
    expect(files.get("src/can.ts")).toBe(source);
  });

  test("which stands alone: nothing to import, nothing to carry with it", () => {
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  test("a contract that reads, with the identities the forge signs", () => {
    const text = files.get("contract.json");
    const read = readContract(typeof text === "string" ? text : "");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(identities(read.contract).sort()).toEqual(["admin", "anon", "user"]);
    // Nothing is open to the anonymous but reading.
    expect(
      table(read.contract)
        .filter((c) => c.as === "anon" && c.answer !== "no")
        .map((c) => `${c.resource}.${c.verb}`)
        .sort(),
    ).toEqual(["note.list", "note.read"]);
  });

  test("the builder is briefed on the policy in force, and on the wall", () => {
    const lines = policyLines({
      identities: ["anon", "user", "admin"],
      lines: [
        "note: create user · read anon · update author · delete author · list anon",
      ],
    }).join("\n");
    expect(lines).toContain("who may do what — is decided");
    expect(lines).toContain("- note: create user · read anon");
    expect(lines).toContain("Identities the forge signs: anon, user, admin");
    expect(lines).toContain("is a wall");
    expect(lines).toContain("ask `permit`");
    const broken = policyLines({
      identities: [],
      lines: [],
      problems: ["note.create needs `ghost`, which is not declared"],
    }).join("\n");
    expect(broken).toContain("does not read");
    expect(broken).toContain("- note.create needs `ghost`");
  });

  test("the reviewer's checklist has the contract on it when the app has one", () => {
    const base = {
      agent: { user: { username: "rev", displayName: "" } },
      repo: { ownerName: "alice", name: "notes", autonomyDirection: "" },
      issue: { number: 7, title: "Widen", body: "" },
      branch: "rev/7",
      forgeUrl: "http://forge.test",
      isApp: true,
      resuming: false,
      reason: "review" as const,
      comments: [],
      reviews: [],
      reviewDiff: "",
    };
    const withPolicy = taskPrompt({
      ...base,
      policy: { identities: ["anon"], lines: ["note: create user"] },
    } as unknown as Parameters<typeof taskPrompt>[0]);
    expect(withPolicy).toContain("- The contract: every action asks `permit`");
    const without = taskPrompt(
      base as unknown as Parameters<typeof taskPrompt>[0],
    );
    expect(without).not.toContain("The contract:");
  });
});
