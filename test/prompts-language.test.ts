/**
 * Settings › Prompts speaks the home page's language: one heading, the source
 * as a plain row, the add form on the page, no boxed cards.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addPromptSource } from "../src/core/prompts.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("settings prompts language", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";
  let repoId = "";
  const PAGE = "/olive/proj/settings/prompts";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-prompts-language-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "prompts-language-password" });
    await fetch(`${servers.url}/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "proj", visibility: "private", description: "" }),
      redirect: "manual",
    });
    repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo").get()!.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const main = async () => {
    const text = await (await fetch(`${servers.url}${PAGE}`, { headers: { cookie } })).text();
    const start = text.indexOf("<main");
    return text.slice(start, text.indexOf("</main>", start));
  };

  function plain(m: string) {
    expect(m.match(/<h1[ >]/g)?.length).toBe(1);
    expect(m).not.toContain('class="card');
    expect(m).not.toContain("card-body");
  }

  test("with no source: the sentence and the add form", async () => {
    const m = await main();
    plain(m);
    expect(m).toContain(`action="${PAGE}"`);
    expect(m).toContain('name="token"');
    expect(m).not.toContain("Fetch now");
  });

  test("with a source: its row, run and delete, no add form", async () => {
    const added = addPromptSource(app.db, dataDir, { repoId, kind: "instagram", token: "IGAAQtoken-for-language-test", atUtc: "15:00" });
    if (!added.ok) throw new Error(added.error);
    const id = added.value.id;
    const m = await main();
    plain(m);
    expect(m).toContain(`action="${PAGE}/${id}/run"`);
    expect(m).toContain(encodeURIComponent(`${PAGE}/${id}/delete`));
    expect(m).not.toContain(`action="${PAGE}"`);
  });
});
