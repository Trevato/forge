/**
 * A refused page or form answers the forge's own 403 page (#8491): the
 * chrome, "You can't do that here", one sentence why and the way back. A
 * caller that asks for JSON keeps `{ error, message }`, and no form route
 * answers a browser the bare word "forbidden" any more.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { buildRouter, forgeHttp } from "../src/http/server.ts";
import { CAME_FROM_ELSEWHERE, forbiddenPage, NOT_ADMIN_HERE, SENT_FROM_ELSEWHERE } from "../src/web/chrome.ts";
import type { Ctx } from "../src/http/context.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const HEADING = "<h1>You can't do that here</h1>";
const esc = (s: string) => s.replaceAll("'", "&#39;");

let dataDir = "", app: App, kim = "", kimId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-forbidden-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "kim", email: "kim@x.test", password: "correct-horse-battery", isAdmin: false,
  });
  if (!made.ok) throw new Error(made.error);
  kimId = made.value.id;
  kim = `forge_session=${createSession(app.db, kimId).token}`;
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const send = (path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) =>
  forgeHttp(app).handle(new Request(`http://forge.test${path}`, init));

const form = { "content-type": "application/x-www-form-urlencoded", accept: "text/html" };

describe("the 403 page", () => {
  test("a non-admin posting an admin form reads why, in the chrome, with the way home", async () => {
    const res = await send("/settings/everyday", {
      method: "POST",
      headers: { ...form, cookie: kim, origin: "http://forge.test" },
      body: "username=kim-me&email=kim-me%40x.test",
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("content-security-policy")).toBeTruthy();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const body = await res.text();
    expect(body).toContain(HEADING);
    expect(body).toContain(NOT_ADMIN_HERE);
    expect(body).toContain('href="/"');
    expect(body).not.toContain("Sign in</a>");
  });

  test("a cross-origin sign-in form gets the page, offering sign-in back", async () => {
    const res = await send("/signin", {
      method: "POST",
      headers: { ...form, origin: "https://evil.example" },
      body: "username=kim&password=x",
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain(HEADING);
    expect(body).toContain(esc(SENT_FROM_ELSEWHERE));
    expect(body).toContain('href="/"');
    expect(body).toContain("/signin");
  });

  test("a signed-in cross-origin form meets the origin gate's page; a script keeps its JSON", async () => {
    const page = await send("/settings/everyday/keep", {
      method: "POST",
      headers: { ...form, cookie: kim, origin: "https://evil.example" },
    });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain(HEADING);
    const script = await send("/settings/everyday/keep", {
      method: "POST",
      headers: { cookie: kim, origin: "https://evil.example", accept: "application/json" },
    });
    expect(script.status).toBe(403);
    expect(((await script.json()) as { error: string }).error).toBe("forbidden");
  });

  test("a script's cross-site post is told so without 'go back'", async () => {
    const res = await send("/signin", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", origin: "https://evil.example" },
      body: "username=kim&password=x",
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden", message: CAME_FROM_ELSEWHERE });
  });

  test("asked for JSON, it is the API's shape; the reason is escaped on the page", async () => {
    const ctx = (accept: string): Ctx => ({
      app,
      request: new Request("http://forge.test/x", { method: "POST", headers: { accept } }),
      url: new URL("http://forge.test/x"),
      params: {},
      auth: { user: undefined, scope: undefined, via: "none" },
      theme: undefined,
    });
    const asJson = forbiddenPage(ctx("application/json"), "Sign in to do this.");
    expect(asJson.status).toBe(403);
    expect(await asJson.json()).toMatchObject({ error: "forbidden", message: "Sign in to do this." });
    const html = await forbiddenPage(ctx("text/html"), "<b>no</b>").text();
    expect(html).toContain("&lt;b&gt;no&lt;/b&gt;");
    expect(html).not.toContain("<b>no</b>");
  });
});

const FILL: Record<string, string> = { owner: "kim", username: "kim", name: "notes", number: "1", org: "kim", id: "1" };
const fill = (pattern: string): string =>
  pattern.replace(/:([a-z_]+)/g, (_, k: string) => FILL[k] ?? "x").replace(/\*[a-z_]+/, "x");

test('no form route answers a browser the bare word "forbidden": not across sites, not as a non-admin', async () => {
  const routes = buildRouter().routes().filter((r) => ["POST", "PUT", "PATCH", "DELETE"].includes(r.method));
  expect(routes.length).toBeGreaterThan(50);
  const bare: string[] = [];
  for (const r of routes) {
    for (const origin of ["https://evil.example", "http://forge.test"]) {
      // A fresh session each time: a route before may have signed this one out.
      const cookie = `forge_session=${createSession(app.db, kimId).token}`;
      const res = await send(fill(r.pattern), { method: r.method, headers: { ...form, cookie, origin }, body: "" });
      const body = await res.text();
      if (res.status === 403 && body.trim() === "forbidden") bare.push(`${r.method} ${r.pattern} from ${origin}`);
    }
  }
  expect(bare).toEqual([]);
}, 60_000);
