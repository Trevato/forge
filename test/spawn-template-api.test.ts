/**
 * Choosing a template for a new forge (#7533): `template` passes through the
 * spawn door into the plan only when it is not `blank`, an unknown one is a
 * 422 on `template`, the choice is kept in the ledger, `parent.json` and the
 * list, and `GET /api/v1/forges/templates` and MCP `templates` agree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { planSpawn } from "../src/spawn/plan.ts";
import { templatesView } from "../src/spawn/templates.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("choosing a template for a new forge", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let rw: string;
  let placed = 0;

  const post = (payload: unknown) =>
    fetch(`${base}/api/v1/forges`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rw}` },
      body: JSON.stringify(payload),
    });
  const mcp = async (name: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${rw}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const r = ((await res.json()) as any).result;
    return { error: r.isError === true, text: r.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-spawn-template-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error("user");
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    const repo = await createRepo(app, a.value, { name: "notes" });
    if (!repo.ok) throw new Error("repo");
    await commitToBranch(app, a.value, repo.value, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
    useProbe(app, () => async () => true);
    usePlacement(app, {
      place: async (plan) => ok({ url: `https://${plan.name}.fake.test`, bodyId: `fake-${++placed}` }),
      retire: async () => ok(),
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("plan carries the template only when it is not blank", async () => {
    const starter = await post({ name: "kid", apps: ["alice/notes"], template: "starter", dryRun: true });
    expect(starter.status).toBe(200);
    expect(((await starter.json()) as any).plan.template).toBe("starter");

    const none = ((await (await post({ name: "kid", apps: ["alice/notes"] })).json()) as any).plan;
    const blank = ((await (await post({ name: "kid", apps: ["alice/notes"], template: "blank" })).json()) as any).plan;
    expect("template" in none).toBe(false);
    expect(blank).toEqual(none);

    // The plan a build before templates gave, field for field, so old plan hashes hold.
    const source = { catalog: [], briefs: [], subscriptions: [] };
    const base = { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false };
    const before = { name: "kid", org: "kid", apps: [], briefs: [], subscriptions: [], direction: "", keepAccess: false, budgetUsd: null };
    expect(planSpawn(base, source)).toEqual(ok(before));
    expect(planSpawn({ ...base, template: "blank" }, source)).toEqual(ok(before));
    expect(JSON.stringify((planSpawn({ ...base, template: "blank" }, source) as any).value)).toBe(JSON.stringify(before));
  });

  test("an unknown template is a 422 on template", async () => {
    for (const template of ["nope", 7, ["starter"]]) {
      const res = await post({ name: "kid", apps: ["alice/notes"], template });
      expect(res.status).toBe(422);
      const body = (await res.json()) as any;
      expect(body.error).toBe("invalid");
      expect(body.message).toBe("template: template must be blank or starter");
    }
    const viaMcp = await mcp("spawn", { name: "kid", template: "nope" });
    expect(viaMcp.error).toBe(true);
    expect(viaMcp.text).toContain("template: template must be blank or starter");
  });

  test("the templates list is public and ETagged", async () => {
    const res = await fetch(`${base}/api/v1/forges/templates`);
    expect(res.status).toBe(200);
    const got = (await res.json()) as ReturnType<typeof templatesView>;
    expect(got).toEqual(JSON.parse(JSON.stringify(templatesView())));
    expect(got.default).toBe("blank");
    expect(got.templates[0]!.id).toBe("blank");
    expect(got.templates.map((t) => t.id)).toContain("starter");
    for (const t of got.templates) {
      expect(["builtin", "repo"]).toContain(t.source);
      expect(t.says.length).toBeGreaterThan(10);
    }
    const etag = res.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await fetch(`${base}/api/v1/forges/templates`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  test("mcp templates equals the api list", async () => {
    const api = await (await fetch(`${base}/api/v1/forges/templates`)).json();
    const viaMcp = await mcp("templates", {});
    expect(viaMcp.error).toBe(false);
    expect(JSON.parse(viaMcp.text)).toEqual(api);
  });

  test("ledger and parent.json record the template", async () => {
    const made = await post({ name: "tpl", apps: ["alice/notes"], template: "starter", dryRun: false });
    expect(made.status).toBe(201);
    const body = (await made.json()) as any;

    const ledger = await Bun.file(join(dataDir, "spawn", "tpl.json")).json();
    expect(ledger.template).toBe("starter");
    const parent = await Bun.file(join(childDirOf(app, body.bodyId), "parent.json")).json();
    expect(parent.template).toEqual({ id: "starter" });

    const list = (await (await fetch(`${base}/api/v1/forges`, { headers: { authorization: `Bearer ${rw}` } })).json()) as any;
    expect(list.items.find((c: any) => c.name === "tpl").template).toBe("starter");

    // Another template is another child: refused, as a different plan is.
    const retry = await post({ name: "tpl", apps: ["alice/notes"], template: "blank", dryRun: false });
    expect(retry.status).toBe(409);
    expect(((await retry.json()) as any).error).toBe("exists");
    const same = await post({ name: "tpl", apps: ["alice/notes"], template: "starter", dryRun: false });
    expect(same.status).toBe(200);
    expect(((await same.json()) as any).existed).toBe(true);
  }, 60_000);
});
