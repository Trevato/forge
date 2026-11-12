/**
 * An issue opened by a tell keeps its title out of its body: the body is
 * what follows the first line, as Open issue would file it. A title cut
 * short keeps the whole text in the body.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { tell } from "../src/actions/tell.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tell-body-"));
  app = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-tell-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error("repo failed");
  repo = made.value;
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the body does not repeat the title", async () => {
  const told = await tell(app, alice, repo, "Make it purple\n\nThe header only.");
  if (!told.ok) throw new Error(String(told.error));
  expect(told.value.issue.title).toBe("Make it purple");
  expect(told.value.issue.body).toBe("The header only.");
});

test("a title cut short keeps the whole text in the body", async () => {
  const long = `${"word ".repeat(30).trim()}\n\nMore.`;
  const told = await tell(app, alice, repo, long);
  if (!told.ok) throw new Error(String(told.error));
  expect(told.value.issue.title.endsWith("…")).toBe(true);
  expect(told.value.issue.body).toBe(long);
});
