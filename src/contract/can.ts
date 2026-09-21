/**
 * Who may do what, decided from a table.
 *
 * An app's permissions are data: `contract.json` declares its roles and, for
 * every resource, the least role each of the five verbs needs. This file is
 * the whole evaluator. It is self-contained on purpose — no imports, no
 * classes, nothing but values and total functions — because it is carried
 * verbatim into every app the forge scaffolds, read by the forge to audit an
 * app without running it, and meant to be ported line for line.
 *
 * Roles form an order, not a list. `above` names the roles directly below a
 * role, and a role may do whatever anything below it may. How a role is
 * *held* is a value too: by everyone, by an identity the forge signed, or by
 * the row naming the actor. Adding a role adds a line to the contract and
 * nothing here: the evaluator is the same size for three roles or three
 * hundred.
 *
 * Everything fails closed: an undeclared resource, verb or role is "no".
 */

export type Verb = "create" | "read" | "update" | "delete" | "list";
export const VERBS: readonly Verb[] = [
  "create",
  "read",
  "update",
  "delete",
  "list",
];

/** The cell that lets nobody in. Not a role: nothing can be above it. */
export const NOBODY = "nobody";

/** How a role is held. */
export type Held =
  /** By anyone at all, signed in or not. A contract has exactly one. */
  | { readonly by: "everyone" }
  /** By an identity the forge signed as carrying `role`. */
  | { readonly by: "identity"; readonly role: string }
  /** By the row: its `column` holds the actor's id. */
  | { readonly by: "row"; readonly column: string };

export interface Role {
  /** The roles directly below this one. */
  readonly above: readonly string[];
  readonly held: Held;
}

export interface Resource {
  /** The least role each verb needs, or `nobody`. */
  readonly can: Readonly<Record<Verb, string>>;
  /**
   * The collection path of this resource's JSON API, when it has one: five
   * doors follow by convention (`GET api` lists, `POST api` creates,
   * `GET`/`PATCH`/`DELETE api/<id>` read, update and delete one), which is
   * how the forge can knock on a running app and compare with the table.
   */
  readonly api?: string;
}

export interface Contract {
  readonly roles: Readonly<Record<string, Role>>;
  readonly resources: Readonly<Record<string, Resource>>;
}

/**
 * Who is asking: an id when signed in, and the roles the forge signed. An
 * empty id is nobody: it never names a row, however a row was filled.
 */
export interface Actor {
  readonly id: string | null;
  readonly roles: readonly string[];
}

/**
 * The answer. `where` is for a verb with no row in hand (`list`): the actor
 * may have exactly the rows whose named columns hold their id.
 */
export type Decision = "yes" | "no" | { readonly where: readonly string[] };

/**
 * A declared thing by name, and nothing else: `constructor` and its kin are
 * on every object and are not roles.
 */
function own<T>(of: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(of, name) ? of[name] : undefined;
}

/** Whether role `low` is `high` or below it. */
export function atOrBelow(
  contract: Contract,
  low: string,
  high: string,
): boolean {
  const seen = new Set<string>();
  const walk = [high];
  while (walk.length > 0) {
    const name = walk.pop()!;
    if (name === low) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const below of own(contract.roles, name)?.above ?? [])
      walk.push(below);
  }
  return false;
}

export function decide(
  contract: Contract,
  resource: string,
  verb: Verb,
  actor: Actor,
  row?: Readonly<Record<string, unknown>>,
): Decision {
  const can = own(contract.resources, resource)?.can;
  const need = can === undefined ? undefined : own(can, verb);
  if (need === undefined || own(contract.roles, need) === undefined)
    return "no";
  const where: string[] = [];
  for (const name of Object.keys(contract.roles)) {
    if (!atOrBelow(contract, need, name)) continue;
    const held = contract.roles[name]!.held;
    if (held.by === "everyone") return "yes";
    if (held.by === "identity") {
      if (actor.roles.includes(held.role)) return "yes";
      continue;
    }
    if (actor.id === null || actor.id === "") continue;
    if (row !== undefined) {
      if (own(row, held.column) === actor.id) return "yes";
    } else if (verb === "list" && !where.includes(held.column))
      where.push(held.column);
  }
  return where.length > 0 ? { where } : "no";
}

