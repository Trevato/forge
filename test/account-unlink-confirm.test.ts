/** Settings › Account's two Unlink buttons ask first, on the confirm page, which says how to link again (#7964). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkEdgeLogin, linkedLogin } from "../src/core/edge_links.ts";
import { linkParent, linkedParent } from "../src/core/federation.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "edge-secret-0123456789";
const ISSUER = "https://parent.test";

describe("Unlink on Settings › Account goes through the confirm page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let id = "";
  let cookie = "";
  const get = (path: string, who = cookie) => fetch(`${servers.url}${path}`, { redirect: "manual", headers: { cookie: who } });
  const confirmHref = (to: string) => `/-/confirm?to=${encodeURIComponent(to)}`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-unlink-confirm-"));
    app = createApp({ dataDir, port: 0, edgeToken: TOKEN, parentUrl: ISSUER });
    servers = await serve(app);
    await createUser(app.db, { origin: "seed", username: "olive", email: "olive@x.test", password: "a-long-family-passphrase", adminIfFirst: true });
    const made = await createUser(app.db, { origin: "seed", username: "ann", email: "ann@x.test", password: "a-long-family-passphrase" });
    if (!made.ok) throw new Error(made.error);
    id = made.value.id;
    cookie = `forge_session=${createSession(app.db, id).token}`;
    expect(linkEdgeLogin(app.db, made.value, "octo").ok).toBe(true);
    expect(linkParent(app.db, id, ISSUER, "ann-sub")).toEqual({ ok: true, value: "linked" });
  }, 60_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("each Unlink is a link to the confirm page, not a form that posts at once", async () => {
    const page = await (await get("/settings")).text();
    expect(page).toContain("open-platform.sh: linked as <strong>octo</strong>");
    expect(page).toContain("parent.test: linked");
    for (const to of ["/settings/edge/unlink", "/settings/parent/unlink"]) {
      expect(page).toContain(`href="${confirmHref(to)}"`);
      expect(page).not.toContain(`action="${to}"`);
    }
  });

  test("the confirm page words the open-platform.sh unlink and posts to it", async () => {
    const res = await get(confirmHref("/settings/edge/unlink"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Unlink your open-platform.sh login?");
    expect(body).toContain("until you sign in that way and link it again on this page.");
    expect(body).toContain('action="/settings/edge/unlink"');
    expect(body).toContain("Unlink");
  });

  test("the confirm page words the parent forge unlink and posts to it", async () => {
    const res = await get(confirmHref("/settings/parent/unlink"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Unlink the parent forge?");
    expect(body).toContain("The last way in is never removed.");
    expect(body).toContain('action="/settings/parent/unlink"');
  });

  test("opening the confirm page changes nothing; the links stay until the POST", () => {
    expect(linkedLogin(app.db, id)).toBe("octo");
    expect(linkedParent(app.db, id, ISSUER)).toBeDefined();
  });
});
