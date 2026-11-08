/** Settings › Traffic › Scrapes is headings over rows, not cards (#9807). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { captureStore } from "../src/perf/live.ts";
import { parseNetworks, saveNetworks } from "../src/perf/network.ts";

let dataDir = "";
let app: App;
let servers: Servers;
let cookie = "";
const url = () => `${servers.url}/settings/traffic/scrapes`;
const main = async (query = ""): Promise<string> => {
  const text = await (await fetch(`${url()}${query}`, { headers: { cookie } })).text();
  return text.slice(text.indexOf("<main"), text.indexOf("</main>"));
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-scrapes-blocks-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "keeper", email: "keeper@forge.local", password: "correct-horse-battery", isAdmin: true });
  if (!made.ok) throw new Error(made.error);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
});
afterAll(async () => {
  captureStore.stop();
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const HEADINGS = ["What was read", "Who it is", "One actor across addresses", "Networks on file"];

/** The `<section>` that holds `<h2>name</h2>`, from its opening tag to its close. */
function block(html: string, name: string): string {
  const at = html.indexOf(`<h2>${name}</h2>`);
  expect(at).toBeGreaterThan(-1);
  const open = html.lastIndexOf("<section", at);
  expect(html.slice(open, at)).toMatch(/^<section class="settings-block">\s*$/);
  return html.slice(open, html.indexOf("</section>", at));
}

test("with nothing recorded, each part is a headed block and each empty state one plain sentence", async () => {
  const html = await main();
  for (const h of HEADINGS) block(html, h);
  expect(block(html, "What was read")).toContain("No file reads recorded in this window");
  expect(block(html, "Who it is")).toContain("No address prefixes in the last 24 hours.");
  for (const boxed of ['class="card', "card-head", "card-body", 'class="empty']) expect(html).not.toContain(boxed);
});

test("an admin with one capture group and one network on file sees four headed blocks and no card", async () => {
  const got = parseNetworks("203.0.0.0/16, <b>Evil</b> Hosting, Op, DE, abuse@op.example");
  saveNetworks(app.db, got.rows, "keeper", Date.now());
  captureStore.start(Date.now(), "keeper");
  for (let i = 0; i < 6; i++)
    captureStore.note(Date.now(), {
      request: new Request(`http://forge.test/alice/open/blob/main/f${i}.ts`, { headers: { "user-agent": "<i>ScrapeBot</i>" } }),
      address: `203.0.113.${i}`,
      viaEdge: true,
      status: 200,
      ms: 5,
      cls: "deep",
      pattern: "/:owner/:name/blob/:ref/*",
    });
  const html = await main();
  for (const h of HEADINGS) block(html, h);
  const actors = block(html, "One actor across addresses");
  expect(actors).toContain('<div class="table-scroll"><table class="table" data-dense>');
  expect(actors).toContain("Groups of requests that look alike");
  expect(actors).toContain("Stop and delete it");
  expect(actors).toContain(`action="/settings/traffic/scrapes/stop"`);
  expect(actors).toContain("&lt;i&gt;ScrapeBot&lt;/i&gt;");
  expect(actors).not.toContain("<i>ScrapeBot</i>");
  const networks = block(html, "Networks on file");
  expect(networks).toContain("1 ranges.");
  expect(networks).toContain(`action="/settings/traffic/scrapes/networks"`);
  expect(networks).toContain('maxlength="200000"');
  expect(html).not.toContain('class="card');

  const id = /group=([0-9a-f]{8})/.exec(html)?.[1];
  expect(id).toBeDefined();
  const detail = await main(`?group=${id}`);
  const picked = block(detail, "One actor across addresses");
  expect(picked).toContain(`<h3 id="group">Group ${id}</h3>`);
  expect(picked).toContain(`Requests behind group ${id}`);
  expect(picked).toContain("&lt;b&gt;Evil&lt;/b&gt;");
  expect(detail).not.toContain("<b>Evil</b>");
  expect(detail).not.toContain('class="card');
});
