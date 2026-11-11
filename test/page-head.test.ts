import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createUser } from "../src/core/users.ts";
import { seedPacks } from "./helpers/packs.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { appLine, plainDescription, repoLine } from "../src/web/describe.ts";

const content = (html: string, re: RegExp): string => html.match(re)?.[1]?.trim() ?? "";

describe("every public page names itself for a link preview", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pagehead-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    await seedPacks(app);
    // No description at all, and one that is scaffold jargon.
    for (const name of ["bare", "widget"]) {
      const made = await createRepo(app, u.value, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
    }
    app.db.query("UPDATE repo SET description = 'TODO' WHERE name = 'widget'").run();
    const bareId = getRepo(app.db, "alice", "bare")!.id;
    const widgetId = getRepo(app.db, "alice", "widget")!.id;
    const rec = createAppRecord(app.db, { repoId: widgetId, slug: "widget", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    for (const kind of ["issue", "pull"] as const) {
      const i = createIssue(app.db, { repoId: bareId, authorId: u.value.id, title: `A ${kind}`, kind });
      if (!i.ok) throw new Error(String(i.error));
      if (kind === "pull")
        app.db
          .query(
            `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
             VALUES (?1, 'main', 'topic', '', '', ?2)`,
          )
          .run(i.value.id, bareId);
    }
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const paths = [
    "/",
    "/explore",
    "/alice",
    "/alice/bare",
    "/alice/widget",
    // The app page: /alice/widget/app only redirects here.
    "/alice/bare/issues/1",
    "/alice/bare/pulls/2",
    "/packs",
    "/changelog",
    "/contribute",
  ];

  for (const path of paths) {
    test(`${path} has a title, description, og tags and canonical`, async () => {
      const res = await fetch(base + path, { redirect: "manual" });
      expect(res.status).toBe(200);
      const h = await res.text();
      const found: Record<string, string> = {
        title: content(h, /<title>([^<]*)<\/title>/),
        description: content(h, /<meta\s+name="description"\s+content="([^"]*)"/),
        "og:title": content(h, /<meta\s+property="og:title"\s+content="([^"]*)"/),
        "og:description": content(h, /<meta\s+property="og:description"\s+content="([^"]*)"/),
        "og:image": content(h, /<meta\s+property="og:image"\s+content="([^"]*)"/),
        canonical: content(h, /<link\s+rel="canonical"\s+href="([^"]*)"/),
      };
      for (const [name, value] of Object.entries(found)) expect(`${name}=${value}`).not.toBe(`${name}=`);
      expect(found.description).not.toMatch(/ · live\.$/);
      expect(found["og:description"]).not.toMatch(/ · live\.$/);
    });
  }

  test("a pack page is covered too", async () => {
    const packs = await (await fetch(base + "/packs")).text();
    const first = packs.match(/href="(\/packs\/[^"]+)"/)?.[1];
    expect(first).toBeTruthy();
    const h = await (await fetch(base + first!)).text();
    expect(content(h, /<link\s+rel="canonical"\s+href="([^"]*)"/)).toContain(first!);
    expect(content(h, /<meta\s+name="description"\s+content="([^"]*)"/)).not.toBe("");
  });

  test("an empty or jargon description gets a plain sentence", async () => {
    for (const path of ["/alice/bare", "/alice/widget"]) {
      const h = await (await fetch(base + path)).text();
      const d = content(h, /<meta\s+name="description"\s+content="([^"]*)"/);
      expect(d).toMatch(path.endsWith("bare") ? /^bare is a project on the forge: /
        : /^widget is an app you can try and make your own\. Status: /);
    }
  });
});

describe("description sentences", () => {
  test("empty and jargon fall back", () => {
    expect(plainDescription("", "Plain.")).toBe("Plain.");
    expect(plainDescription("  \n", "Plain.")).toBe("Plain.");
    expect(plainDescription("TODO", "Plain.")).toBe("Plain.");
    expect(plainDescription("A notes app", "Plain.")).toBe("A notes app");
    expect(plainDescription("A todo app", "Plain.")).toBe("A todo app");
    expect(plainDescription("Wip tracker", "Plain.")).toBe("Wip tracker");
    expect(plainDescription("Scaffolded.", "Plain.")).toBe("Plain.");
    expect(repoLine({ private: false, name: "x", description: "" })).toMatch(/^x is a project/);
  });
  test("an app line never ends in ' · live.'", () => {
    const line = appLine({ private: false, name: "x", description: "Notes", state: "live" });
    expect(line).toBe("Notes. Status: live.");
    expect(line).not.toMatch(/ · live\.$/);
  });
});
