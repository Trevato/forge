/** A board's Server-Timing names its phases: session, board, grid, render (#3250). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBoard } from "../src/actions/boards.ts";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let bearer = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-board-timing-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
  const w = await writeBoard(app, made.value, "ops", {
    title: "Ops", range: "all", refresh: "off",
    panels: [{ title: "Runs", chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 }],
  });
  if (!w.ok) throw new Error(JSON.stringify(w.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(servers.url + path, { headers: { authorization: `Bearer ${bearer}` } });

test("a board names session, picture, grid and render once each", async () => {
  const res = await get("/boards/ops");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Runs");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  for (const n of ["session", "picture", "grid", "render"]) {
    expect(names.filter((x) => x === n).length).toBe(1);
    const part = parts.find((p) => p.startsWith(`${n};`))!;
    expect(Number(/dur=([\d.]+)/.exec(part)?.[1])).not.toBeNaN();
  }
});

test("a missing board is still a 404", async () => {
  expect((await get("/boards/nope")).status).toBe(404);
});
