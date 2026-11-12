import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { edgeIdentity, edgeLoginUrl, edgeLogoutUrl } from "../src/http/edge.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { mintInvite } from "../src/core/invites.ts";
import { setSignup } from "../src/settings/signup.ts";
import { seedAdmin } from "./helpers/admin.ts";

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
  // The site admin, made by the operator, signs in through the edge too.
  const asOlive = { "x-plat-user": "olive", "x-plat-edge-token": TOKEN };

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
    const olive = await seedAdmin(app, { username: "olive", email: "olive@forge.example" });
    if (!olive.ok) throw new Error(olive.error);
    // An account the edge made when it still did.
    const ada = await createUser(app.db, { origin: "edge", username: "ada", email: "ada@forge.example" });
    if (!ada.ok) throw new Error(ada.error);
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

  test("a signed-out visitor on Make it yours is sent to the edge's sign-in, back to the same path; a vouched newcomer to /signup", async () => {
    const olive = getUserByName(app.db, "olive")!;
    const made = await createRepo(app, olive, { name: "loved", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const path = "/olive/loved/make-it-yours";
    const anon = await fetch(`${base}${path}`, { redirect: "manual" });
    expect(anon.headers.get("location")).toBe(`/_plat/login?rd=${encodeURIComponent(path)}`);
    const stranger = { "x-plat-user": "newcomer", "x-plat-edge-token": TOKEN };
    const vouched = await fetch(`${base}${path}`, { headers: stranger, redirect: "manual" });
    expect(vouched.headers.get("location")).toBe("/signup");
  });

  test("an unknown edge login creates no user and is offered /signup", async () => {
    const stranger = { "x-plat-user": "newcomer", "x-plat-edge-token": TOKEN };
    expect((await fetch(`${base}/api/v1/user`, { headers: stranger })).status).toBe(401);
    expect(getUserByName(app.db, "newcomer")).toBeUndefined();
    const page = await fetch(`${base}/`, { headers: stranger }).then((r) => r.text());
    expect(page).toContain('href="/signup"');
    expect(page).not.toContain("Sign out");
    const gated = await fetch(`${base}/new`, { headers: stranger, redirect: "manual" });
    expect(gated.headers.get("location")).toBe("/signup");
    expect(getUserByName(app.db, "newcomer")).toBeUndefined();
  });

  test("a vouched newcomer's pages drop the edge button and pin the name", async () => {
    const stranger = { "x-plat-user": "newcomer", "x-plat-edge-token": TOKEN };
    const home = await fetch(`${base}/`, { headers: stranger }).then((r) => r.text());
    expect(home).toContain('href="/signup"');
    expect(home).not.toContain("/_plat/login");
    const signup = await fetch(`${base}/signup`, { headers: stranger }).then((r) => r.text());
    expect(signup).not.toContain("/_plat/login");
    expect(signup).toContain('value="newcomer"');
    expect(signup).toContain("readonly");
  });

  test("a vouched newcomer cannot sign up under another name", async () => {
    const stranger = {
      "x-plat-user": "newcomer",
      "x-plat-edge-token": TOKEN,
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://forge.example",
    };
    const form = (username: string) =>
      new URLSearchParams({ username, email: "x@forge.example", password: "correct horse battery" }).toString();
    const res = await fetch(`${base}/signup`, { method: "POST", headers: stranger, body: form("grace") });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain("Sign up under the name");
    expect(getUserByName(app.db, "grace")).toBeUndefined();
    const key = await fetch(`${base}/signup/passkey/options`, {
      method: "POST",
      headers: { ...stranger, "content-type": "application/json" },
      body: JSON.stringify({ username: "grace", email: "x@forge.example" }),
    });
    expect(key.status).toBe(422);
  });

  test("a visitor the edge has not vouched for cannot sign up behind an edge", async () => {
    const headers = { "content-type": "application/x-www-form-urlencoded", origin: "https://forge.example" };
    const body = new URLSearchParams({ username: "alice", email: "a@forge.example", password: "correct horse battery" }).toString();
    const res = await fetch(`${base}/signup`, { method: "POST", headers, body, redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/_plat/login");
    expect(getUserByName(app.db, "alice")).toBeUndefined();
    const key = await fetch(`${base}/signup/passkey/options`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", email: "a@forge.example" }),
    });
    expect(key.status).toBe(422);
    const get = await fetch(`${base}/signup`, { redirect: "manual" });
    expect(get.headers.get("location")).toContain("/_plat/login");
  });

  test("an account the edge made earlier still signs in, not as admin", async () => {
    const me = await fetch(`${base}/api/v1/user`, { headers: asAda });
    expect(me.status).toBe(200);
    const body = (await me.json()) as { username: string; isAdmin: boolean };
    expect(body.username).toBe("ada");
    expect(body.isAdmin).toBe(false);

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

  test("the forge's own sign-in page offers the edge as a linked method and says who has no password", async () => {
    const page = await fetch(`${base}/signin?next=%2Fnew`).then((r) =>
      r.text(),
    );
    expect(page).toContain('href="/_plat/login?rd=%2Fnew"');
    expect(page).toContain("Link an account you have");
    expect(page).not.toContain("Continue with");
    expect(page).toContain("have no password here");
    // The password form is still there for an account that was given one.
    expect(page).toContain('name="password"');
  });

  test("the account has no password: the forge's own sign-in refuses it", async () => {
    const attempt = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      body: JSON.stringify({ adminConfirm: true, username: "ada", password: "", name: "x" }),
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
      headers: { ...asOlive, origin: "https://forge.example" },
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    });
    expect(created.status).toBe(201);
    const minted = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { ...asOlive, origin: "https://forge.example" },
      // Olive is the site admin: from a page, her token is minted on purpose (#596).
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

  test("with signup by invite, a body invite does not lift the name pin", async () => {
    const olive = getUserByName(app.db, "olive")!;
    setSignup(app.db, "invite", olive.id);
    try {
      const join = (headers: Record<string, string>) => {
        const { token } = mintInvite(app.db, olive.id);
        return fetch(`${base}/api/v1/users`, {
          method: "POST",
          headers: { ...headers, origin: "https://forge.example" },
          body: JSON.stringify({ username: "dave", email: "dave@forge.example", password: "correct horse battery", invite: token }),
        });
      };
      // A vouched carol may not take dave's name, nor may a visitor nobody vouched for.
      expect((await join({ "x-plat-user": "carol", "x-plat-edge-token": TOKEN })).status).toBe(403);
      expect((await join({})).status).toBe(403);
      expect(getUserByName(app.db, "dave")).toBeUndefined();
    } finally {
      setSignup(app.db, "open", olive.id);
    }
  });
});
