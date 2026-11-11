/** The machines list joins the shell's j/k row traversal (#10357): one data-nav per machine, linking to its shell. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import type { Repo } from "../src/core/repos.ts";
import { machineRows } from "../src/web/pages/machines.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let servers: Servers;
const cookies: Record<string, string> = {};

async function person(name: string): Promise<string> {
  const made = await createUser(app.db, { username: name, email: `${name}@x.test`, password: "correct horse battery", origin: "seed", trusted: true });
  if (!made.ok) throw new Error(String(made.error));
  cookies[name] = `forge_session=${createSession(app.db, made.value.id).token}`;
  return made.value.id;
}

beforeAll(async () => {
  app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "keys-machines-")), port: 0 });
  const alice = await person("alice");
  await person("bob");
  const made = await createRepo(app.db, app.reposRoot, { ownerId: alice, name: "lab", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  servers = await serve(app);
});

afterAll(() => {
  servers.stop();
  app.close();
});

const get = (who: string) =>
  fetch(`${servers.url}/alice/lab/settings/machines`, { headers: { cookie: cookies[who]! } });

test("each machine row is one data-nav link to its own shell, with no nested link", async () => {
  const page = await (await get("alice")).text();
  const at = page.indexOf('id="machines"');
  const text = page.slice(at, page.indexOf("</ul>", at));
  const rows = [...text.matchAll(/<a href="([^"]+)"\s+class="row"[^>]*data-nav tabindex="-1"/g)].map((m) => m[1]);
  expect(rows.length).toBeGreaterThan(0);
  expect(text.match(/data-nav/g)!.length).toBe(rows.length);
  expect(rows).toContain("/alice/lab/machines/standard/shell");
  // The row is the only link; no second button says the same thing.
  const inner = text.match(/<a href="[^"]+"\s+class="row"[^>]*data-nav[\s\S]*?<\/a>/g)!;
  for (const a of inner) expect(a.match(/<a /g)!.length).toBe(1);
  expect(text).not.toContain("Open shell");
});

test("a list of no machines draws no data-nav", () => {
  const repo = { ownerName: "alice", name: "lab" } as Repo;
  expect(String(machineRows(repo, []))).not.toContain("data-nav");
});
