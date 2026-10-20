/** A client's first screen names its phases in Server-Timing: session, apps, render (#3283). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createUser } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir = "";
let app: App;
let servers: Servers;
let bearer = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-client-home-timing-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "maria", email: "m@x.test",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  // A forge made for a client: parent.json names the org its owner's apps live in.
  const org = createOrg(app.db, "marias", made.value.id);
  if (!org.ok) throw new Error(org.error);
  await Bun.write(join(dir, "parent.json"), JSON.stringify({ org: "marias" }));
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(servers.url + path, { headers: { authorization: `Bearer ${bearer}` } });
const timing = (res: Response): string[] => (res.headers.get("server-timing") ?? "").split(", ");

test("the client home names session, apps and render once each", async () => {
  const res = await get("/");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('id="client-apps"');
  const parts = timing(res);
  for (const n of ["session", "apps", "render"]) {
    expect(parts.filter((p) => p.startsWith(`${n};`)).length).toBe(1);
    expect(parts.find((p) => p.startsWith(`${n};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  }
});

test("the full home does not name the client's phases", async () => {
  const res = await get("/?all=1");
  await res.arrayBuffer();
  expect(timing(res).some((p) => p.startsWith("apps;"))).toBe(false);
});
