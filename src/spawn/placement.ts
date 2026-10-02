/**
 * Placement: where a child forge's body runs, behind one seam. Spawn hands a
 * validated SpawnPlan to a Placement and gets back where the child lives;
 * it never learns whether that is inside this process or on someone else's
 * machine. `hosted` is the only implementation today: the child is an app
 * inside the parent, reached by a subdomain, with no SSH and one agent at a
 * time. An external placement (Cloudflare, Fly, metal — spike #339) plugs
 * in by implementing the same interface.
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

export const MAX_CHILDREN = 5;
export const MAX_DEPTH = 2;

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

  return {
    async place(plan) {
      // A child lives one level below this forge; it may not exceed the limit.
      if (depth + 1 > maxDepth) {
        return refuse("depth", `forges nest at most ${maxDepth} deep; this one is already at ${depth}`);
      }
      const held = store.list();
      if (held.length >= maxChildren) {
        return refuse("children", `a forge holds at most ${maxChildren} hosted children`);
      }
      if (held.some((b) => b.name === plan.name)) {
        return refuse("exists", `a child named ${plan.name} already exists`);
      }
      const url = `https://${plan.name}.${opts.host}`;
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
