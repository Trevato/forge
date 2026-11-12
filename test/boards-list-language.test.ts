/** /boards and a board's management speak the home page's language (#9815): headings and rows, no card boxes around them. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let token: string;
const call = (path: string, fields?: Record<string, string>) =>
  fetch(servers.url + path, {
    redirect: "manual",
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
    headers: { authorization: `Bearer ${token}` },
  });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-boards-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  token = createToken(app.db, r.value.id, "t", "admin").token;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** The page's own sections: the ones the issue names, up to the flow panel and held card. */
const block = (html: string, id: string) => {
  const at = html.indexOf(`id="${id}"`);
  expect(at, id).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
};

test("/boards with no board: a heading, one plain sentence, the form under its own heading", async () => {
  const html = await (await call("/boards")).text();
  const all = block(html, "boards-all");
  expect(all).toContain("<h2>Your boards</h2>");
  expect(all).toContain("A board is a page of charts");
  expect(all).not.toContain("card");
  expect(block(html, "boards-new")).toContain("<h2>Make a board</h2>");
  expect(block(html, "boards-new")).not.toContain("card");
});

test("/boards with a board: one row under the heading, the name escaped, no card", async () => {
  expect((await call("/boards/new", { title: "<b>Mine</b>" })).status).toBe(303);
  const html = await (await call("/boards")).text();
  const all = block(html, "boards-all");
  expect(all).toContain("<h2>Your boards</h2>");
  expect(all).toContain("&lt;b&gt;Mine&lt;/b&gt;");
  expect(all).not.toContain("<b>Mine");
  expect(all.match(/<li/g)?.length).toBe(1);
  expect(all).not.toContain("card");
  expect(all).not.toContain("A board is a page of charts");
});

test("a board's management is sections with headings; its panels keep their cards", async () => {
  const slug = (await (await call("/boards")).text()).match(/<li[^>]*>\s*<a[^>]*href="\/boards\/([^"]+)"/)![1]!;
  const q = { source: "runs", aggregate: "count", column: "", by: "day", from: "", to: "", fcolumn: "state", fop: "eq", fvalue: "ok" };
  expect((await call(`/boards/${slug}/add`, { ...q, title: "P", w: "1", h: "1" })).status).toBe(303);
  const html = await (await call(`/boards/${slug}`)).text();
  expect(html).toContain('class="card bp-w1');
  for (const [id, h] of [["board-panels", "Panels"], ["board-add", "Add a panel"], ["board-manage", "Board"]] as const) {
    const b = block(html, id);
    expect(b).toContain(`<h2>${h}</h2>`);
    expect(b).not.toContain('class="card');
  }
});