/** `decide`, for the doors that only need yes or no about one row. */
export const may = (
  contract: Contract,
  resource: string,
  verb: Verb,
  actor: Actor,
  row?: Readonly<Record<string, unknown>>,
): boolean => decide(contract, resource, verb, actor, row) === "yes";

// ---- reading a contract: strict, total, every problem named ----

export type Read =
  | { readonly ok: true; readonly contract: Contract }
  | { readonly ok: false; readonly problems: readonly string[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const NAME = /^[a-z][a-z0-9_]{0,39}$/;
/** An absolute path of plain segments: no query, no dot-segments, no host. */
const API_PATH = /^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/;

function readHeld(v: unknown): Held | undefined {
  if (!isObject(v)) return undefined;
  if (v["by"] === "everyone") return { by: "everyone" };
  if (v["by"] === "identity" && typeof v["role"] === "string")
    return NAME.test(v["role"])
      ? { by: "identity", role: v["role"] }
      : undefined;
  if (v["by"] === "row" && typeof v["column"] === "string")
    return NAME.test(v["column"])
      ? { by: "row", column: v["column"] }
      : undefined;
  return undefined;
}

/** Parse and check a contract from untrusted JSON text. */
export function readContract(text: string): Read {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problems: ["contract.json is not JSON"] };
  }
  if (!isObject(raw) || !isObject(raw["roles"]) || !isObject(raw["resources"]))
    return {
      ok: false,
      problems: ["a contract is an object with `roles` and `resources`"],
    };
  const problems: string[] = [];
  const roles: Record<string, Role> = {};
  for (const [name, v] of Object.entries(raw["roles"])) {
    const held = isObject(v) ? readHeld(v["held"]) : undefined;
    const above = isObject(v) ? (v["above"] ?? []) : undefined;
    if (!NAME.test(name) || name === NOBODY)
      problems.push(`role \`${name}\`: not a usable name`);
    else if (
      held === undefined ||
      !Array.isArray(above) ||
      !above.every((a): a is string => typeof a === "string")
    )
      problems.push(`role \`${name}\`: needs \`held\` and a list \`above\``);
    else roles[name] = { above, held };
  }
  const resources: Record<string, Resource> = {};
  for (const [name, v] of Object.entries(raw["resources"])) {
    const can = isObject(v) && isObject(v["can"]) ? v["can"] : undefined;
    if (!NAME.test(name) || !isObject(v) || can === undefined) {
      problems.push(`resource \`${name}\`: needs a name and a \`can\` table`);
      continue;
    }
    const cells = {} as Record<Verb, string>;
    for (const verb of VERBS) {
      const cell = can[verb];
      if (typeof cell === "string") cells[verb] = cell;
      else
        problems.push(`${name}.${verb}: every verb names a role or \`nobody\``);
    }
    for (const extra of Object.keys(can))
      if (!VERBS.includes(extra as Verb))
        problems.push(`${name}.${extra}: not one of ${VERBS.join(", ")}`);
    const api = v["api"];
    if (api !== undefined && (typeof api !== "string" || !API_PATH.test(api)))
      problems.push(
        `resource \`${name}\`: \`api\` is an absolute path of plain segments, like /api/${name}s`,
      );
    resources[name] =
      typeof api === "string" && API_PATH.test(api)
        ? { can: cells, api }
        : { can: cells };
  }
  const contract: Contract = { roles, resources };
  problems.push(...check(contract));
  return problems.length > 0 ? { ok: false, problems } : { ok: true, contract };
}

