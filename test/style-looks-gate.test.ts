/** A stylesheet change is approved only beside the home page's phone and desktop looks at its head (#11831 item 5). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook, type Look } from "../src/core/looks.ts";
import { getPull, pullDir, pullStatus } from "../src/core/pulls.ts";
import { createUser } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve } from "../src/http/server.ts";
import { reviewWords } from "../src/actions/review_words.ts";
import { missingHomeLooks, touchesStylesheet } from "../src/looks/style_looks.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-style-looks-"));
  app = createApp({ dataDir, port: 0 });
});
afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("only a stylesheet source path counts", () => {
  expect(touchesStylesheet(["README.md", "src/web/style/components.ts"])).toBe(true);
  expect(touchesStylesheet(["src/web/pages/home.ts", "src/web/stylish.ts"])).toBe(false);
});

test("missing widths are those with no light, forge-taken home look at the head", () => {
  const look = (over: Partial<Look>): Look =>
    ({ page: "/", kind: "phone", theme: "light", error: null, attachedBy: null, commitOid: "h", ...over }) as Look;
  expect(missingHomeLooks([], "h")).toEqual(["phone", "desktop"]);
  expect(missingHomeLooks([look({}), look({ kind: "desktop" })], "h")).toEqual([]);
  expect(missingHomeLooks([look({}), look({ kind: "desktop", commitOid: "old" })], "h")).toEqual(["desktop"]);
  expect(missingHomeLooks([look({ error: "x" }), look({ kind: "desktop", page: "/a" })], "h")).toEqual(["phone", "desktop"]);
});

async function pullChanging(path: string, name: string) {
  const owner = await createUser(app.db, {
    origin: "seed", trusted: true, username: `own${name}`, email: `own${name}@forge.local`,
    password: "a-good-passphrase", adminIfFirst: true,
  });
  const author = await createUser(app.db, {
    origin: "seed", trusted: true, username: `au${name}`, email: `au${name}@forge.local`,
    password: "a-good-passphrase",
  });
  if (!owner.ok || !author.ok) throw new Error("users");
  promote(app.db, owner.value, author.value);
  const r = await createRepo(app, owner.value, { name, visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  await commitToBranch(app, owner.value, r.value, { message: "seed", files: [{ path: "README.md", content: "# g\n" }] });
  await commitToBranch(app, owner.value, r.value, { branch: "one", base: "main", message: "one", files: [{ path, content: "x\n" }] });
  const o = await openPull(app, owner.value, r.value, { title: "One", body: "", baseBranch: "main", headBranch: "one" });
  if (!o.ok) throw new Error(String(o.error));
  app.db.query("UPDATE issue SET author_id = ? WHERE id = ?").run(author.value.id, o.value.id);
  const pull = getPull(app.db, r.value.id, o.value.number)!;
  const a = insertApp(app.db, { repoId: r.value.id, slug: name, access: "public" });
  if (!a.ok) throw new Error(a.error);
  const head = (await pullStatus(await pullDir(app.db, app.reposRoot, r.value, pull), pull)).headOid;
  return { owner: owner.value, repo: r.value, pull, appId: a.value.id, head };
}

test("approving a stylesheet change waits for its home looks; any other change does not", async () => {
  const css = await pullChanging("src/web/style/x.ts", "css");
  const refused = await submitReview(app, css.owner, css.repo, css.pull, { state: "approved" });
  expect(refused.ok ? "ok" : refused.error).toBe("looks_required");
  // A comment and a request for changes are not an approval.
  expect((await submitReview(app, css.owner, css.repo, css.pull, { state: "changes_requested", body: "x" })).ok).toBe(true);
  for (const kind of ["phone", "desktop"] as const)
    recordLook(app.db, { appId: css.appId, env: previewEnv(css.pull.number), commitOid: css.head, path: "looks/x.png", takenAs: "nobody", kind });
  const done = await submitReview(app, css.owner, css.repo, css.pull, { state: "approved" });
  expect(done.ok).toBe(true);

  const plain = await pullChanging("notes.md", "plain");
  expect((await submitReview(app, plain.owner, plain.repo, plain.pull, { state: "approved" })).ok).toBe(true);
});

test("the API answers 422 looks_required and the MCP review tool says why", async () => {
  const css = await pullChanging("src/web/style/y.ts", "cssdoors");
  const servers = await serve(app);
  try {
    const token = createToken(app.db, css.owner.id, "t", "admin").token;
    const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const api = await fetch(
      `${servers.url}/api/v1/repos/${css.repo.ownerName}/${css.repo.name}/pulls/${css.pull.number}/review-states`,
      { method: "POST", headers, body: JSON.stringify({ state: "approved" }) },
    );
    expect(api.status).toBe(422);
    expect(((await api.json()) as { error: string }).error).toBe("looks_required");

    const mcp = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { ...headers, accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "review", arguments: { repo: `${css.repo.ownerName}/${css.repo.name}`, number: css.pull.number, verdict: "approve" } },
      }),
    });
    const body = (await mcp.json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain(reviewWords.looksRequired);
  } finally {
    servers.stop();
  }
});
