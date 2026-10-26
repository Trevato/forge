/** A directory of 1,200 entries lists 300 and links to the rest (#6168). */

import { describe, expect, test } from "bun:test";
import { afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { treeListing } from "../src/web/pages/repo.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const entries = [
  ...Array.from({ length: 1100 }, (_, i) => ({
    mode: "100644",
    type: "blob",
    sha: "b".repeat(40),
    size: 100,
    name: `f${String(i).padStart(4, "0")}.ts`,
  })),
  ...Array.from({ length: 100 }, (_, i) => ({
    mode: "040000",
    type: "tree",
    sha: "a".repeat(40),
    size: -1,
    name: `d${String(i).padStart(3, "0")}`,
  })),
];

describe("tree window", () => {
  const page = treeListing("/o/r", "main", "test", entries as never).text;
  test("directories first, a labelled link to the rest, a footer that agrees", () => {
    expect(page).toContain('href="/o/r/tree/main/test/d099"');
    expect(page).toContain('href="/o/r/blob/main/test/f0199.ts"');
    expect(page).not.toContain("f0200.ts");
    expect(page).toContain("Show all 1,200 entries");
    expect(page).toContain('href="/o/r/tree/main/test?all=1"');
    expect(page).toMatch(/Showing 300 of\s+1,200 entries/);
    expect(page.length).toBeLessThan(300 * 1024);
  });
  test("all=1 lists everything and no link", () => {
    const all = treeListing("/o/r", "main", "test", entries as never, true).text;
    expect(all).toContain('href="/o/r/blob/main/test/f1099.ts"');
    expect(all).not.toContain("?all=1");
    expect(all).not.toContain("Showing");
  });
});

describe("through a request", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-tree-window-"));
    app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    proveAll(app);
    const made = await newApp(app, { id: u.value.id, username: "alice" } as never, {
      name: "big",
      description: "x",
      visibility: "public",
    });
    if (!made.ok) throw new Error(made.error);
    const repo = getRepo(app.db, "alice", "big");
    const files = Array.from({ length: 1200 }, (_, i) => ({
      path: `test/case-${String(i).padStart(4, "0")}.ts`,
      content: "x",
    }));
    const done = await commitToBranch(app, u.value, repo!, { files });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    servers = await serve(app);
  });
  afterAll(() => {
    servers.stop();
    app.close();
    rmSync(root, { recursive: true, force: true });
  });
  const get = async (q: string) =>
    (await fetch(`${servers.url}/alice/big/tree/main/test${q}`)).text();

  test("the whole page, side column included, stays under 300 KB", async () => {
    const page = await get("");
    expect(page.length).toBeLessThan(300 * 1024);
    expect(page).toContain("case-0299.ts");
    expect(page).not.toContain("case-0300.ts");
    expect(page).toContain("Show all 1,200 entries");
  });
  test("?all=1 lists all 1,200 in the main listing", async () => {
    const page = await get("?all=1");
    expect(page).toContain("case-1199.ts");
    expect(page).toContain("case-0300.ts");
  });
  test("the side column's lazy fragment is windowed too", async () => {
    const frag = await get("?fragment=explorer");
    expect(frag).toContain("case-0099.ts");
    expect(frag).not.toContain("case-0100.ts");
    expect(frag).toContain("Show all 1,200 entries");
  });
});
