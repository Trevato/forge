import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-iss-pull-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const user = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "pat",
    email: "pat@f.dev",
    password: "pull-number-pass",
  });
  if (!user.ok) throw new Error("user");
  for (const [name, visibility] of [
    ["open", "public"],
    ["shut", "private"],
  ] as const) {
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: user.value.id,
      name,
      visibility,
    });
    if (!repo.ok) throw new Error("repo");
    for (const [title, kind] of [
      ["an issue", "issue"],
      ["a pull", "pull"],
    ] as const)
      createIssue(app.db, {
        repoId: repo.value.id,
        authorId: user.value.id,
        title,
        kind,
      });
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const read = (path: string) => fetch(`${servers.url}/api/v1/repos/pat/${path}`);

test("a pull's number read through issues answers with the pull, kind pull", async () => {
  const res = await read("open/issues/2");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.kind).toBe("pull");
  expect(body.title).toBe("a pull");
  expect(body.pull).toBe("/api/v1/repos/pat/open/pulls/2");
  expect(Array.isArray(body.comments)).toBe(true);
});

test("an issue's number still answers kind issue, with no pull field", async () => {
  const body = (await (await read("open/issues/1")).json()) as Record<string, unknown>;
  expect(body.kind).toBe("issue");
  expect("pull" in body).toBe(false);
});

test("a pull the caller cannot see is still not_found", async () => {
  expect((await read("shut/issues/2")).status).toBe(404);
});
