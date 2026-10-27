/**
 * Is it so: knock on every door of a running app as every identity, and
 * compare the answer with the contract's cell.
 *
 * The table (`audit.ts`) is read from git through the app's own evaluator;
 * the probe trusts neither and asks the process. A resource that names its
 * JSON API (`"api": "/api/notes"`) has five doors by convention — list is
 * `GET api`, create `POST api`, read/update/delete `GET/PATCH/DELETE
 * api/<id>` — and a door is a permission check that runs before anything
 * else, so the only answers that mean "refused at the door" are 401 and
 * 403. Everything else, a 400 for an empty body included, means the door
 * opened. The probe writes nothing on purpose: `{}` is a body no resource
 * accepts, and `0` an id no row has.
 *
 * An `own` cell needs a row that names the actor, which the probe cannot
 * make. It is probed halfway — the floor refused, everything above the row
 * role admitted — and says so; the row role itself is the app's own
 * `contract.test.ts`, which has rows.
 */

import { identityHeaders } from "../apps/proxy.ts";
import type { AppsRuntime } from "../apps/runtime.ts";
import type { AppRecord } from "../core/apps.ts";
import type { Repo } from "../core/repos.ts";
import type { Cell, Contract, Verb } from "./can.ts";
import type { Standing } from "./audit.ts";

/** The probe's identities: what the forge can sign an app a visitor as. */
export type Identity = "anon" | "user" | "admin";
export const IDENTITIES: readonly Identity[] = ["anon", "user", "admin"];

export interface Knock {
  readonly resource: string;
  readonly verb: Verb;
  readonly as: Identity;
  /** The door asked, `METHOD path`, when one was; older rows have none. */
  readonly door?: string;
  /** What the table says. */
  readonly cell: Cell["answer"];
  /** What the door said, or why it was not asked. */
  readonly result:
    | { readonly kind: "admitted"; readonly status: number }
    | { readonly kind: "refused"; readonly status: number }
    | { readonly kind: "no_door"; readonly status: number }
    | { readonly kind: "unprobed"; readonly why: string }
    | { readonly kind: "error"; readonly message: string };
  /** The verdict for this knock: does the door agree with the table? */
  readonly verdict: "ok" | "mismatch" | "unprobed";
}

export interface Probed {
  readonly repo: Repo;
  readonly commitOid: string;
  readonly at: string;
  readonly verdict: "ok" | "mismatch" | "unprobed" | "down";
  readonly knocks: readonly Knock[];
  /** The mismatches, each as one sentence. */
  readonly said: readonly string[];
}

const DOOR: Readonly<Record<Verb, { method: string; row: boolean }>> = {
  list: { method: "GET", row: false },
  create: { method: "POST", row: false },
  read: { method: "GET", row: true },
  update: { method: "PATCH", row: true },
  delete: { method: "DELETE", row: true },
};

/** The `api` path a resource declares, checked when the contract was read. */
export const apiOf = (
  contract: Contract,
  resource: string,
): string | undefined => contract.resources[resource]?.api;

/**
 * What the table expects a door to do for `as`: `yes` and `no` are exact.
 * An `own` cell is answered by a row that names the actor, and the probe
 * has no row, so it is not asked; the app's own `contract.test.ts` has rows.
 */
export const expected = (cell: Cell): "admit" | "refuse" | "unknown" =>
  cell.answer === "yes" ? "admit" : cell.answer === "no" ? "refuse" : "unknown";

export interface ProbeInput {
  readonly runtime: AppsRuntime;
  readonly dataDir: string;
  readonly record: AppRecord;
  readonly repo: Repo;
  readonly standing: Standing;
  /** The account the probe knocks as when signed in. */
  readonly who: { readonly id: string; readonly name: string };
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export async function probe(input: ProbeInput): Promise<Probed | undefined> {
  if (input.standing.kind !== "sound") return undefined;
  const status = input.runtime.envStatus(input.record, "production");
  const at = new Date().toISOString();
  if (
    status === undefined ||
    status.port === undefined ||
    status.state !== "running"
  )
    return {
      repo: input.repo,
      commitOid: status?.commitOid ?? "",
      at,
      verdict: "down",
      knocks: [],
      said: [],
    };
  const { contract, cells } = input.standing;
  const doFetch = input.fetch ?? fetch;
  const base = `http://127.0.0.1:${status.port}`;
  const knocks: Knock[] = [];
  for (const cell of cells) {
    if (!IDENTITIES.includes(cell.as as Identity)) continue;
    const as = cell.as as Identity;
    const api = apiOf(contract, cell.resource);
    const want = expected(cell);
    if (api === undefined || want === "unknown") {
      knocks.push({
        resource: cell.resource,
        verb: cell.verb,
        as,
        cell: cell.answer,
        result: {
          kind: "unprobed",
          why:
            api === undefined
              ? "the resource names no api"
              : "needs a row that names the actor",
        },
        verdict: "unprobed",
      });
      continue;
    }
    const door = DOOR[cell.verb];
    const path = `${api}${door.row ? "/0" : ""}`;
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(door.method === "GET" ? {} : { "content-type": "application/json" }),
      ...(as === "anon"
        ? {}
        : identityHeaders(input.dataDir, input.record.id, {
            who: { id: input.who.id, name: input.who.name, role: as },
            expiresMs: Date.now() + 60_000,
          })),
    };
    let result: Knock["result"];
    try {
      const res = await doFetch(url, {
        method: door.method,
        headers,
        body: door.method === "GET" ? null : "{}",
        signal: AbortSignal.timeout(input.timeoutMs ?? 5_000),
        redirect: "manual",
      });
      await res.body?.cancel();
      // A door refuses with 401 or 403 before it looks for a row, so a 404
      // in JSON is the action saying "no such row": past the door. A 404
      // that is not JSON is the router: there is no such door.
      const isJson = (res.headers.get("content-type") ?? "").includes("json");
      result =
        res.status === 401 || res.status === 403
          ? { kind: "refused", status: res.status }
          : res.status === 404 && !isJson
            ? { kind: "no_door", status: res.status }
            : { kind: "admitted", status: res.status };
    } catch (error) {
      result = { kind: "error", message: String(error) };
    }
    const verdict: Knock["verdict"] =
      result.kind === "error" || result.kind === "no_door"
        ? "unprobed"
        : (result.kind === "admitted") === (want === "admit")
          ? "ok"
          : "mismatch";
    knocks.push({
      resource: cell.resource,
      verb: cell.verb,
      as,
      door: `${door.method} ${path}`,
      cell: cell.answer,
      result,
      verdict,
    });
  }
  const said = knocks
    .filter((k) => k.verdict === "mismatch")
    .map(
      (k) =>
        `${k.resource}.${k.verb} as ${k.as}: the table says ${k.cell}, the app said ${
          k.result.kind === "admitted" || k.result.kind === "refused"
            ? k.result.status
            : "?"
        }`,
    );
  const verdict: Probed["verdict"] =
    said.length > 0
      ? "mismatch"
      : knocks.some((k) => k.verdict === "ok")
        ? "ok"
        : "unprobed";
  return {
    repo: input.repo,
    commitOid: status.commitOid,
    at,
    verdict,
    knocks,
    said,
  };
}
