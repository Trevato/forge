import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { crossOrigin, publicUrl } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { signUpProven } from "./helpers/verified.ts";

describe("publicUrl", () => {
  test("without a configured origin the request's URL is the truth", () => {
    const url = publicUrl(
      new Request("http://10.0.0.5:3000/a/b?c=1"),
      undefined,
    );
    expect(url.href).toBe("http://10.0.0.5:3000/a/b?c=1");
  });

  test("a configured origin replaces scheme, host and port; path and query stay", () => {
    const url = publicUrl(
      new Request("http://10.0.0.5:3000/a/b?c=1"),
      "https://forge.example",
    );
    expect(url.href).toBe("https://forge.example/a/b?c=1");
    expect(url.port).toBe("");
  });

  test("a browser's Origin for the public address is not cross-origin", () => {
    const request = new Request("http://10.0.0.5:3000/signin", {
      method: "POST",
      headers: { origin: "https://forge.example" },
    });
    expect(crossOrigin(request, publicUrl(request, undefined))).toBe(true);
    expect(
      crossOrigin(request, publicUrl(request, "https://forge.example")),
    ).toBe(false);
  });
});

describe("a forge behind a TLS-terminating proxy", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-public-url-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example" });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("signing up from the public origin succeeds and the cookie is Secure", async () => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { origin: "https://forge.example" },
      body: new URLSearchParams({
        username: "ada",
        email: "ada@forge.example",
        password: "analytical-engine",
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toStartWith("forge_session=");
    expect(cookie).toContain("Secure");
  });

  test("the proxy's own origin is a stranger", async () => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { origin: base },
      body: new URLSearchParams({
        username: "eve",
        email: "eve@forge.example",
        password: "not-from-here",
      }),
      redirect: "manual",
    });
    expect(response.status).toBe(403);
  });

  test("clone URLs name the public address", async () => {
    // Grace signs up here, so this test does not lean on the one above:
    // an owner proves and promotes her before she makes things.
    const grace = await signUpProven(app, {
      username: "grace",
      email: "grace@forge.example",
      password: "compiler-pioneer",
    });
    if (!grace.ok) throw new Error("grace could not sign up");
    promote(app.db);
    const token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      body: JSON.stringify({ adminConfirm: true,
        username: "grace",
        password: "compiler-pioneer",
        name: "cli",
        scope: "rw",
      }),
    })
      .then((r) => r.json() as Promise<{ token: string }>)
      .then((body) => body.token);
    const created = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    });
    expect(created.status).toBe(201);
    const page = await fetch(`${base}/grace/hello`).then((r) => r.text());
    expect(page).toContain("https://forge.example/grace/hello.git");
    expect(page).not.toContain(`${base}/grace/hello.git`);
  });
});
