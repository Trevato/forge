/** /contribute speaks the home page's language (#9824): one heading, plain sections, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-contribute-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const main = (page: string): string => page.slice(page.indexOf("<main"), page.indexOf("</main>"));

async function contribute(): Promise<string> {
  const res = await fetch(servers.url + "/contribute");
  expect(res.status).toBe(200);
  return main(await res.text());
}

function plain(page: string): void {
  expect(page.match(/<h1[\s>]/g)?.length).toBe(1);
  expect(page).not.toContain('class="card');
  expect(page).not.toContain("card-body");
  expect(page).toContain('<ol id="propose">');
  expect(page).toContain("GET /api/v1/contribute");
}

test("signed out with no welcomed issue: the empty sentence and the steps, no card", async () => {
  const page = await contribute();
  plain(page);
  expect(page).toContain("No open issue carries");
});

test("signed out with a welcomed issue: its link and the steps, no card", async () => {
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const repo = await createRepo(app, u.value, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  const rid = repo.value.id;
  app.db.query("INSERT INTO label (id, repo_id, name) VALUES ('LBLW', ?1, 'help wanted')").run(rid);
  app.db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('ISSW', ?1, 1, 'issue', 'tidy the herbs', ?2)").run(rid, u.value.id);
  app.db.query("INSERT INTO issue_label (issue_id, label_id) VALUES ('ISSW', 'LBLW')").run();
  const page = await contribute();
  plain(page);
  expect(page).toContain('href="/alice/garden/issues/1"');
  expect(page).toContain("tidy the herbs");
  expect(page).not.toContain("No open issue carries");
});
