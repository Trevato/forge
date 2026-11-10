/**
 * The palette's tell target costs a repository read only where the first path
 * segment can be an owner (#5885): the forge's own pages never pay it, so a
 * new top-level route that is left off the list shows up here as a read.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("the tell target's repository read", () => {
  let dataDir: string;
  let app: App;
  let cookie = "";
  let reads = 0;
  let http: ForgeHttp;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-palette-gate-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "keeper",
      email: "keeper@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    http = forgeHttp(app);
    cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
    // Count the by-name repository row, the one `getRepo` issues; `repoVisibility` reads one column, not the row.
    const query = app.db.query.bind(app.db) as (sql: string) => unknown;
    (app.db as { query: unknown }).query = (sql: string) => {
      if (sql.includes("SELECT repo.*") && sql.includes("user.username = ?1 COLLATE NOCASE AND repo.name = ?2")) reads++;
      return query(sql);
    };
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = async (path: string): Promise<string> => {
    reads = 0;
    const res = await http.handle(new Request(`http://localhost${path}`, { headers: { cookie } }));
    return res.text();
  };

  test("the forge's own two-segment pages read no repository for the target", async () => {
    for (const path of ["/settings/origins", "/settings/tokens", "/settings/keys"]) {
      const html = await get(path);
      expect(html).toContain(`"tell":{"app":"forge"}`);
      expect(reads).toBe(0);
    }
  });

  test("a path that can be an owner and a name costs the target one read, which signed out it does not", async () => {
    await get("/nobody/nothing");
    const signedIn = reads;
    reads = 0;
    await http.handle(new Request("http://localhost/nobody/nothing"));
    expect(signedIn).toBe(reads + 1);
  });
});
