/** /agents speaks the home page's language (#9873): a section, no card, the words of /llms.txt. */
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
  dir = await mkdtemp(join(tmpdir(), "forge-agents-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("/agents has no card, keeps the form, and says what /llms.txt says", async () => {
  const res = await fetch(servers.url + "/agents");
  expect(res.status).toBe(200);
  const text = await res.text();
  const main = text.slice(text.indexOf("<main"), text.indexOf("</main>"));
  expect(main).not.toContain('class="card');
  expect(main).not.toContain("card-body");
  expect(main).toContain('<section class="stack" aria-labelledby="agent-forge-h">');
  expect(main).toMatch(/<form method="post" action="\/forges\/start"/);
  expect(main).toContain("<h2 id=\"agent-forge-h\">Get a forge of your own</h2>");
  const llms = await (await fetch(servers.url + "/llms.txt")).text();
  // Plain prose lines (letters, spaces, commas, periods) must appear verbatim on the page.
  const prose = llms.split("\n").map((l) => l.replace(/^[-*] /, "")).filter((l) => /^[A-Z][A-Za-z ,.]{20,}$/.test(l));
  expect(prose.length).toBeGreaterThan(0);
  for (const line of prose) expect(main).toContain(line);
});
