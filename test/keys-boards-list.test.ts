/** /boards: each board is a keyboard row (`data-nav`), so j/k move and Enter opens it. */
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
  dir = await mkdtemp(join(tmpdir(), "forge-keys-boards-"));
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

const listed = async () => {
  const html = await (await call("/boards")).text();
  const at = html.indexOf('id="boards-all"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
};

test("no boards: the list has no data-nav", async () => {
  expect(await listed()).not.toContain("data-nav");
});

test("each board is one data-nav row linking to its own page", async () => {
  for (const title of ["Alpha", "Beta"]) expect((await call("/boards/new", { title })).status).toBe(303);
  const all = await listed();
  expect(all.match(/data-nav tabindex="-1"/g)?.length).toBe(2);
  const links = [...all.matchAll(/<a href="(\/boards\/[^"]+)"[^>]*data-nav/g)].map((m) => m[1]);
  expect(links).toEqual(["/boards/alpha", "/boards/beta"]);
});
