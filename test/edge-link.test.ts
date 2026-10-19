import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createUser } from "../src/core/users.ts";
import { createSession } from "../src/core/sessions.ts";
import { linkedLogin } from "../src/core/edge_links.ts";
import { seedAdmin } from "./helpers/admin.ts";

const TOKEN = "edge-secret-0123456789";

describe("linking an open-platform.sh login from account settings", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie: Record<string, string>;
  let bobCookie: Record<string, string>;
  let annId: string;
  const flash = (res: Response) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const edge = (login: string) => ({ "x-plat-user": login, "x-plat-edge-token": TOKEN });
  const post = (path: string, who: Record<string, string>, login?: string) =>
    fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...who,
        ...(login ? edge(login) : {}),
        origin: "https://forge.example",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "",
    });
  const whoAmI = async (login: string) =>
    (await fetch(`${base}/api/v1/user`, { headers: edge(login) })).status === 200
      ? ((await fetch(`${base}/api/v1/user`, { headers: edge(login) })).json() as Promise<{ username: string }>).then((u) => u.username)
      : undefined;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edgelink-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: TOKEN });
    servers = await serve(app);
    base = servers.url;
    const root = await seedAdmin(app, { username: "olive", email: "olive@forge.example" });
    if (!root.ok) throw new Error(root.error);
    const mk = async (username: string) => {
      const made = await createUser(app.db, { origin: "edge", username, email: `${username}@forge.example` });
      if (!made.ok) throw new Error(made.error);
      return { id: made.value.id, cookie: `forge_session=${createSession(app.db, made.value.id).token}` };
    };
    const ann = await mk("ann");
    annId = ann.id;
    cookie = { cookie: ann.cookie };
    bobCookie = { cookie: (await mk("bob")).cookie };
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("settings say not linked, offer Link for the login the request carries", async () => {
    const page = await fetch(`${base}/settings`, { headers: { ...cookie, ...edge("octo") } }).then((r) => r.text());
    expect(page).toContain("open-platform.sh: not linked");
    expect(page).toContain("/settings/edge/link");
    expect(page).toContain("Link octo");
  });

  test("a cross-origin link is refused", async () => {
    const res = await fetch(`${base}/settings/edge/link`, {
      method: "POST",
      redirect: "manual",
      headers: { ...cookie, ...edge("octo"), origin: "https://evil.example" },
      body: "",
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await whoAmI("octo")).toBeUndefined();
  });

  test("link, then an edge sign-in reaches the account; unlink, and it does not", async () => {
    expect(await whoAmI("octo")).toBeUndefined();
    expect((await post("/settings/edge/link", cookie, "octo")).status).toBe(303);
    expect(await whoAmI("octo")).toBe("ann");
    const page = await fetch(`${base}/settings`, { headers: cookie }).then((r) => r.text());
    expect(page).toContain("open-platform.sh: linked as");
    expect(page).toContain("octo");
    expect((await post("/settings/edge/unlink", cookie)).status).toBe(303);
    expect(await whoAmI("octo")).toBeUndefined();
    expect(linkedLogin(app.db, (await fetch(`${base}/api/v1/user`, { headers: cookie }).then((r) => r.json()) as { id: string }).id)).toBeUndefined();
  });

  test("one edge login cannot be linked to two accounts", async () => {
    await post("/settings/edge/link", cookie, "octo");
    await post("/settings/edge/link", bobCookie, "octo");
    expect(await whoAmI("octo")).toBe("ann");
    await post("/settings/edge/unlink", cookie);
  });

  test("a login that names another account cannot be linked", async () => {
    await post("/settings/edge/link", cookie, "bob");
    expect(await whoAmI("bob")).toBe("bob");
  });

  test("an account the edge made by name still signs in by name", async () => {
    expect(await whoAmI("bob")).toBe("bob");
  });

  test("a request without the edge's login links nothing", async () => {
    const res = await post("/settings/edge/link", cookie);
    expect(res.status).toBe(303);
    expect(linkedLogin(app.db, annId)).toBeUndefined();
    const page = await fetch(`${base}/settings`, { headers: { ...cookie, cookie: `${cookie.cookie}; ${flash(res)}` } }).then((r) => r.text());
    expect(page).toContain("Sign in through open-platform.sh first, then link.");
  });

  test("a second, different login while one is linked is refused", async () => {
    expect((await post("/settings/edge/link", cookie, "octo")).status).toBe(303);
    const res = await post("/settings/edge/link", cookie, "other");
    expect(linkedLogin(app.db, annId)).toBe("octo");
    const page = await fetch(`${base}/settings`, { headers: { cookie: `${cookie.cookie}; ${flash(res)}` } }).then((r) => r.text());
    expect(page).toContain("linked to another open-platform.sh login");
    expect(await whoAmI("other")).toBeUndefined();
  });

  test("login matching is case-insensitive", async () => {
    expect((await post("/settings/edge/link", cookie, "Octo")).status).toBe(303);
    expect(linkedLogin(app.db, annId)).toBe("octo");
    expect(await whoAmI("octo")).toBe("ann");
    await post("/settings/edge/unlink", cookie);
  });

  test("the card is absent while edge sign-in is off", async () => {
    const plain = createApp({ dataDir: await mkdtemp(join(tmpdir(), "forge-edgelink-off-")), port: 0, url: "https://forge.example" });
    const srv = await serve(plain);
    try {
      const made = await createUser(plain.db, { origin: "edge", username: "zed", email: "zed@forge.example" });
      if (!made.ok) throw new Error(made.error);
      const page = await fetch(`${srv.url}/settings`, { headers: { cookie: `forge_session=${createSession(plain.db, made.value.id).token}` } }).then((r) => r.text());
      expect(page).not.toContain("open-platform.sh: ");
      expect(page).not.toContain("/settings/edge/link");
    } finally {
      srv.stop();
      plain.close();
    }
  });
});
