/**
 * A label made without a name or a six-digit colour reads the same from every
 * door, because every door reads it from src/actions/label_words.ts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LABEL_WORDS } from "../src/actions/label_words.ts";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { importsFrom, mcpSource } from "./helpers/mcp.ts";

describe("a label's shape refusal", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-label-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "label-words-password" });
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "proj", visibility: "private", description: "" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the settings form answers the module's sentence for a nameless label", async () => {
    const refused = await fetch(`${base}/olive/proj/settings/labels`, {
      method: "POST",
      headers: { cookie },
      body: form({ name: "  ", color: "d73a4a" }),
      redirect: "manual",
    });
    expect(refused.status).toBe(303);
    const flash = refused.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const shown = await (
      await fetch(new URL(refused.headers.get("location")!, base), { headers: { cookie: `${cookie}; ${flash}` } })
    ).text();
    expect(shown).toContain(LABEL_WORDS.shape);
  });

  // MCP `repo_labels` checks the name and colour itself before createLabel can
  // answer "invalid", so its branch is held to the module by reading the door.
  test("MCP repo_labels reads the sentence from the module", async () => {
    const source = mcpSource(join(import.meta.dir, ".."));
    expect(importsFrom(source, "actions/label_words.ts")).toBe(true);
    expect(source).toContain("LABEL_WORDS.shape");
  });

  test("no file under src/ but the module types the sentence out", async () => {
    const root = join(import.meta.dir, "../src");
    const holders: string[] = [];
    for (const entry of await readdir(root, { recursive: true })) {
      if (!entry.endsWith(".ts")) continue;
      if ((await Bun.file(join(root, entry)).text()).includes(LABEL_WORDS.shape)) holders.push(entry);
    }
    expect(holders).toEqual([join("actions", "label_words.ts")]);
  });
});
