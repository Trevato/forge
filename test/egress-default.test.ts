// Egress is enforced unless an admin says otherwise, with a reason (#10778):
// an environment asking for report is ignored and said once, never obeyed.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import {
  capacityChanges,
  capacityDefault,
  egressEnvIgnored,
  egressSetting,
  REASON_MAX,
  setCapacity,
} from "../src/core/capacity.ts";
import type { User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "", alice: User;
const before = process.env["FORGE_CELLS_EGRESS"];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-egress-default-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  alice = admin.value;
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterEach(() => {
  if (before === undefined) delete process.env["FORGE_CELLS_EGRESS"];
  else process.env["FORGE_CELLS_EGRESS"] = before;
  setCapacity(app.db, "cells.egress", null, alice.id);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the default is enforce", () => {
  delete process.env["FORGE_CELLS_EGRESS"];
  expect(capacityDefault("cells.egress")).toBe("enforce");
  expect(egressSetting(app.db)).toBe("enforce");
});

test("an environment asking for report is ignored, and said in one line", () => {
  process.env["FORGE_CELLS_EGRESS"] = "report";
  expect(capacityDefault("cells.egress")).toBe("enforce");
  expect(egressSetting(app.db)).toBe("enforce");
  const said = egressEnvIgnored();
  expect(said).toContain("FORGE_CELLS_EGRESS=report is ignored");
  expect(said).not.toContain("\n");
  expect(egressEnvIgnored({})).toBeNull();
  expect(egressEnvIgnored({ FORGE_CELLS_EGRESS: "enforce" })).toBeNull();
});

test("the capacity page shows no report line and no environment for it when only the environment asks", async () => {
  process.env["FORGE_CELLS_EGRESS"] = "report";
  const res = await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${bearer}` } });
  const body = await res.text();
  expect(body).not.toContain("Egress is reported, not enforced");
  expect(body).not.toContain("FORGE_CELLS_EGRESS");
});

test("an admin's report is honoured only with a reason, and kept with who and why", async () => {
  expect(changeCapacity(app, alice, "cells.egress", "report")).toEqual({ ok: false, error: "reason_required" });
  expect(changeCapacity(app, alice, "cells.egress", "report", "   ")).toEqual({ ok: false, error: "reason_required" });
  expect(egressSetting(app.db)).toBe("enforce");

  expect(changeCapacity(app, alice, "cells.egress", "report", "migrating the lab, one day").ok).toBe(true);
  expect(egressSetting(app.db)).toBe("report");
  const kept = capacityChanges(app.db)[0]!;
  expect([kept.key, kept.from, kept.to, kept.actorName, kept.reason]).toEqual([
    "cells.egress",
    "enforce",
    "report",
    "alice",
    "migrating the lab, one day",
  ]);

  // The API refuses without a reason and keeps the one it is given.
  const put = (body: object) =>
    fetch(`${servers.url}/api/v1/admin/capacity/cells.egress`, {
      method: "PUT",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  expect((await put({ value: "report" })).status).toBe(422);
  expect((await put({ value: "enforce", reason: "lab done" })).status).toBe(200);
  expect(egressSetting(app.db)).toBe("enforce");
  expect(capacityChanges(app.db)[0]!.reason).toBe("lab done");
  expect((await put({ value: "report", reason: "lab again" })).status).toBe(200);
  expect(egressSetting(app.db)).toBe("report");
  // Tightening never waits on a reason.
  expect((await put({ value: "enforce" })).status).toBe(200);
  expect(egressSetting(app.db)).toBe("enforce");

  // The page lists the reason beside who.
  const page = await (await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${bearer}` } })).text();
  expect(page).toContain("lab done");
  expect(page).toContain('name="reason"');
});

test("a setting that needs no reason still takes none", () => {
  expect(changeCapacity(app, alice, "checks.shards", "2").ok).toBe(true);
  expect(capacityChanges(app.db)[0]!.reason).toBe("");
  changeCapacity(app, alice, "checks.shards", null);
});

test("tightening needs no reason: enforce and the reset to default both go through bare", () => {
  expect(changeCapacity(app, alice, "cells.egress", "report", "a window").ok).toBe(true);
  expect(changeCapacity(app, alice, "cells.egress", "enforce").ok).toBe(true);
  expect(egressSetting(app.db)).toBe("enforce");
  expect(changeCapacity(app, alice, "cells.egress", "report", "a window").ok).toBe(true);
  expect(changeCapacity(app, alice, "cells.egress", null).ok).toBe(true);
  expect(egressSetting(app.db)).toBe("enforce");
});

test("a reason is cut once, at the action, to REASON_MAX", () => {
  expect(changeCapacity(app, alice, "cells.egress", "report", "x".repeat(REASON_MAX + 50)).ok).toBe(true);
  expect(capacityChanges(app.db)[0]!.reason.length).toBe(REASON_MAX);
});

test("the page: report without a reason is refused, with one it holds, and Put back needs none", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "correct-horse-battery" }),
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const post = (body: Record<string, string>) =>
    fetch(`${servers.url}/settings/capacity`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams(body),
    });
  await post({ key: "cells.egress", value: "report" });
  expect(egressSetting(app.db)).toBe("enforce");
  await post({ key: "cells.egress", value: "report", reason: "page says why" });
  expect(egressSetting(app.db)).toBe("report");
  expect(capacityChanges(app.db)[0]!.reason).toBe("page says why");
  await post({ key: "cells.egress", reset: "1" });
  expect(egressSetting(app.db)).toBe("enforce");
  // The reason is a labelled field inside the setting's own form, posted with Save.
  const page = await (await fetch(`${servers.url}/settings/capacity`, { headers: { cookie } })).text();
  const form = [...page.matchAll(/<form\b[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes('value="cells.egress"'));
  expect(form).toContain('name="reason"');
  expect(form).toContain('aria-label="Why (needed to set report)"');
});

test("MCP: report needs the reason argument, and keeps it", async () => {
  const call = async (args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "capacity", arguments: args } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    return { error: body.result.isError === true, text: body.result.content[0]!.text };
  };
  const bare = await call({ key: "cells.egress", value: "report", dryRun: false });
  expect(bare.error).toBe(true);
  expect(bare.text).toContain("reason_required");
  expect(egressSetting(app.db)).toBe("enforce");
  expect((await call({ key: "cells.egress", value: "report", reason: "mcp says why", dryRun: false })).error).toBe(false);
  expect(capacityChanges(app.db)[0]!.reason).toBe("mcp says why");
  expect((await call({ key: "cells.egress", value: "enforce", dryRun: false })).error).toBe(false);
  expect(egressSetting(app.db)).toBe("enforce");
});
