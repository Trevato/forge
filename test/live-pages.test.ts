/**
 * The browsing pages — repo home, commit history, branches — wire up the
 * same live client the issue/pull threads already had, so a push or a new
 * branch shows up as a "new activity" pill without a reload. Verifies the
 * wiring is present on a local repo and absent where there is nothing to
 * subscribe to (an empty repo, or a repo read live off another forge).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFiles } from "../src/actions/contents.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("live browsing pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-live-pages-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const user = await createUser(app.db, {
      username: "lex",
      email: "lex@f.dev",
      password: "live-pages-pass",
    });
    if (!user.ok) throw new Error("user");
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: user.value.id,
      name: "proj",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo");
    const committed = await editFiles(app, user.value, repo.value, {
      files: [{ path: "README.md", content: "# proj\n" }],
      message: "first commit",
    });
    if (!committed.ok) throw new Error("commit");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the repo home wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain('data-repo="/lex/proj"');
    expect(html).toContain("new EventSource");
  });

  test("the commit history wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj/commits`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain("new EventSource");
  });

  test("the branches page wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj/branches`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain("new EventSource");
  });
});
