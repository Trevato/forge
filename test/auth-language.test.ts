/** /signin and /signup speak the home page's language (#9812): one heading, the form on the page, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-auth-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

for (const [path, heading, action] of [
  ["/signin", "Sign in", 'action="/signin"'],
  ["/signup", "Create your account", 'action="/signup"'],
] as const) {
  test(`${path} signed out is one heading and the form, with no card`, async () => {
    const res = await fetch(servers.url + path);
    expect(res.status).toBe(200);
    const page = main(await res.text());
    expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
    expect(page).toContain(heading);
    expect(page).toContain(`<form method="post" ${action}`);
    expect(page).not.toContain('class="card');
    expect(page).not.toContain("card-body");
  });
}
