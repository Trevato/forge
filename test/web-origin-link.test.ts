/**
 * "view on origin" on a change's head and on a comment card is drawn with
 * §5's muted small text and the bar's icon gap, never the retired
 * `.origin-link` (#4293). Each variant has its own assertion because each is
 * rendered by its own module.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { commentCard } from "../src/web/comments.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const URL_AT_ORIGIN = "https://origin.example/octo/widgets/pulls/3?a=1&b=2";
const anchor =
  /<a\s+class="bar muted small"\s+href="https:\/\/origin\.example\/octo\/widgets\/pulls\/3\?a=1&amp;b=2"\s+rel="noreferrer noopener"/;

let dataDir: string;
let app: App;
let servers: Servers;
let page = "";

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: unknown },
): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-origin-link-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const alice = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    }),
  );
  const repo = ok(await createRepo(app, alice, { name: "sq", visibility: "public" }));
  ok(
    await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# sq\n" }],
    }),
  );
  ok(
    await commitToBranch(app, alice, repo, {
      branch: "topic",
      base: "main",
      message: "Topic",
      files: [{ path: "README.md", content: "# sq\nmore\n" }],
    }),
  );
  const pull = ok(
    await openPull(app, alice, repo, {
      title: "Topic",
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    }),
  );
  app.db
    .query("UPDATE issue SET origin_html_url = ? WHERE id = ?")
    .run(URL_AT_ORIGIN, pull.id);
  page = await (
    await fetch(`${servers.url}/alice/sq/pulls/${pull.number}`)
  ).text();
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("an imported change's head links to the origin in §5's muted text", () => {
  expect(page).toContain("view on origin");
  expect(page).not.toContain("origin-link");
  expect(page).toMatch(anchor);
});

test("an imported comment card links to the origin in §5's muted text", () => {
  const card = commentCard({
    id: "c1",
    author: "alice",
    at: "2026-01-01T00:00:00.000Z",
    body: "hello",
    verb: "commented",
    originUrl: URL_AT_ORIGIN,
  }).toString();
  expect(card).toContain("view on origin");
  expect(card).not.toContain("origin-link");
  expect(card).toMatch(anchor);
});
