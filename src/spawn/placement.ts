/**
 * Placement: where a child forge's body runs, behind one seam. Spawn hands a
 * validated SpawnPlan to a Placement and gets back where the child lives;
 * it never learns whether that is inside this process or on someone else's
 * machine. `hosted` is the only implementation today: the child is an app
 * inside the parent, reached by a single-label host
 * (`<name>--<parentHost>`), with no SSH and one agent at a time. An
 * external placement (Cloudflare, Fly, metal — spike #339) plugs in by
 * implementing the same interface.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import type { SpawnPlan } from "./plan.ts";

/**
 * Whether a body that runs on a cloud is configured behind this seam. None
 * is yet (spike #339), so the placement policy (`core/placement_policy.ts`)
 * answers `owned` every time and a burst queues — the board says so.
 */
export const CLOUD_BODY_CONFIGURED = false;

/**
 * What the policy's choice hands the body that carries it out: owned metal
 * names the node label that selects owned nodes (a setting,
 * `getOwnedNodeLabel`, `plat.sh/site=vxrail` by default), which a body that
 * schedules onto nodes uses as its selector; cloud names nothing more.
 */
export type BodyTarget =
  | { readonly where: "owned"; readonly nodeLabel: string }
  | { readonly where: "cloud" };

export function bodyTarget(where: "owned" | "cloud", ownedNodeLabel: string): BodyTarget {
  return where === "owned" ? { where, nodeLabel: ownedNodeLabel } : { where };
}

/** Where a child runs: inside the parent's process, or as a process in its own cell. */
export type PlacementKind = "hosted" | "cell";

export interface Placed {
  readonly url: string;
  readonly bodyId: string;
  /** Absent reads as hosted. */
  readonly kind?: PlacementKind;
}

export type PlacementRefusal = { readonly reason: "children" | "depth" | "exists" | "quota" | "unknown"; readonly message: string };

export interface Placement {
  place(plan: SpawnPlan): Promise<Result<Placed, PlacementRefusal>>;
  /** Idempotent: retiring a body that is gone is a success. */
  retire(bodyId: string): Promise<Result<void, PlacementRefusal>>;
  /** Why no child fits here now (the depth or the count), before anyone fills in a form. */
  room?(): PlacementRefusal | undefined;
}

/** What the hosted placement remembers about each child it holds. */
export interface Body {
  readonly bodyId: string;
  readonly name: string;
  readonly url: string;
  readonly depth: number;
  /** A hosted child runs one agent at a time and offers no SSH. */
  readonly agents: 1;
  readonly ssh: false;
}

export interface BodyStore {
  list(): readonly Body[];
  add(body: Body): void;
  remove(bodyId: string): void;
}

export function memoryBodies(): BodyStore {
  const bodies = new Map<string, Body>();
  return {
    list: () => [...bodies.values()],
    add: (b) => void bodies.set(b.bodyId, b),
    remove: (id) => void bodies.delete(id),
  };
}

// How many forges this one sends is the `children.max` capacity setting
// (src/core/capacity.ts), sized by the node and read live; this constant is
// only the ceiling for a placement built without one.
export const MAX_CHILDREN = 1_000;
export const MAX_DEPTH = 2;

/**
 * Host suffix a hosted child attaches to: `--forge.open-platform.sh` when
 * the parent is `forge.open-platform.sh`. One label under the platform
 * apex (same shape as apps), not a nested subdomain the wildcard misses.
 */
export function childHostSuffix(parentHost: string): string {
  const host = parentHost.toLowerCase().replace(/:\d+$/, "");
  return `--${host}`;
}

/**
 * The parent forge's public origin, which its children's addresses derive
 * from: its canonical `url` when it has one (the address people reach it at
 * through a proxy), otherwise the plain HTTP host and port it serves on, as
 * `main.ts` names itself.
 */
export function parentOrigin(config: { url?: string; host?: string; port?: number }): string {
  if (config.url) return new URL(config.url).origin;
  const port = config.port ?? 3000;
  return `http://${config.host ?? "localhost"}${port ? `:${port}` : ""}`;
}

/**
 * Public origin of a hosted child: `<name>--<parent hostname>`, on the
 * parent's scheme and port, so a child of `http://forge.lan:8080` is
 * `http://<name>--forge.lan:8080`. `parent` is the parent's origin
 * (`parentOrigin`); a bare host is the hosted platform's https, as before.
 */
