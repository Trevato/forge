import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { edgeIdentity, edgeLoginUrl, edgeLogoutUrl } from "../src/http/edge.ts";
import { serve, type Servers } from "../src/http/server.ts";

const TOKEN = "edge-secret-0123456789";

describe("edgeIdentity", () => {
  const request = (headers: Record<string, string>) =>
    new Request("http://10.0.0.5:8080/", { headers });

  test("without a configured secret the headers are a claim and are ignored", () => {
    const r = request({ "x-plat-user": "ada", "x-plat-edge-token": TOKEN });
    expect(edgeIdentity(r, undefined)).toBeUndefined();
    expect(edgeIdentity(r, "")).toBeUndefined();
  });

  test("the secret must match exactly; then the user header is the person", () => {
    expect(
      edgeIdentity(
        request({ "x-plat-user": "ada", "x-plat-edge-token": "wrong" }),
        TOKEN,
      ),
    ).toBeUndefined();
    expect(
      edgeIdentity(
        request({ "x-plat-user": " ada ", "x-plat-edge-token": TOKEN }),
        TOKEN,
      ),
    ).toBe("ada");
    expect(
      edgeIdentity(request({ "x-plat-edge-token": TOKEN }), TOKEN),
    ).toBeUndefined();
  });

  test("return targets are paths on this host, never URLs", () => {
    expect(edgeLoginUrl("/ada/hello?tab=1#x")).toBe(
      "/_plat/login?rd=%2Fada%2Fhello%3Ftab%3D1",
    );
    expect(edgeLoginUrl("//evil.example")).toBe("/_plat/login?rd=%2F");
    expect(edgeLoginUrl("/\\evil.example")).toBe("/_plat/login?rd=%2F");
    expect(edgeLoginUrl("https://evil.example/")).toBe("/_plat/login?rd=%2F");
    expect(edgeLogoutUrl("/a b")).toBe("/_plat/logout?rd=%2F");
  });
});

describe("a forge behind the platform edge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const asAda = { "x-plat-user": "ada", "x-plat-edge-token": TOKEN };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edge-"));
    app = createApp({
      dataDir,
      port: 0,
      url: "https://forge.example",
      edgeToken: TOKEN,
    });
    servers = await serve(app);
    base = servers.url;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger is offered the edge's sign-in, not the forge's", async () => {
    const page = await fetch(`${base}/`).then((r) => r.text());
    expect(page).toContain('href="/_plat/login?rd=%2F"');
    expect(page).not.toContain('href="/signin"');
  });

  test("the first person the edge vouches for is made on sight, as admin", async () => {
    const me = await fetch(`${base}/api/v1/user`, { headers: asAda });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { username: string; isAdmin: boolean };
    expect(body.username).toBe("ada");
    expect(body.isAdmin).toBe(true);

    const page = await fetch(`${base}/`, { headers: asAda }).then((r) =>
      r.text(),
    );
    expect(page).toContain("Sign out");
    expect(page).toContain('href="/_plat/logout?rd=%2F"');
  });

  test("a page that needs a person sends a stranger to the edge, not the password form", async () => {
    const response = await fetch(`${base}/new`, { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/_plat/login?rd=%2Fnew");
  });

  test("the forge's own sign-in page leads with the edge and says who has no password", async () => {
    const page = await fetch(`${base}/signin?next=%2Fnew`).then((r) =>
      r.text(),
    );
    expect(page).toContain('href="/_plat/login?rd=%2Fnew"');
    expect(page).toContain("Continue with the platform");
    expect(page).toContain("have no password here");
    // The password form is still there for an account that was given one.
    expect(page).toContain('name="password"');
  });

  test("the account has no password: the forge's own sign-in refuses it", async () => {
    const attempt = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      body: JSON.stringify({ username: "ada", password: "", name: "x" }),
    });
    expect(attempt.status).toBe(401);
  });

  test("a wrong secret is nobody, and a cross-site page cannot ride the edge", async () => {
    const nobody = await fetch(`${base}/api/v1/user`, {
      headers: { "x-plat-user": "ada", "x-plat-edge-token": "nope" },
    });
    expect(nobody.status).toBe(401);

    const csrf = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { ...asAda, origin: "https://evil.example" },
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    });
    expect(csrf.status).toBe(403);
  });

  test("from the public origin the person acts with full authority", async () => {
    const created = await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: { ...asAda, origin: "https://forge.example" },
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    });
    expect(created.status).toBe(201);
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { ...asAda, origin: "https://forge.example" },
      // Ada is the site admin: from a page, her token is minted on purpose (#596).
      body: JSON.stringify({ name: "cli", scope: "rw", adminConfirm: true }),
    });
    expect(minted.status).toBe(201);
  });

  test("an existing account of the same name is that person, whatever the case", async () => {
    const me = await fetch(`${base}/api/v1/user`, {
      headers: { "x-plat-user": "ADA", "x-plat-edge-token": TOKEN },
    });
    expect(((await me.json()) as { username: string }).username).toBe("ada");
  });
});
