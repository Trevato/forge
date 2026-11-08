/**
 * The `/settings…` routes live in `src/http/settings_routes.ts` (#8309).
 * The studio's router holds exactly what `settingsRoutes` registers, as one
 * block in the same order; every settings path still reaches its own route
 * (nothing registered above the block captures it); and the routes recorded
 * when they moved out of `server.ts` that are still there keep that order.
 */
import { expect, test } from "bun:test";
import type { Handler } from "../src/http/context.ts";
import { Router } from "../src/http/router.ts";
import { buildRouter } from "../src/http/server.ts";
import { settingsRoutes } from "../src/http/settings_routes.ts";

const isSettings = (pattern: string) => pattern === "/settings" || pattern.startsWith("/settings/");
const key = (r: { method: string; pattern: string }) => `${r.method} ${r.pattern}`;

/** The table as it stood in server.ts when it moved, in registration order. */
const RECORDED = `
GET /settings/telemetry
POST /settings/telemetry
GET /settings
POST /settings
POST /settings/notify
POST /settings/edge/link
POST /settings/edge/unlink
POST /settings/parent/link
POST /settings/parent/unlink
POST /settings/email/verify
GET /settings/password
POST /settings/password
POST /settings/everyday
POST /settings/everyday/options
POST /settings/everyday/switch
POST /settings/everyday/keep
GET /settings/tokens
POST /settings/tokens
POST /settings/tokens/:id/delete
POST /settings/sessions/:id/delete
GET /settings/confirms
POST /settings/confirms/:id
GET /settings/passkeys
POST /settings/passkeys/options
POST /settings/passkeys
POST /settings/passkeys/:id/delete
GET /settings/subscriptions
POST /settings/subscriptions
POST /settings/subscriptions/:id/delete
POST /settings/subscriptions/:id/wake
POST /settings/subscriptions/:id/headroom
POST /settings/subscriptions/:id/budget
GET /settings/secrets
POST /settings/secrets
POST /settings/secrets/delete
GET /settings/cloud
POST /settings/cloud
POST /settings/cloud/verify
POST /settings/cloud/write
POST /settings/cloud/audit
GET /settings/cloud/audit
POST /settings/cloud/rotate
POST /settings/cloud/rename
POST /settings/cloud/remove
GET /settings/access
GET /settings/resilience
GET /settings/capacity
POST /settings/capacity
GET /settings/flags
POST /settings/flags
GET /settings/usage
GET /settings/spend
GET /settings/traffic
GET /settings/security
POST /settings/security/shield
GET /settings/backups
GET /settings/backups/live
POST /settings/backups/now
POST /settings/backups/drill
POST /settings/backups/destination
POST /settings/backups/test
POST /settings/backups/clear
POST /settings/backups/mirror
POST /settings/backups/mirror/clear
POST /settings/backups/mirror/now
GET /settings/accounts
GET /settings/people
POST /settings/people/:username/role
GET /settings/model
POST /settings/model
POST /settings/accounts/:username/model
POST /settings/accounts/:username/ceiling
GET /settings/accounts/:username
POST /settings/accounts/:username/tokens/:id/delete
POST /settings/accounts/:username/sessions/:id/delete
POST /settings/accounts/:username/suspend
POST /settings/accounts/:username/unsuspend
POST /settings/accounts/:username/remove
GET /settings/accounts/:username/retire
POST /settings/accounts/:username/retire
POST /settings/accounts/:username/verify
GET /settings/crew
POST /settings/crew
GET /settings/teams
GET /settings/teams/stream
POST /settings/teams/:slug
GET /settings/crew/:username
POST /settings/crew/:username
POST /settings/crew/:username/delete
POST /settings/crew/model-review/:id/take
POST /settings/crew/model-review/:id/decline
GET /settings/origins/callback
GET /settings/origins
POST /settings/origins/token
POST /settings/origins/oauth
POST /settings/origins/apps
POST /settings/origins/trusted-hosts
POST /settings/origins/apps/:id/delete
GET /settings/origins/flows/:id
POST /settings/origins/flows/:id/poll
GET /settings/origins/:id/repos
POST /settings/origins/:id/mirror
GET /settings/origins/:id/mirror/:job
POST /settings/origins/:id/sync
POST /settings/origins/:id/delete
POST /settings/origins/:id/token
GET /settings/keys
POST /settings/keys
POST /settings/keys/:id/delete
`.trim().split("\n");

test("the studio's settings routes are exactly settingsRoutes', as one block in order", () => {
  const own = new Router<Handler>();
  settingsRoutes(own, () => []);
  const mine = own.routes().map(key);
  expect(mine.every((r) => isSettings(r.split(" ")[1]!))).toBe(true);
  const all = buildRouter().routes().map(key);
  const first = all.indexOf(mine[0]!);
  expect(all.slice(first, first + mine.length)).toEqual(mine);
  expect(all.filter((r) => isSettings(r.split(" ")[1]!))).toEqual(mine);
});

test("every settings path reaches its own route through the whole table", () => {
  const router = buildRouter();
  for (const { method, pattern } of router.routes().filter((r) => isSettings(r.pattern))) {
    const path = pattern.replace(/:\w+/g, "x");
    expect(`${method} ${router.match(method, path)?.pattern}`).toBe(`${method} ${pattern}`);
  }
});

test("the routes recorded when the block moved keep their order, where they remain", () => {
  const settings = buildRouter().routes().map(key).filter((r) => isSettings(r.split(" ")[1]!));
  const remaining = new Set(settings);
  expect(settings.filter((r) => RECORDED.includes(r))).toEqual(RECORDED.filter((r) => remaining.has(r)));
});
