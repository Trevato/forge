/** An agent's page under Settings › Crew speaks the home page's language (#9831): headings and sections, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let admin = "";
let member = "";

const person = async (username: string, adminIfFirst: boolean) => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.test`,
    adminIfFirst,
  });
  if (!made.ok) throw new Error(String(made.error));
  return made.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-agent-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const root = await person("alice", true);
  admin = `forge_session=${createSession(app.db, root.id).token}`;
  const bob = await person("bob", false);
  member = `forge_session=${createSession(app.db, bob.id).token}`;
  const made = await createAgent(app, root, {
    username: "scoutly",
    model: "claude-sonnet-5-5",
    brief: "Ships small things.",
    roles: ["builder"],
  });
  if (!made.ok) throw new Error(String(made.error));
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const fetchPage = (who: string) =>
  fetch(servers.url + "/settings/crew/scoutly", { headers: { cookie: who }, redirect: "manual" });

test("an agent's page: one h1, plain sections, both forms, no card", async () => {
  const res = await fetchPage(admin);
  expect(res.status).toBe(200);
  const html = await res.text();
  const page = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  expect(page.match(/<h1[ >]/g)?.length).toBe(1);
  expect(page).toContain("scoutly");
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  expect(page).toContain('action="/settings/crew/scoutly"');
  // the delete action is the confirm door, as before: it leads to the POST
  expect(page).toContain("to=%2Fsettings%2Fcrew%2Fscoutly%2Fdelete");
});

test("a non-admin still gets 404", async () => {
  expect((await fetchPage(member)).status).toBe(404);
});
