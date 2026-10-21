/**
 * The browse and org pages' filter bars are drawn with §5's `.bar`, not the
 * page-local `.filters`: the words, links and forms stay, the old name goes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrg } from "../src/actions/orgs.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the org page's filter bar uses §5's bar", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-filters-markup-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const org = createOrg(app, made.value, "acme");
    if (!org.ok) throw new Error(String(org.error));
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: org.value.id,
      name: "svc",
      visibility: "public",
    });
    if (!repo.ok) throw new Error(String(repo.error));
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the org page's filter is a bar with the same GET form", async () => {
    const page = await (await fetch(`${base}/acme`)).text();
    expect(page).not.toMatch(/class="[^"]*\bfilters\b/);
    expect(page).toContain('class="bar mt mb"');
    expect(page).toMatch(
      /<form class="bar" method="get" action="\/acme" role="search">/,
    );
    expect(page).toContain('name="q"');
    expect(page).toContain("Find a repository");
    expect(page).toContain(">Filter<");
  });
});
