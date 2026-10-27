/**
 * The deploys screen's "Reached, not declared": the hosts an app's code
 * reached without declaring them, for a writer only, as the app's page says.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { noteReached } from "../src/apps/egress_report.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploys-egress-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(
    forge,
    { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" },
    { slot: fixtureSlot(forge) },
  );
  if (!b.ok) throw new Error("signup failed");
  bob = b.value;
  const r = await createRepo(forge, alice, { name: "notes", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  const made = createAppRecord(forge.db, { repoId: repo.id, slug: "notes", access: "public" });
  if (!made.ok) throw new Error(made.error);
});

afterAll(async () => {
  forge?.close?.();
  await rm(dir, { recursive: true, force: true });
});

const frame = async (who: User | null): Promise<string> => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who?.username ?? "guest", remoteAddress: "127.0.0.1", ...(who === null ? {} : { user: who }) },
    { terminal: headlessTerminal(200, 40), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, repo));
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
};

test("nothing is drawn while nothing was reached", async () => {
  expect(await frame(alice)).not.toContain("Reached, not declared");
});

test("a writer sees one row per reached host and the line to add them; a reader and a guest see none", async () => {
  noteReached(dir, repo.id, "api.example.com", 443);
  noteReached(dir, repo.id, "api.example.com", 443);
  noteReached(dir, repo.id, "db.example.com", 5432);
  const text = await frame(alice);
  expect(text).toContain("Reached, not declared");
  expect(text).toContain("api.example.com:443 · 2× · last seen just now");
  expect(text).toContain("db.example.com:5432 · 1× · last seen just now");
  expect(text).toContain('forge.json: ["db.example.com:5432","api.example.com"]');
  // reachedHosts lists the most recent first, so db (noted last) precedes api.
  for (const who of [bob, null]) {
    const seen = await frame(who);
    expect(seen).not.toContain("Reached, not declared");
    expect(seen).not.toContain("api.example.com");
  }
});

const REPORT = "They were let through while egress is only reported; once it is enforced they are refused.";
const ENFORCE = "They were let through while egress was only reported; they are refused now.";

test("it says whether the calls still work, by the forge's egress mode, in the page's words", async () => {
  noteReached(dir, repo.id, "api.example.com", 443);
  const setMode = (value: string): void => {
    forge.db.run("INSERT OR REPLACE INTO forge_setting (key, value, updated_by, updated_at) VALUES ('cells.egress', ?1, ?2, ?3)", [value, alice.id, new Date().toISOString()]);
  };
  setMode("report");
  const report = await frame(alice);
  expect(report).toContain(REPORT);
  expect(report).not.toContain(ENFORCE);
  setMode("enforce");
  const enforce = await frame(alice);
  expect(enforce).toContain(ENFORCE);
  expect(enforce).not.toContain(REPORT);
});
