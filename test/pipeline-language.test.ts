/** /pipeline speaks the home page's language (#9835): one heading, four plain sections, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";
import { STEPS } from "../src/flow/path.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-pipeline-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("/pipeline signed out has one h1, a heading per step and no card", async () => {
  const res = await fetch(servers.url + "/pipeline");
  expect(res.status).toBe(200);
  const page = await res.text();
  const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
  expect(main.match(/<h1[ >]/g)?.length).toBe(1);
  expect(main).not.toContain('class="card');
  expect(main).not.toContain("card-body");
  for (const s of STEPS) expect(main).toMatch(new RegExp(`<h2>\\d\\. ${s.charAt(0).toUpperCase()}${s.slice(1)}</h2>`));
  expect(main).toContain('href="/boards"');
});
