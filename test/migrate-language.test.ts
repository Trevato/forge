/** /migrate and a migration's job page speak the home page's language (#9814): headings and rows, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { connectOrigin } from "../src/actions/origins.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { advance, createJob } from "../src/origins/jobs.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeState, serveFakeForge } from "./fake-origin.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let cookie = "";
let other = "";
let alice: User;
const person = async (username: string): Promise<User> => {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.test`,
    adminIfFirst: false,
  });
  if (!made.ok) throw new Error(String(made.error));
  promote(app.db, made.value);
  return made.value;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-migrate-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  alice = await person("alice");
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const bob = await person("bob");
  other = `forge_session=${createSession(app.db, bob.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));
const get = async (path: string, who = cookie): Promise<string> => {
  const res = await fetch(servers.url + path, { headers: { cookie: who }, redirect: "manual" });
  expect(res.status).toBe(200);
  return main(await res.text());
};
const noCard = (page: string): void => {
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  expect(page).toContain("<h2");
};

test("/migrate with no account: headings, the URL field and Migrate, no card", async () => {
  const page = await get("/migrate", other);
  noCard(page);
  expect(page).toContain("Your accounts");
  expect(page).toContain("Migrate");
  expect(page).toContain('name="url"');
});

test("/migrate with an account: one row for it under a heading, no card", async () => {
  const github = serveFakeForge(newFakeState("github", "octo", "t0ken-secret"));
  try {
    forgetProviders(dir);
    const connected = await connectOrigin(app, alice, { host: github.url, kind: "github", token: "t0ken-secret" });
    if (!connected.ok) throw new Error(JSON.stringify(connected.error));
    const page = await get("/migrate");
    noCard(page);
    expect(page).toContain('id="migrate-accounts"');
    expect(page).toContain("Disconnect");
    expect(page).not.toContain("t0ken-secret");
  } finally {
    github.stop();
  }
});

test("a job's page: stages are rows under one heading; running streams, failed shows its tone", async () => {
  const running = createJob("", "octo/<b>x", { kind: "migrate", actorId: alice.id });
  advance(running.id, { stage: "fetching", detail: "receiving 61%" });
  const live = await get(`/migrate/jobs/${running.id}`);
  noCard(live);
  expect(live).toContain("octo/&lt;b&gt;x");
  expect(live).toContain("data-stage-name");

  const failed = createJob("", "octo/broken", { kind: "migrate", actorId: alice.id });
  advance(failed.id, { stage: "failed", error: "boom" });
  const dead = await get(`/migrate/jobs/${failed.id}`);
  noCard(dead);
  expect(dead).toContain("boom");
  expect(dead).toContain("Try again");
});
