/** The anonymous home offers one way in: a labelled name field and "Start my forge" (#11237). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-start-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a visitor with no cookies sees the start form on /", async () => {
  const body = await (await fetch(`${servers.url}/`)).text();
  const form = body.match(/<form[^>]*id="start-forge"[\s\S]*?<\/form>/)?.[0] ?? "";
  expect(form).toContain('action="/forges/new"');
  expect(form).toMatch(/method="post"/i);
  expect(form).toMatch(/<label[^>]*for="start-name"/);
  expect(form).toContain('id="start-name"');
  expect(form).toContain("required");
  expect(form).toContain("Start my forge");
  expect(body).toContain("free to try");
  expect(form).toContain('autocapitalize="none"');
  expect(form).toContain('autocomplete="off"');
  expect(form).not.toContain("class=\"hint\"");
  expect(body.match(/Start my forge/g)).toHaveLength(1);
});

test("the first view has one primary button, and the first sentence is one", async () => {
  const body = await (await fetch(`${servers.url}/`)).text();
  const hero = body.slice(body.indexOf('class="door-hero"'), body.indexOf('id="made"'));
  expect(hero.match(/data-variant="primary"/g)).toHaveLength(1);
  expect(hero.match(/class="door-support"/g)).toHaveLength(1);
});

test("the form's POST without a same-origin header is refused by the door", async () => {
  const res = await fetch(`${servers.url}/forges/new`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
    body: "name=sneaky",
    redirect: "manual",
  });
  expect([400, 403]).toContain(res.status);
});
