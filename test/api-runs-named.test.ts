/**
 * The runs API names each run (#7353, `nameRuns`): `agent` is the username
 * behind an agent run and null for a check or deploy; `number` and `title`
 * are the pull or issue it is about, null when it is about none. A client
 * (`forge runs`) prints these instead of reading them out of the branch.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let http: ForgeHttp;
let token: string;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-runs-named-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
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
  token = createToken(app.db, alice.id, "t", "ro").token;
  const repo = ok(await createRepo(app, alice, { name: "shop", visibility: "public" }));
  const issue = ok(createIssue(app.db, { repoId: repo.id, authorId: alice.id, title: "Login fix" }));
  // Branches no parser would read the same way: the names come from rows.
  createRun(app.db, { repoId: repo.id, kind: "agent", issueId: issue.id, actorId: alice.id, branch: "feature/x" });
  createRun(app.db, { repoId: repo.id, kind: "check", issueId: issue.id, actorId: alice.id, env: "production" });
  createRun(app.db, { repoId: repo.id, kind: "deploy", env: "production", actorId: alice.id });
}, 60_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each run carries its agent, number and title", async () => {
  const res = await http.handle(
    new Request("http://forge.test/api/v1/repos/alice/shop/runs", {
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  expect(res.status).toBe(200);
  const { items } = (await res.json()) as { items: Record<string, unknown>[] };
  const by = (kind: string) => items.find((r) => r["kind"] === kind)!;
  expect(by("agent")).toMatchObject({ agent: "alice", number: 1, title: "Login fix" });
  // A check names its pull or issue but no agent: whoever triggered it is not one.
  expect(by("check")).toMatchObject({ agent: null, number: 1, title: "Login fix" });
  expect(by("deploy")).toMatchObject({ agent: null, number: null, title: null });
});
