/**
 * A board's view and its forms draw their fields as `.field` with a real
 * `<label for>`.
 */
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
  dir = await mkdtemp(join(tmpdir(), "forge-boards-view-fields-"));
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

const LABELS = ["New board", "Panel title", "Width", "Height", "Board title", "Range", "Live"];

function check(html: string, labels: string[]) {
  for (const text of labels) {
    const m = html.match(new RegExp(`<div class="field"[^>]*>\\s*<label for="([^"]+)">${text}</label>`));
    expect(m, text).not.toBeNull();
    expect(html.match(new RegExp(`id="${m![1]}"`, "g"))?.length, `${text} id is unique`).toBe(1);
  }
  const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]));
  for (const m of html.matchAll(/<label for="([^"]+)"/g)) expect(ids.has(m[1]!), m[1]).toBe(true);
}

test("the boards list draws its new-board field as .field", async () => {
  const html = await (await call("/boards")).text();
  check(html, ["New board"]);
});

test("a board's forms draw every field as .field with a unique id", async () => {
  expect((await call("/boards/new", { title: "Fields" })).status).toBe(303);
  const q = { source: "runs", aggregate: "count", column: "", by: "day", from: "", to: "", fcolumn: "state", fop: "eq", fvalue: "ok" };
  for (const title of ["one", "two"]) expect((await call("/boards/fields/add", { ...q, title, w: "1", h: "1" })).status).toBe(303);
  const html = await (await call("/boards/fields")).text();
  check(html, LABELS.slice(1));
  expect(html).toContain('id="panel-0-title"');
  expect(html).toContain('id="panel-1-title"');
  expect(html).toContain('id="panel-new-title"');
  for (const name of ["title", "w", "h", "range", "refresh"]) expect(html).toContain(`name="${name}"`);
});