export function childPublicUrl(name: string, parent: string): string {
  const at = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(parent) ? parent : `https://${parent}`);
  return `${at.protocol}//${name}${childHostSuffix(at.hostname)}${at.port ? `:${at.port}` : ""}`;
}

export const CHILD_NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;

/**
 * The child name a `Host` names under this parent's suffix, or undefined
 * when the host is not a hosted-child address.
 */
export function parseHostedChildName(
  hostHeader: string,
  parentHost: string,
): string | undefined {
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,252})?$/i.test(host)) return undefined;
  const suffix = childHostSuffix(parentHost);
  if (!host.endsWith(suffix)) return undefined;
  const name = host.slice(0, -suffix.length);
  return CHILD_NAME.test(name) ? name : undefined;
}

/** One DNS label: `<app>--<child>` may be as long as a label allows. */
const CHILD_APP_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The `<app>--<child>` label a `Host` carries under this parent's suffix,
 * bounded by the DNS label and not by a child's name alone.
 */
export function parseHostedChildAppLabel(
  hostHeader: string,
  parentHost: string,
): string | undefined {
  const host = hostHeader.toLowerCase().replace(/:\d+$/, "");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,252})?$/i.test(host)) return undefined;
  const suffix = childHostSuffix(parentHost);
  if (!host.endsWith(suffix)) return undefined;
  const label = host.slice(0, -suffix.length);
  return CHILD_APP_LABEL.test(label) ? label : undefined;
}

export interface HostedOptions {
  /**
   * The parent forge's public origin (`parentOrigin`), e.g.
   * "https://forge.example.com"; a bare host is taken as https.
   */
  readonly host: string;
  /** How deep this forge itself is: 0 for a root forge. */
  readonly depth?: number;
  /** A number, or a function read on every check so a setting applies live. */
  readonly maxChildren?: number | (() => number);
  readonly maxDepth?: number;
  readonly store?: BodyStore;
  /** Injectable so tests need no randomness. */
  readonly newId?: () => string;
  /** What `place` says it did; hosted unless the caller is a cell placement. */
  readonly kind?: PlacementKind;
}

const refuse = (reason: PlacementRefusal["reason"], message: string) =>
  err<PlacementRefusal>({ reason, message });

export function hostedPlacement(opts: HostedOptions): Placement {
  const store = opts.store ?? memoryBodies();
  const depth = opts.depth ?? 0;
  const limit = opts.maxChildren ?? MAX_CHILDREN;
  const maxChildren = () => (typeof limit === "function" ? limit() : limit);
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const newId = opts.newId ?? (() => `hosted-${crypto.randomUUID()}`);

  const full = (): PlacementRefusal | undefined => {
    // A child lives one level below this forge; it may not exceed the limit.
    if (depth + 1 > maxDepth)
      return { reason: "depth", message: `forges nest at most ${maxDepth} deep; this one is already at ${depth}` };
    const max = maxChildren();
    const held = store.list().length;
    if (held >= max)
      return {
        reason: "children",
        message: `${held} of ${max} forges sent on this node — retire one, or raise the room in settings`,
      };
    return undefined;
  };

  return {
    room: full,
    async place(plan) {
      const no = full();
      if (no) return err(no);
      const held = store.list();
      if (held.some((b) => b.name === plan.name)) {
        return refuse("exists", `a child named ${plan.name} already exists`);
      }
      const url = childPublicUrl(plan.name, opts.host);
      const bodyId = newId();
      store.add({ bodyId, name: plan.name, url, depth: depth + 1, agents: 1, ssh: false });
      return ok({ url, bodyId, ...(opts.kind === undefined ? {} : { kind: opts.kind }) });
    },
    async retire(bodyId) {
      store.remove(bodyId);
      return ok();
    },
  };
}

/**
 * Two placements behind one: `preferred` where `holds()` says this host can,
 * `fallback` where it cannot. A body is retired by whichever made it, told
 * by its id's prefix. Capacity is the fallback's (they share one store).
 */
export function fallbackPlacement(
  preferred: Placement,
  fallback: Placement,
  holds: () => Promise<boolean>,
  owns: (bodyId: string) => boolean,
): Placement {
  return {
    ...(fallback.room === undefined ? {} : { room: fallback.room }),
    async place(plan) {
      return (await holds()) ? preferred.place(plan) : fallback.place(plan);
    },
    retire: (bodyId) => (owns(bodyId) ? preferred : fallback).retire(bodyId),
  };
}
