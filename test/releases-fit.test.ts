/**
 * The releases page fits a 390 px phone (#9350): seeded long content (a
 * 300-character unbroken hold reason, many release rows) ships no fixed width
 * over 390 px, the free text wraps anywhere, and the releases are a list of
 * rows, not a table.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { markVerified } from "../src/core/verify.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { holdAs } from "../src/keeper/hold.ts";
import { recordRelease } from "../src/release/record.ts";
import { utilities as base } from "../src/web/style/base.ts";
import { components } from "../src/web/style/components.ts";
import { content } from "../src/web/style/content.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

const WORD = "R".repeat(300);
let root = "";
let app: App;
let servers: Servers;
let page = "";
const was = process.env["FORGE_COMMIT"];

beforeAll(async () => {
  process.env["FORGE_COMMIT"] = "a".repeat(40);
  root = mkdtempSync(join(tmpdir(), "forge-releases-fit-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  app.db.query("INSERT INTO user (id, username, email, password_hash, is_admin) VALUES ('u-alice', 'alice', 'a@forge.local', 'x', 1)").run();
  markVerified(app.db, "u-alice", new Date().toISOString());
  const made = await createRepo(app, { id: "u-alice", username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='forge'").get()!.id;
  for (let i = 0; i < 30; i++)
    recordRelease(app.db, { sha: (i === 0 ? "a" : i.toString(16).padStart(2, "0")).repeat(i === 0 ? 40 : 20).slice(0, 40), repoId, pullNumber: i, ok: i % 5 !== 0, line: WORD });
  const user = { id: "u-alice", username: "alice", isAdmin: true } as never;
  holdAs(app, user, WORD);
  servers = await serve(app);
  const cookie = `forge_session=${createSession(app.db, "u-alice").token}`;
  page = await (await fetch(`${servers.url}/releases`, { headers: { cookie } })).text();
}, 60_000);
afterAll(() => {
  if (was === undefined) delete process.env["FORGE_COMMIT"];
  else process.env["FORGE_COMMIT"] = was;
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("the releases page at 390 px", () => {
  test("the long content is on the page, in many rows", () => {
    expect(page).toContain(WORD);
    expect(page.match(/<li\b/g)?.length ?? 0).toBeGreaterThanOrEqual(15);
  });

  test("no inline width and no shipped rule fixes a width over 390 px", () => {
    expect(page).not.toMatch(/style="[^"]*(?:^|[;\s])(?:min-|max-)?width\s*:/i);
    for (const m of page.matchAll(/\swidth=["']?(\d+)/gi)) expect(Number(m[1])).toBeLessThanOrEqual(390);
    const over: string[] = [];
    for (const css of [base, components, content, ...(page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? [])]) {
      for (const m of css.matchAll(/(?<![-\w(])(?:min-)?width\s*:\s*(-?[\d.]+)(px|rem|em|ch)\b/g)) {
        if (Number(m[1]) * (m[2] === "px" ? 1 : m[2] === "ch" ? 8 : 16) > 390) over.push(m[0]);
      }
    }
    expect(over).toEqual([]);
  });

  test("the long-text container wraps anywhere", () => {
    expect(page).toContain("data-releases");
    const css = (page.match(/<style[^>]*>[\s\S]*?<\/style>/g) ?? []).join("\n");
    expect(css).toMatch(/\[data-releases\]\s*\{[^}]*overflow-wrap:\s*(anywhere|break-word)/);
  });
});
