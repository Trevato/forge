/** /search's Server-Timing names its phases: session, search, apps, render (#3274). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let bearer = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-search-timing-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const get = (path: string) => fetch(servers.url + path, { headers: { authorization: `Bearer ${bearer}` } });

const phases = (res: Response) =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);

test("a search names session, repos, issues, code, apps and render once each, with durations", async () => {
  const res = await get("/search?q=forge");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Results for");
  const header = res.headers.get("server-timing") ?? "";
  for (const n of ["session", "repos", "issues", "code", "apps", "render"]) {
    expect(phases(res).filter((x) => x === n).length).toBe(1);
    const part = header.split(", ").find((p) => p.startsWith(`${n};`))!;
    expect(Number(/dur=([\d.]+)/.exec(part)?.[1])).not.toBeNaN();
  }
});

test("the empty search names session and render", async () => {
  const res = await get("/search");
  expect(res.status).toBe(200);
  expect(phases(res)).toEqual(expect.arrayContaining(["session", "render"]));
});
