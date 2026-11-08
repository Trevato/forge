/** Settings › Crew speaks the home page's language (#9826): one heading, the readiness words, a plain list, the form; no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { components } from "../src/web/style/components.ts";
import { createApp } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let admin: User;
let cookie = "";
let other = "";
const person = async (username: string, adminIfFirst = false): Promise<User> => {
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
  dir = await mkdtemp(join(tmpdir(), "forge-crew-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  admin = await person("alice", true);
  promote(app.db, admin);
  cookie = `forge_session=${createSession(app.db, admin.id).token}`;
  const bob = await person("bob");
  other = `forge_session=${createSession(app.db, bob.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const crewMain = async (): Promise<string> => {
  const res = await fetch(`${servers.url}/settings/crew`, { headers: { cookie }, redirect: "manual" });
  expect(res.status).toBe(200);
  const page = await res.text();
  return page.slice(page.indexOf("<main"), page.indexOf("</main>"));
};
const speaksPlainly = (main: string): void => {
  expect(main.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(main).not.toContain('class="card');
  expect(main).not.toContain("card-body");
  expect(main).toMatch(/runner is up|cannot run|ready to run the crew|hosted inside/);
  expect(main).toContain('action="/settings/crew"');
  // The danger notice (no runner in this test) wears a class the stylesheet really styles.
  expect(main).toContain('class="toast" data-tone="danger" role="alert"');
  expect(components).toContain('.toast[data-tone="danger"]');
  expect(main).not.toContain('class="error');
};

test("with no agent: one heading, the readiness sentence, the empty sentence, the form", async () => {
  const main = await crewMain();
  speaksPlainly(main);
  expect(main).toContain("No agents yet");
});

test("with an agent: its link is on the page, still no card", async () => {
  const made = await createAgent(app, admin, { username: "bot", brief: "Be brief." });
  expect(made.ok).toBe(true);
  const main = await crewMain();
  speaksPlainly(main);
  expect(main).toContain('href="/settings/crew/bot"');
});

test("a non-admin still gets 404", async () => {
  const res = await fetch(`${servers.url}/settings/crew`, { headers: { cookie: other }, redirect: "manual" });
  expect(res.status).toBe(404);
});
