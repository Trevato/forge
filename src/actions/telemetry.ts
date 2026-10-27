/**
 * Who reads the forge's telemetry (#1789). The owner — a forge admin who is
 * a person — always may. A named agent may only while the owner has granted
 * it `telemetry:read`, and only the owner grants or revokes: an agent that
 * could widen its own reading would be the crew deciding what it sees.
 * Every grant leaves an event; every read an agent makes is kept.
 */
import type { App } from "../app.ts";
import { grant, hasGrant, logRead, revoke } from "../core/telemetry.ts";
import { getUserByName, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type Reader = { kind: "owner" } | { kind: "agent"; spend?: boolean };

/** Whether `user` reads telemetry, and as what (the agent's view has private repositories cut out). */
export function telemetryReader(app: App, user: User | undefined): Reader | undefined {
  if (!user) return undefined;
  if (user.kind === "agent") return hasGrant(app.db, user.id) ? { kind: "agent", spend: true } : undefined;
  return user.isAdmin ? { kind: "owner" } : undefined;
}

/** Record an agent's read; the owner's own reading is not an agent's to audit. */
export function noteRead(app: App, user: User, reader: Reader, what: string): void {
  if (reader.kind === "agent") logRead(app.db, user.id, what);
}

export function setTelemetryGrant(
  app: App,
  actor: User | undefined,
  username: string,
  on: boolean,
): Result<{ username: string; on: boolean }, "not_found" | "not_an_agent"> {
  if (!actor || !actor.isAdmin || actor.kind === "agent") return err("not_found");
  const target = getUserByName(app.db, username);
  if (!target) return err("not_found");
  if (target.kind !== "agent") return err("not_an_agent");
  const was = hasGrant(app.db, target.id);
  if (on) grant(app.db, target.id, actor.id);
  else revoke(app.db, target.id);
  if (was !== on)
    app.bus.append({
      kind: on ? "telemetry.granted" : "telemetry.revoked",
      actorId: actor.id,
      payload: { agent: target.username },
    });
  return ok({ username: target.username, on });
}
