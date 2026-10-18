import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { drillVerdict } from "../src/kernel/domain_drill.ts";
import { DOMAINS } from "../src/kernel/domains.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

const state = DOMAINS.find((d) => d.key === "state")!;

describe("the verdict", () => {
  test("green: every phrase seen, back within its minutes", () => {
    const v = drillVerdict(state, { health: "Disk is nearly full: 97%", board: "" }, 60 * 60);
    expect(v.green).toBe(true);
  });
  test("red on a missing phrase, naming it", () => {
    const v = drillVerdict(state, { health: "ok", board: "fine" }, 10);
    expect(v.green).toBe(false);
    expect(v.why).toContain("Disk is nearly full:");
  });
  test("red on overrun, naming it", () => {
    const v = drillVerdict(state, { health: "Disk is nearly full:", board: "" }, 60 * 60 + 1);
    expect(v.green).toBe(false);
    expect(v.why).toContain("1s over the 60 minutes");
  });
});

describe("POST /api/v1/drills", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let plain: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-drill-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await seedAdmin(app, { username: "ada", email: "ada@f.dev", password: "owner-passphrase" });
    const b = await signUp(app, { username: "bob", email: "bob@f.dev", password: "bob-passphrase" }, { slot: fixtureSlot(app) });
    if (!a.ok || !b.ok) throw new Error("signup");
    admin = createToken(app.db, a.value.id, "t", "admin").token;
    plain = createToken(app.db, b.value.id, "t", "admin").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (token: string, payload: unknown) =>
    fetch(`${servers.url}/api/v1/drills`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  const ok = {
    domain: "state",
    seen: { health: "Disk is nearly full: 97%", board: "" },
    backSeconds: 120,
  };

  test("green is stored with its verdict", async () => {
    const res = await post(admin, ok);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { green: boolean }).green).toBe(true);
    const row = app.db.query<{ green: number; domain: string }, []>("SELECT green, domain FROM domain_drill").all();
    expect(row).toEqual([{ green: 1, domain: "state" }]);
  });
  test("red on a missing phrase is stored too", async () => {
    const res = await post(admin, { ...ok, seen: { health: "ok", board: "" } });
    const out = (await res.json()) as { green: boolean; why: string };
    expect(out.green).toBe(false);
    expect(out.why).toContain("Disk is nearly full:");
  });
  test("red on overrun", async () => {
    const res = await post(admin, { ...ok, backSeconds: 99_999 });
    expect(((await res.json()) as { green: boolean }).green).toBe(false);
  });
  test("a non-admin gets 403", async () => {
    expect((await post(plain, ok)).status).toBe(403);
  });
  test("an unknown domain gets 422", async () => {
    expect((await post(admin, { ...ok, domain: "weather" })).status).toBe(422);
  });
  test("oversize observations are refused and not stored", async () => {
    const before = app.db.query<{ n: number }, []>("SELECT count(*) n FROM domain_drill").get()!.n;
    const res = await post(admin, { ...ok, seen: { health: "x".repeat(9_000), board: "" } });
    expect(res.status).toBe(422);
    expect(app.db.query<{ n: number }, []>("SELECT count(*) n FROM domain_drill").get()!.n).toBe(before);
  });
});
