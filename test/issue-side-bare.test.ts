/** An issue's side cards speak the home page's language (#9816): headings
 * over rows, no boxed card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createLabel, setIssueLabels } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-side-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop?.();
  await rm(dataDir, { recursive: true, force: true });
});

test("the four side cards are headings over rows, with no boxed card", async () => {
  const a = await createUser(app.db, { origin: "seed", trusted: true,
    username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await createRepo(app, a.value, { name: "side", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const one = openIssue(app, a.value, repo, { title: "First" });
  const two = openIssue(app, a.value, repo, { title: "Second" });
  if (!one.ok || !two.ok) throw new Error("open");
  const label = createLabel(app.db, repo.id, "bug", "ff0000");
  if (!label.ok) throw new Error(label.error);
  setIssueLabels(app.db, two.value.id, [label.value.id]);
  const dep = addDependency(app.db, two.value, one.value, a.value.id);
  if (!dep.ok) throw new Error(String(dep.error));

  const cookie = (
    (
      await fetch(`${servers.url}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;
  const page = await (
    await fetch(`${servers.url}/alice/side/issues/${two.value.number}`, { headers: { cookie } })
  ).text();
  for (const h of ["Labels", "Assignee", "Teams", "Depends on"])
    expect(page).toContain(`<h2>${h}</h2>`);
  // The composer is another issue's work; every other .card must be bare.
  const boxed = [...page.matchAll(/class="([^"]*)"/g)]
    .map((m) => m[1]!.split(/\s+/))
    .filter((c) => c.includes("card") && !c.includes("bare") && !c.includes("comment-form"));
  expect(boxed).toEqual([]);
});
