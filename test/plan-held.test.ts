/**
 * A plan's answer says which opened issues will not start yet, and why, in
 * the map's own words (#7427): an issue naming a hot file is held, one that
 * names no hot file is not.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { updateRepoSettings } from "../src/core/repos.ts";
import { createRepo } from "../src/actions/repos.ts";
import { openPlan } from "../src/actions/plan.ts";
import { holdFile } from "../src/crew/file_holds.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { rememberPullFiles, HOT_PULLS } from "../src/crew/hot_files.ts";
import { createUser, type User } from "../src/core/users.ts";

describe("a plan's answer lists the issues that are held", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;
  let rw = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-plan-held-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    servers = await serve(app);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("only the item naming a hot file is held, with the map's sentence", async () => {
    const made = await createRepo(app, alice, { name: "held", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    rememberPullFiles(
      repo.id,
      Array.from({ length: HOT_PULLS }, (_, i) => ({ number: 100 + i, files: ["src/busy.ts"] })),
    );
    const planned = openPlan(app, alice, repo, [
      { key: "hot", title: "Rework src/busy.ts", body: "Files: src/busy.ts", blockedBy: [] },
      { key: "cold", title: "Rework src/quiet.ts", body: "Files: src/quiet.ts", blockedBy: [] },
    ]);
    if (!planned.ok) throw new Error(planned.error.message);
    const { opened, held, ready } = planned.value;
    const number = (key: string) => opened.find((o) => o.key === key)!.number;
    expect(held).toEqual([
      {
        key: "hot",
        number: number("hot"),
        by: "hot_file",
        detail: `src/busy.ts is in ${HOT_PULLS} open pulls`,
      },
    ]);
    expect(ready).toContain(number("cold"));
  });

  const heat = (repoId: string) =>
    rememberPullFiles(
      repoId,
      Array.from({ length: HOT_PULLS }, (_, i) => ({ number: 100 + i, files: ["src/busy.ts"] })),
    );
  const items = [
    { key: "hot", title: "Rework src/busy.ts", body: "Files: src/busy.ts" },
    { key: "cold", title: "Rework src/quiet.ts", body: "Files: src/quiet.ts" },
  ];
  const quiet = async (name: string) => {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    return updateRepoSettings(app.db, made.value, { plansNeedNod: false });
  };

  test("a file an admin holds holds the item naming it", async () => {
    const repo = await quiet("pinned");
    expect(holdFile(app.db, repo.id, "src/pinned.ts", alice.id).ok).toBe(true);
    const planned = openPlan(app, alice, repo, [
      { key: "pin", title: "Rework src/pinned.ts", body: "", blockedBy: [] },
      { key: "free", title: "Rework src/free.ts", body: "", blockedBy: [] },
    ]);
    if (!planned.ok) throw new Error(planned.error.message);
    expect(planned.value.held).toEqual([
      {
        key: "pin",
        number: planned.value.opened[0]!.number,
        by: "hot_file",
        detail: "src/pinned.ts is held by an admin",
      },
    ]);
  });

  test("POST …/plan answers with held", async () => {
    const repo = await quiet("route");
    heat(repo.id);
    const res = await fetch(`${servers.url}/api/v1/repos/alice/route/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
      body: JSON.stringify({ issues: items }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.held.map((h: any) => [h.key, h.by, h.detail])).toEqual([
      ["hot", "hot_file", `src/busy.ts is in ${HOT_PULLS} open pulls`],
    ]);
  });

  test("the MCP plan tool answers with held", async () => {
    const repo = await quiet("tool");
    heat(repo.id);
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${rw}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "plan", arguments: { app: "alice/tool", issues: items } },
      }),
    });
    const out = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(out.held.map((h: any) => [h.key, h.by, h.detail])).toEqual([
      ["hot", "hot_file", `src/busy.ts is in ${HOT_PULLS} open pulls`],
    ]);
  });
});
