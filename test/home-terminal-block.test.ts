/** The feed home's Terminal is a plain block: heading and command, no card (#10005). */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { sshCommand } from "../src/ssh/command.ts";
import { adminCookie } from "./helpers/admin.ts";

let dirs: string[] = [];
async function boot(sshPort?: number) {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-home-term-"));
  dirs.push(dataDir);
  const app: App = createApp({ dataDir, port: 0, host: "forge.example" });
  if (sshPort !== undefined) app.config.sshPort = sshPort;
  const servers: Servers = await serve(app);
  const cookie = await adminCookie(app, { username: "ada", email: "ada@forge.example", password: "analytical-engine" });
  const page = async () => {
    const t = await (await fetch(`${servers.url}/feed`, { headers: { cookie } })).text();
    return t.slice(t.indexOf("<main"), t.indexOf("</main>"));
  };
  return { app, servers, page };
}
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

test("terminal on: heading, exact command and keys link, no card", async () => {
  const { app, servers, page } = await boot(2222);
  try {
    const m = await page();
    const at = m.indexOf("<h2>Terminal</h2>");
    expect(at).toBeGreaterThan(0);
    const block = m.slice(m.lastIndexOf("<section", at), m.indexOf("</section>", at));
    expect(block).toContain(sshCommand(app)!);
    expect(block).toContain('href="/settings/keys"');
    expect(block).not.toContain('class="card');
  } finally {
    servers.stop();
    app.close();
  }
});

test("terminal off: no Terminal heading", async () => {
  const { app, servers, page } = await boot();
  try {
    expect(await page()).not.toContain("<h2>Terminal</h2>");
  } finally {
    servers.stop();
    app.close();
  }
});
