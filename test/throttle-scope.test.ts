/**
 * The signup and sign-in windows catch only the doors they guard (#974): from
 * a source that is refused on POST /signup, POST /api/v1/users and POST
 * /signin, `GET /`, a repository page and an API read answer as they do
 * unthrottled, and a sign-in with an existing session is not a sign-up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLimit } from "../src/settings/limits.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-family-passphrase";
const LIMIT = 3;

describe("a throttled source is throttled only at the signup and sign-in doors", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";

  const signup = (username: string) =>
    fetch(`${servers.url}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username, email: `${username}@forge.test`, password: PASSWORD }),
      redirect: "manual",
    });
  const apiSignup = (username: string) =>
    fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, email: `${username}@forge.test`, password: PASSWORD }),
    });
  const signin = (username: string) =>
    fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "not-the-password" }),
      redirect: "manual",
    });
  const get = (path: string, withCookie: boolean) =>
    fetch(`${servers.url}${path}`, { headers: withCookie ? { cookie } : {}, redirect: "manual" });

  const reads = async () => {
    const out: Record<string, number> = {};
    for (const path of ["/", "/pat/site", "/api/v1/user", "/api/v1/repos", "/api/v1/repos/pat/site"])
      out[path] = (await get(path, true)).status;
    return out;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-throttle-scope-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const pat = await createUser(app.db, { trusted: true, isAdmin: true, username: "pat", email: "pat@forge.test", password: PASSWORD });
    if (!pat.ok) throw new Error("setup: no user");
    setLimit(app.db, "signup.per_source", LIMIT, pat.value.id);
    setLimit(app.db, "signin.per_source", LIMIT, pat.value.id);
    const session = createSession(app.db, pat.value.id);
    cookie = `forge_session=${session.token}`;
    const made = await fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers: { cookie, origin: servers.url, "content-type": "application/json" },
      body: JSON.stringify({ name: "site", description: "a site" }),
    });
    expect(made.status).toBe(201);
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the reads answer 200 before any throttling", async () => {
    for (const [path, status] of Object.entries(await reads())) expect([path, status]).toEqual([path, 200]);
  });

  test("the source is refused at sign-up, on the page and on the API", async () => {
    for (let i = 1; i <= LIMIT; i++) expect((await signup(`new-${i}x`)).status).toBe(303);
    const page = await signup("new-pagex");
    expect(page.status).toBe(429);
    expect(Number(page.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await page.text()).toMatch(/try again in (a second|\d+ seconds)/);
    const api = await apiSignup("new-apix");
    expect(api.status).toBe(429);
    expect(Number(api.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("the source is refused at sign-in with the wait on the page", async () => {
    for (let i = 1; i <= LIMIT; i++) expect((await signin(`nobody-${i}`)).status).toBe(422);
    const refused = await signin("nobody-last");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await refused.text()).toMatch(/Too many attempts\. Try again in (a second|\d+ seconds)/);
  });

  test("meanwhile / , a repository page and API reads answer as before", async () => {
    for (const [path, status] of Object.entries(await reads())) expect([path, status]).toEqual([path, 200]);
    for (const path of ["/"]) expect((await get(path, false)).status).toBe(200);
    expect((await get("/api/v1/repos", false)).status).toBe(200);
  });

  test("a sign-in with an existing session is not refused by the signup window", async () => {
    expect((await signup("still-refused")).status).toBe(429);
    const login = await fetch(`${servers.url}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ username: "pat", password: PASSWORD }),
    });
    expect(login.status).toBe(201);
    expect(login.headers.get("set-cookie")).toContain("forge_session=");
    const page = await get("/signin", true);
    expect(page.status).not.toBe(429);
  });
});
