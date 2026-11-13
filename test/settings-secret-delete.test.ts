/** Removing a secret from Settings: forge admin only, same-origin only, value never echoed (#7019). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { listEvents } from "../src/core/events.ts";
import { resolveSecrets, setSecret } from "../src/core/secret_store.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

const VALUE = "s3cr3t-value-do-not-echo-7019";
const NAME = "CLOUDFLARE_API_TOKEN";

let dataDir = "";
let app: App, servers: Servers;
let admin = "", member = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-secret-del-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  admin = await adminCookie(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const bob = await createUser(app.db, {
    origin: "seed", trusted: true, username: "bob", email: "b@forge.local", password: "correct-horse-battery",
  });
  if (!bob.ok) throw new Error(bob.error);
  member = `forge_session=${createSession(app.db, bob.value.id).token}`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const seal = () => {
  const set = setSecret(app.db, dataDir, "forge", "", NAME, VALUE);
  if (!set.ok) throw new Error(set.error);
};
const present = () => resolveSecrets(app.db, dataDir, app.bus, [NAME])[NAME] === VALUE;

function post(cookie: string | undefined, origin: string | null) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (cookie) headers.cookie = cookie;
  if (origin !== null) headers.origin = origin;
  return fetch(`${servers.url}/settings/secrets/delete`, {
    method: "POST",
    headers,
    body: new URLSearchParams({ scope: "forge", ref: "", name: NAME }),
    redirect: "manual",
  });
}

async function noValueAnywhere(res: Response) {
  expect(await res.text()).not.toContain(VALUE);
  expect([...res.headers.values()].join("\n")).not.toContain(VALUE);
  expect(decodeURIComponent(JSON.stringify(listEvents(app.db, {})))).not.toContain(VALUE);
}

test("an admin removes a named secret; the flash names it and it resolves no more", async () => {
  seal();
  expect(present()).toBe(true);
  const res = await post(admin, servers.url);
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/settings/secrets");
  expect(decodeURIComponent(res.headers.get("set-cookie") ?? "")).toContain(`${NAME} is removed.`);
  expect(resolveSecrets(app.db, dataDir, app.bus, [NAME])).toEqual({});
  const gone = listEvents(app.db, { kind: "secret.deleted" });
  expect(gone.length).toBe(1);
  expect(JSON.stringify(gone[0]!.payload)).toContain(NAME);
  await noValueAnywhere(res);
});

test("a non-admin, a signed-out caller and a cross-origin post are refused; the secret stays", async () => {
  seal();
  const before = listEvents(app.db, { kind: "secret.deleted" }).length;
  const refused = [
    await post(member, servers.url),
    await post(undefined, servers.url),
    await post(admin, "https://evil.example"),
  ];
  expect(refused[0]!.status).toBe(403);
  expect(refused[1]!.headers.get("location")).toStartWith("/signin");
  expect(refused[2]!.status).toBe(403);
  for (const res of refused) {
    expect(decodeURIComponent(res.headers.get("set-cookie") ?? "")).not.toContain("is removed");
    await noValueAnywhere(res);
  }
  expect(present()).toBe(true);
  expect(listEvents(app.db, { kind: "secret.deleted" }).length).toBe(before);
});
