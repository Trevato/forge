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

export interface Placed {
  readonly url: string;
  readonly bodyId: string;
}

export type PlacementRefusal = { readonly reason: "children" | "depth" | "exists" | "unknown"; readonly message: string };

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

// The owner decides how many forges this one sends (2026-10-15: "i should have
// unlimited forges"). This constant is the ceiling until #1454 makes it a
// capacity setting sized by the node; the hosted placement still refuses
// when the node has no room.
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

/** Public origin of a hosted child, derived from name + parent host. */
export function childPublicUrl(name: string, parentHost: string): string {
  return `https://${name}${childHostSuffix(parentHost)}`;
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
  /** The parent forge's public host, e.g. "forge.example.com". */
  readonly host: string;
  /** How deep this forge itself is: 0 for a root forge. */
  readonly depth?: number;
  readonly maxChildren?: number;
  readonly maxDepth?: number;
  readonly store?: BodyStore;
  /** Injectable so tests need no randomness. */
  readonly newId?: () => string;
}

const refuse = (reason: PlacementRefusal["reason"], message: string) =>
  err<PlacementRefusal>({ reason, message });

export function hostedPlacement(opts: HostedOptions): Placement {
  const store = opts.store ?? memoryBodies();
  const depth = opts.depth ?? 0;
  const maxChildren = opts.maxChildren ?? MAX_CHILDREN;
  const maxDepth = opts.maxDepth ?? MAX_DEPTH;
  const newId = opts.newId ?? (() => `hosted-${crypto.randomUUID()}`);

  const full = (): PlacementRefusal | undefined => {
    // A child lives one level below this forge; it may not exceed the limit.
    if (depth + 1 > maxDepth)
      return { reason: "depth", message: `forges nest at most ${maxDepth} deep; this one is already at ${depth}` };
    if (store.list().length >= maxChildren)
      return { reason: "children", message: `a forge holds at most ${maxChildren} hosted children` };
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
      return ok({ url, bodyId });
    },
    async retire(bodyId) {
      store.remove(bodyId);
      return ok();
    },
  };
}
