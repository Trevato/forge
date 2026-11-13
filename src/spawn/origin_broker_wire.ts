/**
 * What the two ends of the brokered connect share and nothing else: the paths,
 * the shape of an offer, and the signature a child puts on a start and on a
 * call. A leaf, so the child's side (`origins/broker.ts`) reads it without
 * loading the parent's.
 */

import { createHmac } from "node:crypto";

/** Where a child's browser comes back to: the one path, never one a request names. */
export const BROKER_CALLBACK = "/settings/origins/broker/callback";
/** Where the child sends the browser first, on the parent. */
export const BROKER_START = "/broker/origins/start";
/** Where a child calls the parent, signed: on the beat door and on the public API. */
export const BROKER_CALL = "/api/v1/broker/origins";

/** What this forge can broker for a child: which, and in the words a button wears. Never a secret. */
export interface BrokerOffer {
  readonly host: string;
  readonly kind: "github" | "forgejo";
  /** What a button names: `GitHub`, or the instance's host. */
  readonly name: string;
}

/** The canonical text of a start: every part the parent acts on, in order. */
export const startText = (p: {
  child: string;
  host: string;
  state: string;
  challenge: string;
  path: string;
  at: number;
}): string =>
  ["start", p.child, p.host, p.state, p.challenge, p.path, String(p.at)].join(
    "\n",
  );

export const signWith = (key: string, text: string): string =>
  createHmac("sha256", key).update(text).digest("hex");

/** The words a child can show for each way a brokered sign-in ends without a code. */
export type BrokerFailure =
  | "denied"
  | "expired"
  | "browser"
  | "exchange"
  | "refused"
  | "failed";

