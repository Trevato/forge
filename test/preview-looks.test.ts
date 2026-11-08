/**
 * The Later gate's proposal in every preview (#9212): the owner looks include
 * the held page at desk and phone, and the seeded page draws exactly
 * THEMES_AT_REST theme lines and one fold line at rest.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { PREVIEW_SETTINGS_PAGES, PREVIEW_HELD_PAGE, PREVIEW_HELD_THEMES, PREVIEW_OWNER_LOOKS, ownerLooksFor, PREVIEW_ADMIN, PREVIEW_REPO } from "../src/spawn/preview-looks.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";
import { listTokens } from "../src/core/tokens.ts";
import { createSession } from "../src/core/sessions.ts";
import { forgeHttp } from "../src/http/server.ts";
import { THEMES_AT_REST } from "../src/web/pages/gate.ts";
import { reviewGate } from "../src/actions/gate_review.ts";
import { serve, type Servers } from "../src/http/server.ts";

test("the owner looks for a forge preview include the held page at both widths", () => {
  const looks = ownerLooksFor("trevato/forge", { ownerName: "trevato", name: "forge" }, "preview");
  expect(PREVIEW_HELD_PAGE).toBe("/preview-admin/sample/held");
  for (const kind of ["desktop", "phone"] as const)
    expect(looks).toContainEqual({ page: PREVIEW_HELD_PAGE, kind });
  expect(PREVIEW_HELD_THEMES.length).toBeGreaterThan(THEMES_AT_REST);
});

describe("the seeded held page", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-preview-held-"));
    app = createApp({ dataDir: dir, port: 0 });
    const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
    if (!seeded.ok) throw new Error(seeded.error);
    servers = await serve(app);
  }, 60_000);
  afterAll(async () => {
    await servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("draws THEMES_AT_REST theme lines and one fold line at rest", async () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    const review = reviewGate(app, repo)!;
    expect(review.themes.length).toBe(PREVIEW_HELD_THEMES.length);
    expect(review.themes.map((t) => t.name)).not.toContain("Other");
    const res = await fetch(`${servers.url}${PREVIEW_HELD_PAGE}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const fold = `${PREVIEW_HELD_THEMES.length - THEMES_AT_REST} more themes`;
    expect(html.split(fold).length - 1).toBe(1);
    // Outside the fold: one disclosure per theme at rest.
    const rest = html.slice(0, html.indexOf(fold));
    const shown = review.themes.slice(0, THEMES_AT_REST);
    for (const t of shown) expect(rest).toContain(t.name);
    for (const t of review.themes.slice(THEMES_AT_REST)) expect(rest).not.toContain(`${t.name} <`);
  });
});

describe("the seeded first issue", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-preview-issue-"));
    app = createApp({ dataDir: dir, port: 0 });
    const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
    if (!seeded.ok) throw new Error(seeded.error);
    servers = await serve(app);
  }, 60_000);
  afterAll(async () => {
    await servers.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test("its page carries a Runs row and a Closes with row, and a second seed adds none", async () => {
    const count = () =>
      (app.db.query("SELECT COUNT(*) AS n FROM run").get() as { n: number }).n;
    const before = count();
    const again = await seedPreview(app, { FORGE_APP_ENV: "preview" });
    expect(again.ok && again.value.seeded).toBe(false);
    expect(count()).toBe(before);
    const res = await fetch(`${servers.url}/preview-admin/sample/issues/1`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h2>Runs</h2>");
    expect(html).toContain("<h2>Closes with</h2>");
    expect(html).toContain("A seeded run");
  });
});

describe("the owner's settings pages (#9781)", () => {
  const pages = ["/settings/tokens", "/settings/crew", "/settings/subscriptions", "/settings/usage"];
  test("each is named at desk and phone", () => {
    for (const page of pages)
      for (const kind of ["desktop", "phone"] as const)
        expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page, kind });
  });

  test("the seed gives each a row and answers 200 to the owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-preview-settings-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
      if (!seeded.ok) throw new Error(seeded.error);
      const admin = previewAdmin(app)!;
      const cookie = `forge_session=${createSession(app.db, admin.id).token}`;
      const http = forgeHttp(app);
      const get = async (p: string) => {
        const res = await http.handle(new Request(`http://localhost${p}`, { headers: { cookie } }));
        expect(res.status).toBe(200);
        return res.text();
      };
      expect(await get("/settings/tokens")).toContain("preview fake token");
      expect(await get("/settings/crew")).toContain("preview-agent");
      expect(await get("/settings/subscriptions")).toContain("preview sample");
      await get("/settings/usage");
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a named page that is not 200 refuses the seed, naming the path, and a retry adds no second token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-preview-refuse-"));
    const app = createApp({ dataDir: dir, port: 0 });
    const pages = PREVIEW_SETTINGS_PAGES as string[];
    pages.push("/settings/no-such-page");
    try {
      const refused = await seedPreview(app, { FORGE_APP_ENV: "preview" });
      expect(!refused.ok && refused.error).toContain("/settings/no-such-page");
      await seedPreview(app, { FORGE_APP_ENV: "preview" });
      const admin = previewAdmin(app)!;
      expect(listTokens(app.db, admin.id).length).toBe(1);
    } finally {
      pages.pop();
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a preview already seeded gets its settings rows once, and a second seed adds no token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-preview-older-"));
    const app = createApp({ dataDir: dir, port: 0 });
    try {
      const first = await seedPreview(app, { FORGE_APP_ENV: "preview" });
      if (!first.ok) throw new Error(first.error);
      const admin = previewAdmin(app)!;
      // An older preview: world seeded, settings rows not.
      app.db.query("DELETE FROM token WHERE user_id = ?1").run(admin.id);
      app.db.query("DELETE FROM user_setting WHERE user_id = ?1 AND key = 'preview_settings_seeded'").run(admin.id);
      expect(listTokens(app.db, admin.id).length).toBe(0);
      const again = await seedPreview(app, { FORGE_APP_ENV: "preview" });
      expect(again.ok && again.value.seeded).toBe(false);
      expect(listTokens(app.db, admin.id).map((t) => t.name)).toEqual(["preview fake token, not a credential"]);
      await seedPreview(app, { FORGE_APP_ENV: "preview" });
      expect(listTokens(app.db, admin.id).length).toBe(1);
    } finally {
      app.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