/** What is wrong with a contract that parsed. Empty means sound. */
export function check(contract: Contract): string[] {
  const problems: string[] = [];
  const names = Object.keys(contract.roles);
  const floors = names.filter((n) => contract.roles[n]!.held.by === "everyone");
  if (floors.length !== 1)
    problems.push("exactly one role is held by everyone: the floor");
  // Two roles held by one identity are one role with two names: the table
  // would show two columns that are the same person.
  const byIdentity = new Map<string, string>();
  for (const name of names) {
    const held = contract.roles[name]!.held;
    if (held.by !== "identity") continue;
    const other = byIdentity.get(held.role);
    if (other !== undefined)
      problems.push(
        `roles \`${other}\` and \`${name}\` are both held by the identity \`${held.role}\``,
      );
    else byIdentity.set(held.role, name);
  }
  for (const name of names) {
    for (const below of contract.roles[name]!.above) {
      if (own(contract.roles, below) === undefined)
        problems.push(
          `role \`${name}\` is above \`${below}\`, which is not declared`,
        );
      else if (atOrBelow(contract, name, below))
        problems.push(`role \`${name}\` is both above and below \`${below}\``);
    }
    const floor = floors[0];
    if (floor !== undefined && !atOrBelow(contract, floor, name))
      problems.push(
        `role \`${name}\` does not stand on the floor \`${floor}\``,
      );
  }
  for (const [resource, { can }] of Object.entries(contract.resources))
    for (const verb of VERBS) {
      const need = can[verb];
      if (need === NOBODY) continue;
      const role = own(contract.roles, need);
      if (role === undefined)
        problems.push(
          `${resource}.${verb} needs \`${need}\`, which is not declared`,
        );
      else if (verb === "create" && role.held.by === "row")
        problems.push(
          `${resource}.create needs \`${need}\`, which a row holds: there is no row yet`,
        );
    }
  return problems;
}

// ---- the table: the contract as the audit reads it ----

export interface Cell {
  readonly resource: string;
  readonly verb: Verb;
  /** Who is asking: the floor, or a role an identity carries. */
  readonly as: string;
  /** `own`: only the rows that name the actor. */
  readonly answer: "yes" | "no" | "own";
}

/**
 * Who someone can be. A role a row holds is not one of them: it is what an
 * actor is *to a row*, and shows in the table as `own`.
 */
export const identities = (contract: Contract): string[] =>
  Object.keys(contract.roles).filter(
    (name) => contract.roles[name]!.held.by !== "row",
  );

/**
 * The facts that make someone `identity` and nothing more: the forge acts as
 * each identity this way, for the table here and for the audit's probes.
 * `mine` is a row that names the actor wherever a row can; `theirs` names
 * someone else. Anything that is not an identity acts as a stranger.
 */
export function actingAs(
  contract: Contract,
  identity: string,
): {
  actor: Actor;
  mine: Record<string, unknown>;
  theirs: Record<string, unknown>;
} {
  const held = own(contract.roles, identity)?.held;
  const actor: Actor =
    held?.by === "identity"
      ? { id: "the-actor", roles: [held.role] }
      : { id: null, roles: [] };
  const mine: Record<string, unknown> = {};
  const theirs: Record<string, unknown> = {};
  for (const role of Object.values(contract.roles))
    if (role.held.by === "row") {
      mine[role.held.column] = "the-actor";
      theirs[role.held.column] = "someone-else";
    }
  return { actor, mine, theirs };
}

/** Every resource, verb and identity, answered. The policy, as a table. */
export function table(contract: Contract): Cell[] {
  const out: Cell[] = [];
  for (const resource of Object.keys(contract.resources))
    for (const verb of VERBS)
      for (const as of identities(contract)) {
        const { actor, mine, theirs } = actingAs(contract, as);
        const rowless = verb === "create" || verb === "list";
        const any = decide(
          contract,
          resource,
          verb,
          actor,
          rowless ? undefined : theirs,
        );
        const owned = rowless
          ? any
          : decide(contract, resource, verb, actor, mine);
        out.push({
          resource,
          verb,
          as,
          answer: any === "yes" ? "yes" : owned === "no" ? "no" : "own",
        });
      }
  return out;
}
