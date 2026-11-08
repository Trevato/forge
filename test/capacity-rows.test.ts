/** Settings › Capacity is rows under headings, not cards (#9709): one background, few borders. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { changeCapacity } from "../src/actions/capacity.ts";
import type { User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "", alice: User;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-caprows-"));
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

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async (): Promise<string> => {
  const res = await fetch(`${servers.url}/settings/capacity`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  const body = await res.text();
  const at = body.indexOf('class="settings-main"');
  expect(at).toBeGreaterThan(-1);
  return body.slice(at);
};

test("the settings are rows under a Capacity heading, and no part of the page is a card", async () => {
  const main = await page();
  expect(main).not.toMatch(/class="card[\s"]/);
  expect(main).not.toContain("card-head");
  for (const title of ["Capacity", "Changes", "Errors and refused calls", "Egress connections", "Self-swap"])
    expect(main).toContain(`<section class="settings-block"><h2>${title}</h2>`);
  const settings = main.slice(main.indexOf("<h2>Capacity</h2>"));
  expect(settings).toMatch(/^<h2>Capacity<\/h2><ul class="list setting-list">/);
  expect(settings.slice(0, settings.indexOf("</ul>"))).toContain('name="key" value="cells.egress"');
  // The settings come before what happened.
  expect(main.indexOf("<h2>Capacity</h2>")).toBeLessThan(main.indexOf("<h2>Errors and refused calls</h2>"));
});

test("the egress row reads its true current state, and the reported note says so in plain words", async () => {
  const egressRow = (s: string) => {
    const at = s.indexOf('value="cells.egress"');
    return s.slice(s.lastIndexOf("<li", at), at);
  };
  const before = await page();
  expect(before).not.toContain('id="egress-reported"');
  const now = /Now <span class="mono">([^<]+)<\/span>/.exec(egressRow(before))?.[1];
  expect(changeCapacity(app, alice, "cells.egress", "report").ok).toBe(true);
  const after = await page();
  expect(egressRow(after)).toContain('Now <span class="mono">report</span>');
  expect(now).not.toBe("report");
  expect(after).toContain('id="egress-reported"');
});
