/** /search speaks the home page's language (#9862): headings over rows, no boxes. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let bearer = "";
const headers = () => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" });
const post = (path: string, body: unknown) =>
  fetch(servers.url + path, { method: "POST", headers: headers(), body: JSON.stringify(body) });
const get = async (path: string) => (await fetch(servers.url + path, { headers: headers() })).text();
const main = (h: string) => h.slice(h.indexOf("<main"), h.indexOf("</main>"));

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-language-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
  await post("/api/v1/repos", { name: "zephyr", visibility: "public", description: "a zephyr thing" });
  await post("/api/v1/repos/alice/zephyr/contents", {
    branch: "main", message: "first", files: [{ path: "src/z.ts", content: "export const zephyr = 1;\n" }],
  });
  await post("/api/v1/repos/alice/zephyr/issues", { title: "zephyr is slow", body: "" });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("results are sections of rows with no card", async () => {
  const html = main(await get("/search?q=zephyr"));
  expect(html).not.toContain('class="card');
  const h2 = (html.match(/<h2[ >]/g) ?? []).length;
  expect(h2).toBe(3);
  expect((html.match(/<section[ >]/g) ?? []).length).toBe(h2);
  expect(html).toContain('<ul class="list">');
});

test("an empty query and no results are one plain sentence", async () => {
  for (const path of ["/search?q=", "/search?q=qqqnothingqqq"]) {
    const html = main(await get(path));
    expect(html).not.toContain('class="card');
    expect(html).toContain('<p class="muted">');
  }
});
