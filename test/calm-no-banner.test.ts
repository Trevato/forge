/**
 * No first paint carries a standing notice for a configuration state (#10777).
 * Home, the board and /flow, for an admin and an everyday account, with the
 * forge in its most "configured" state (egress reported, not enforced), hold
 * no alert/banner/danger-notice element and none of the setting's words.
 * A setting is one line on its own page. Allowed kinds are named below: a
 * transient flash (`data-flash`) and a real failure of a service, which says
 * "down"/"failed" and is never a setting.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CAPACITY, CAPACITY_KEYS, capacityDefault, setCapacity, type CapacityKey } from "../src/core/capacity.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { EGRESS_REPORTED } from "../src/system/egress_line.ts";
import { seedAdmin } from "./helpers/admin.ts";

/**
 * The kinds a first paint may carry, by the markup the app produces: a
 * transient flash (`.toast`, role=status, layout.ts flashToast) and a real
 * failure (`.toast` with data-tone="danger", role=alert, as account.ts and
 * repo.ts render a refusal). Nothing else standing: no other role=alert, no
 * banner / notice / alert class.
 */
const ELEMENT = /<[a-z][^<>]*?(?:\brole="alert"|\bclass="[^"]*\b(?:banner|notice|notice-danger|notice-warn|alert)\b[^"]*")[^<>]*>/gi;
const allowed = (tag: string): boolean =>
  /\bclass="[^"]*\btoast\b/.test(tag) && (/\brole="status"/.test(tag) || /\bdata-tone="danger"/.test(tag));
const standing = (body: string): string[] => [...body.matchAll(ELEMENT)].map((m) => m[0]).filter((t) => !allowed(t));

let dataDir = "";
let app: App, servers: Servers;
const cookies: Record<string, string> = {};
let adminId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-nobanner-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const bob = await createUser(app.db, { username: "bob", email: "b@forge.local", password: "correct-horse-battery", origin: "seed", trusted: true });
  if (!bob.ok) throw new Error(bob.error);
  cookies.admin = `forge_session=${createSession(app.db, admin.value.id).token}`;
  cookies.everyday = `forge_session=${createSession(app.db, bob.value.id).token}`;
  adminId = admin.value.id;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Every non-default value a setting can hold: each choice, or a count's ends. */
function otherValues(key: CapacityKey): string[] {
  const kind = CAPACITY[key].kind;
  const all = kind.type === "choice" ? [...kind.values] : [String(kind.min), String(kind.max)];
  return all.filter((v) => v !== capacityDefault(key));
}

// Derived from the settings registry, so a new setting is covered at once.
for (const key of CAPACITY_KEYS) {
  test(`${key} in every non-default state: home, board and /flow paint no setting banner`, async () => {
    for (const value of otherValues(key)) {
      setCapacity(app.db, key, value, adminId);
      for (const who of ["admin", "everyday"]) {
        for (const path of ["/", "/board", "/flow"]) {
          const res = await fetch(`${servers.url}${path}`, { headers: { cookie: cookies[who]! }, redirect: "follow" });
          // /flow is the admin's page: an everyday account is told it is not found, calmly.
          expect(res.status).toBe(path === "/flow" && who === "everyday" ? 404 : 200);
          const body = await res.text();
          expect(body.length).toBeGreaterThan(100);
          expect({ key, value, who, path, found: standing(body) }).toEqual({ key, value, who, path, found: [] });
          // Secondary guard: the one sentence a setting once shouted.
          expect(body).not.toContain(EGRESS_REPORTED.slice(0, 30));
        }
      }
    }
    setCapacity(app.db, key, null, adminId);
  });
}

test("the detector fires on a banner and passes only the app's real flash and failure", () => {
  const toast = (tone: string, role: string) => `<div class="toast" data-tone="${tone}" role="${role}">x</div>`;
  expect(standing('<div class="banner">x</div>')).toHaveLength(1);
  expect(standing('<p role="alert">egress</p>')).toHaveLength(1);
  expect(standing('<div class="toast" data-tone="attn" role="alert">x</div>')).toHaveLength(1);
  expect(standing(toast("success", "status"))).toEqual([]);
  expect(standing(toast("danger", "alert"))).toEqual([]);
});
