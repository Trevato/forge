import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createUser, type User } from "../src/core/users.ts";
import { linkEdgeLogin, linkedLogin } from "../src/core/edge_links.ts";

const TOKEN = "edge-secret-0123456789";

describe("linkEdgeLogin refusals", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  const mk = async (username: string): Promise<User> => {
    const made = await createUser(app.db, { origin: "edge", username, email: `${username}@forge.example` });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const whoAmI = async (login: string): Promise<string | undefined> => {
    const res = await fetch(`${servers.url}/api/v1/user`, { headers: { "x-plat-user": login, "x-plat-edge-token": TOKEN } });
    return res.status === 200 ? ((await res.json()) as { username: string }).username : undefined;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-edgelink-refusals-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: TOKEN });
    servers = await serve(app);
    alice = await mk("alice");
    bob = await mk("bob");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("alice links alice-gh and an edge sign-in as alice-gh reaches alice", async () => {
    expect(await whoAmI("alice-gh")).toBeUndefined();
    expect(linkEdgeLogin(app.db, alice, "alice-gh")).toEqual({ ok: true, value: "linked" });
    expect(await whoAmI("alice-gh")).toBe("alice");
  });

  test("bob linking alice-gh is login_taken and the sign-in still reaches alice", async () => {
    const res = linkEdgeLogin(app.db, bob, "alice-gh");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("login_taken");
    expect(linkedLogin(app.db, bob.id)).toBeUndefined();
    expect(await whoAmI("alice-gh")).toBe("alice");
  });

  test.each([
    ["a leading dash", "-x"],
    ["65 characters", "a".repeat(65)],
    ["a space", "has space"],
    ["a slash", "has/slash"],
  ])("%s is invalid_login", (_name, login) => {
    const res = linkEdgeLogin(app.db, bob, login);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("invalid_login");
    expect(linkedLogin(app.db, bob.id)).toBeUndefined();
  });

  test("a login of 64 characters is accepted", () => {
    expect(linkEdgeLogin(app.db, bob, "b".repeat(64)).ok).toBe(true);
  });

  test("linking the same login again as alice is a no-op", async () => {
    expect(linkEdgeLogin(app.db, alice, "alice-gh")).toEqual({ ok: true, value: "linked" });
    expect(linkedLogin(app.db, alice.id)).toBe("alice-gh");
    const rows = app.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM edge_link WHERE user_id = ?").get(alice.id);
    expect(rows?.n).toBe(1);
    expect(await whoAmI("alice-gh")).toBe("alice");
  });
});
